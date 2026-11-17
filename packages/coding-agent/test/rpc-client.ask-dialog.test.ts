import { describe, expect, test } from "bun:test";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcExtensionUIRequest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

function fakeAgent() {
	const frames: Array<Record<string, unknown>> = [];
	const exited = Promise.withResolvers<number>();
	let emit: (frame: unknown) => void = () => {};
	const proc: RpcAgentProcess = {
		stdin: {
			write: (line: string | Uint8Array) => {
				const frame = JSON.parse(String(line)) as Record<string, unknown>;
				frames.push(frame);
				if (frame.type === "set_ask_dialog") {
					emit({
						type: "response",
						id: frame.id,
						command: "set_ask_dialog",
						success: true,
						data: { enabled: frame.enabled },
					});
				}
			},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				const enc = new TextEncoder();
				emit = frame => controller.enqueue(enc.encode(`${JSON.stringify(frame)}\n`));
				emit({ type: "ready" });
			},
		}),
		peekStderr: () => "",
		kill: () => exited.resolve(0),
		exited: exited.promise,
	};
	return { proc, frames, emit: (frame: unknown) => emit(frame) };
}

describe("RpcClient ask dialog", () => {
	test("setAskDialog sends set_ask_dialog and returns the agent's state", async () => {
		const agent = fakeAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();
		expect(await client.setAskDialog(true)).toBe(true);
		expect(agent.frames[0]).toMatchObject({ type: "set_ask_dialog", enabled: true });
	});

	test("onExtensionUiRequest delivers requests until unsubscribed; respondExtensionUi writes the response frame", async () => {
		const agent = fakeAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();
		const seen: RpcExtensionUIRequest[] = [];
		const first = Promise.withResolvers<void>();
		const last = Promise.withResolvers<void>();
		const unsubscribe = client.onExtensionUiRequest(req => {
			seen.push(req);
			if (req.id === "r1") first.resolve();
		});
		client.onExtensionUiRequest(req => {
			if (req.id === "r2") last.resolve();
		});
		agent.emit({ type: "extension_ui_request", id: "r1", method: "confirm", title: "Sure?", message: "" });
		await first.promise;
		expect(seen.map(r => r.id)).toEqual(["r1"]);

		client.respondExtensionUi({ type: "extension_ui_response", id: "r1", confirmed: true });
		expect(agent.frames.at(-1)).toEqual({ type: "extension_ui_response", id: "r1", confirmed: true });

		unsubscribe();
		agent.emit({ type: "extension_ui_request", id: "r2", method: "confirm", title: "Again?", message: "" });
		await last.promise;
		expect(seen.length).toBe(1);
	});

	test("respondExtensionUi throws when the client is not started", () => {
		using client = new RpcClient({ spawn: () => fakeAgent().proc });
		expect(() => client.respondExtensionUi({ type: "extension_ui_response", id: "r1", cancelled: true })).toThrow(
			"Client not started",
		);
	});
});
