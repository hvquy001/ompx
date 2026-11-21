/**
 * Claude Code auto mode asks the API for server-side classifier review with a
 * `safeguards` body field paired with a `dangerous-tool-use-*` beta, and reads
 * the verdicts from `safeguard_results` on the final `message_delta`. A gateway
 * that drops either half makes Claude Code fall back to billed classifier calls.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const SAFEGUARDS = [{ type: "dangerous_tool_use", classifier_context: { v: 1, permission_mode: "auto" } }];
const SAFEGUARD_RESULTS = [
	{
		type: "dangerous_tool_use",
		status: {
			type: "available",
			tool_uses: { toolu_01: { type: "evaluated", outcome: "flagged", explanation: "[Data Exfiltration]" } },
		},
	},
];

function anthropicModel(baseUrl: string): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

const UPSTREAM_EVENTS: Array<Record<string, unknown>> = [
	{
		type: "message_start",
		message: {
			id: "msg_up",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	},
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "toolu_01", name: "Bash", input: {} },
	},
	{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "tool_use", stop_sequence: null, safeguard_results: SAFEGUARD_RESULTS },
		usage: { output_tokens: 5 },
	},
	{ type: "message_stop" },
];

function upstreamSse(): string {
	return UPSTREAM_EVENTS.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic provider safeguards", () => {
	async function send(baseUrl: string, callerBeta?: string, apiKey = "sk-ant-test") {
		let beta = "";
		let body: Record<string, unknown> = {};
		const fetchImpl: FetchImpl = async (input, init) => {
			// The OAuth billing wrapper hands over a prepared Request; plain requests use (url, init).
			const request = input instanceof Request ? input : new Request(String(input), init as RequestInit);
			expect(request.url).toStartWith(baseUrl);
			beta = request.headers.get("anthropic-beta") ?? "";
			body = (await request.json()) as Record<string, unknown>;
			return new Response(upstreamSse(), { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const stream = streamAnthropic(
			anthropicModel(baseUrl),
			{ messages: [{ role: "user", content: "list files", timestamp: 0 }] },
			{
				apiKey,
				fetch: fetchImpl,
				safeguards: SAFEGUARDS,
				...(callerBeta ? { headers: { "anthropic-beta": callerBeta } } : {}),
			},
		);
		for await (const _ of stream) {
			// drain
		}
		return { beta: beta.split(","), body, message: await stream.result() };
	}

	it("sends safeguards with the dangerous-tool-use beta and parses safeguard_results", async () => {
		const { beta, body, message } = await send("https://api.anthropic.com");
		expect(body.safeguards).toEqual(SAFEGUARDS);
		expect(beta).toContain("dangerous-tool-use-2026-09-03");
		expect(message.safeguardResults).toEqual(SAFEGUARD_RESULTS);
	});

	it("adds the beta on Claude subscription (OAuth) requests too", async () => {
		const { beta, body } = await send("https://api.anthropic.com", undefined, "sk-ant-oat01-test");
		expect(beta).toContain("oauth-2025-04-20");
		expect(beta).toContain("dangerous-tool-use-2026-09-03");
		expect(body.safeguards).toEqual(SAFEGUARDS);
	});

	it("keeps the caller's dated auto-mode betas instead of substituting its own", async () => {
		const { beta } = await send(
			"https://api.anthropic.com",
			"dangerous-tool-use-2027-01-01,auto-mode-classifier-2026-07-16",
		);
		expect(beta).toContain("dangerous-tool-use-2027-01-01");
		expect(beta).toContain("auto-mode-classifier-2026-07-16");
		expect(beta).not.toContain("dangerous-tool-use-2026-09-03");
	});

	it("keeps safeguards and their beta off endpoints that would reject them", async () => {
		const { beta, body, message } = await send("https://anthropic-compatible.example.com");
		expect(message.stopReason).toBe("toolUse");
		expect(body.messages).toBeDefined();
		expect(body.safeguards).toBeUndefined();
		expect(beta.some(value => value.startsWith("dangerous-tool-use-"))).toBe(false);
	});
});

describe("auth-gateway relays Claude Code auto-mode safeguards", () => {
	async function callGateway(stream: boolean) {
		let params: Record<string, unknown> | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((request: unknown) => {
			params = request as Record<string, unknown>;
			const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
			const events = {
				async *[Symbol.asyncIterator]() {
					for (const event of UPSTREAM_EVENTS) yield event;
				},
			};
			return { withResponse: async () => ({ data: events, response, request_id: "req_mock" }) } as never;
		});

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-safeguards-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.keys.setRuntime("anthropic", "sk-ant-test");
		const model = anthropicModel("https://api.anthropic.com");
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gw-test-token-9f3a"],
			storage,
			resolveModel: () => model,
			version: "test",
		});
		try {
			const response = await fetch(`${handle.url}/v1/messages`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer gw-test-token-9f3a",
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "dangerous-tool-use-2026-09-03",
				},
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					max_tokens: 256,
					stream,
					safeguards: SAFEGUARDS,
					messages: [{ role: "user", content: "list files" }],
				}),
			});
			const text = await response.text();
			expect(response.status, text).toBe(200);
			return { params, text };
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	it("forwards safeguards upstream and returns safeguard_results on the final message_delta", async () => {
		const { params, text } = await callGateway(true);
		expect(params?.safeguards).toEqual(SAFEGUARDS);
		const delta = text
			.split("\n")
			.filter(line => line.startsWith("data: "))
			.map(line => JSON.parse(line.slice(6)) as { type: string; delta?: Record<string, unknown> })
			.find(event => event.type === "message_delta");
		expect(delta?.delta?.safeguard_results).toEqual(SAFEGUARD_RESULTS);
		expect(text).toContain('"id":"toolu_01"');
	});

	it("returns safeguard_results on the non-streaming message", async () => {
		const { text } = await callGateway(false);
		expect((JSON.parse(text) as Record<string, unknown>).safeguard_results).toEqual(SAFEGUARD_RESULTS);
	});
});
