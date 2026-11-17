/**
 * Minimal Agora REST + SSE client for the chat bridge (`ompx agora serve`).
 * The token is held in memory only: `loadAgoraEnv` never touches `process.env`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { readSseEvents } from "@oh-my-pi/pi-utils/stream";

export interface AgoraEnv {
	url: string;
	token: string;
	workspace?: string;
}
export interface AgoraActor {
	id: string;
	username: string;
	kind: "human" | "agent";
}
export interface AgoraAttachment {
	id: string;
	url: string;
	filename: string;
	mime: string;
	kind: "image" | "video" | "file";
	size: number;
}
export interface AgoraChatMessage {
	id: string;
	conversation_id: string;
	author: AgoraActor | null;
	body: string;
	reply_to_id: string | null;
	context: { text: string } | null;
	attachments: AgoraAttachment[];
	created_at: string | null;
	turn_id?: string | null;
}
export interface AgoraEvent {
	id: number;
	type: string;
	data: Record<string, unknown>;
}
export type AgoraStepKind = "tool" | "thinking" | "plan" | "diff" | "note" | "question";
export type AgoraStepStatus = "running" | "done" | "failed" | "waiting" | "answered" | "cancelled";
export interface AgoraStep {
	step_id: string;
	seq: number;
	kind: AgoraStepKind;
	title: string;
	status: AgoraStepStatus;
	detail?: Record<string, unknown>;
}

const REST_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 120_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Agora pings every 15 s; this long without any byte means the connection is dead. */
const STREAM_IDLE_MS = 60_000;

export class AgoraApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "AgoraApiError";
	}
}

/** Parses `KEY=VALUE` lines (optional `export`, quotes stripped, `#` comments) from a 0600 env file. */
export async function loadAgoraEnv(file: string): Promise<AgoraEnv> {
	const resolved = file === "~" || file.startsWith("~/") ? path.join(os.homedir(), file.slice(1)) : file;
	const stat = await fs.stat(resolved);
	if ((stat.mode & 0o077) !== 0) {
		throw new Error(
			`Agora env file ${resolved} must not be readable by group or others (mode ${(stat.mode & 0o777).toString(8)}); run chmod 600`,
		);
	}
	const values = new Map<string, string>();
	for (const raw of (await Bun.file(resolved).text()).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2].trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
			value = value.slice(1, -1);
		}
		values.set(match[1], value);
	}
	const url = values.get("AGORA_URL");
	const token = values.get("AGORA_TOKEN");
	if (!url || !token) throw new Error(`Agora env file ${resolved} must define AGORA_URL and AGORA_TOKEN`);
	const workspace = values.get("AGORA_WORKSPACE");
	return { url, token, ...(workspace ? { workspace } : {}) };
}

function actorOf(value: unknown): AgoraActor {
	const actor = value as AgoraActor;
	return { id: actor.id, username: actor.username, kind: actor.kind };
}

export class AgoraClient {
	readonly #base: URL;
	readonly #token: string;
	readonly #workspace: string | undefined;
	readonly #fetch: typeof fetch;

	constructor(env: AgoraEnv, fetchImpl: typeof fetch = fetch) {
		this.#base = new URL(env.url);
		this.#token = env.token;
		this.#workspace = env.workspace;
		this.#fetch = fetchImpl;
	}

	#headers(extra?: Record<string, string>): Record<string, string> {
		const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}`, ...extra };
		if (this.#workspace) headers["X-Agora-Workspace"] = this.#workspace;
		return headers;
	}

	#url(p: string): string {
		return new URL(`/api/v1${p}`, this.#base).toString();
	}

	async #fail(res: Response): Promise<never> {
		let code = "http_error";
		let message = `Agora answered ${res.status}`;
		try {
			const body = (await res.json()) as { error?: { code?: string; message?: string } };
			if (body.error?.code) code = body.error.code;
			if (body.error?.message) message = body.error.message;
		} catch {
			// non-JSON error body: keep the status-based message
		}
		throw new AgoraApiError(res.status, code, message);
	}

	async #send(method: string, p: string, body?: unknown, timeoutMs = REST_TIMEOUT_MS): Promise<Response> {
		const init: RequestInit = {
			method,
			headers: this.#headers(body === undefined ? undefined : { "Content-Type": "application/json" }),
			signal: AbortSignal.timeout(timeoutMs),
		};
		if (body !== undefined) init.body = JSON.stringify(body);
		const res = await this.#fetch(this.#url(p), init);
		if (!res.ok) await this.#fail(res);
		return res;
	}

	/** Like `#send` but an HTTP 404 (endpoint missing on an older Agora) yields `null`. */
	async #sendOptional(method: string, p: string, body?: unknown): Promise<Response | null> {
		try {
			return await this.#send(method, p, body);
		} catch (error) {
			if (error instanceof AgoraApiError && error.status === 404) return null;
			throw error;
		}
	}

	async me(): Promise<AgoraActor> {
		const res = await this.#send("GET", "/me");
		return actorOf(((await res.json()) as { actor: unknown }).actor);
	}

	async postMessage(
		conversation: string,
		msg: { body: string; attachment_ids?: string[]; reply_to?: string; turn_id?: string },
	): Promise<{ id: string }> {
		const res = await this.#send("POST", `/chat/conversations/${encodeURIComponent(conversation)}/messages`, msg);
		return { id: ((await res.json()) as { message: { id: string } }).message.id };
	}

	async setStatus(
		conversation: string,
		state: "working" | "idle" | "failed",
		note?: string,
		tool?: string,
	): Promise<void> {
		await this.#send("POST", `/chat/conversations/${encodeURIComponent(conversation)}/status`, {
			state,
			note,
			tool,
		});
	}

	async partial(conversation: string, text: string): Promise<boolean> {
		const res = await this.#sendOptional("POST", `/chat/conversations/${encodeURIComponent(conversation)}/partial`, {
			text,
		});
		return res !== null;
	}

	async putActivity(conversation: string, turnId: string, steps: AgoraStep[]): Promise<boolean> {
		const res = await this.#sendOptional("PUT", `/chat/conversations/${encodeURIComponent(conversation)}/activity`, {
			turn_id: turnId,
			steps,
		});
		return res !== null;
	}

	async createConversation(input: {
		title?: string;
		participants: string[];
		message?: { body: string };
	}): Promise<{ id: string }> {
		const res = await this.#send("POST", "/chat/conversations", input);
		return { id: ((await res.json()) as { conversation: { id: string } }).conversation.id };
	}

	async branch(
		conversation: string,
		input: { from_message?: string; title?: string; message?: { body: string } },
	): Promise<{ id: string } | null> {
		const res = await this.#sendOptional(
			"POST",
			`/chat/conversations/${encodeURIComponent(conversation)}/branch`,
			input,
		);
		if (!res) return null;
		return { id: ((await res.json()) as { conversation: { id: string } }).conversation.id };
	}

	async patchConversation(
		conversation: string,
		patch: { branch_label?: string | null; title?: string },
	): Promise<void> {
		await this.#send("PATCH", `/chat/conversations/${encodeURIComponent(conversation)}`, patch);
	}

	async upload(file: string): Promise<AgoraAttachment> {
		const form = new FormData();
		form.append("file", Bun.file(file), path.basename(file));
		const res = await this.#fetch(this.#url("/attachments"), {
			method: "POST",
			headers: this.#headers(),
			body: form,
			signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
		});
		if (!res.ok) await this.#fail(res);
		const a = ((await res.json()) as { attachment: AgoraAttachment }).attachment;
		return { id: a.id, url: a.url, filename: a.filename, mime: a.mime, kind: a.kind, size: a.size };
	}

	/** Same-origin only: the bearer token is never sent to another host. Throws when the file exceeds `maxBytes`. */
	async download(url: string, dest: string, maxBytes: number): Promise<void> {
		const target = new URL(url, this.#base);
		if (target.origin !== this.#base.origin) throw new Error(`refusing to download from ${target.origin}`);
		const res = await this.#fetch(target.toString(), {
			headers: this.#headers(),
			signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
		});
		if (!res.ok) await this.#fail(res);
		const tooBig = () => new Error(`file is larger than ${maxBytes} bytes`);
		const declared = Number(res.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
		if (!res.body) throw new Error("Agora sent an empty download");
		await fs.mkdir(path.dirname(dest), { recursive: true });
		const sink = Bun.file(dest).writer();
		let total = 0;
		try {
			for await (const chunk of res.body) {
				total += chunk.byteLength;
				if (total > maxBytes) throw tooBig();
				sink.write(chunk);
			}
			await sink.end();
		} catch (error) {
			try {
				await sink.end();
			} catch {
				// already closed; the partial file is removed below
			}
			await fs.rm(dest, { force: true });
			throw error;
		}
	}

	/**
	 * Follows the agent's own event stream, reconnecting with backoff (1 s .. 60 s) and resuming from the last
	 * event id seen. Ends quietly when `signal` aborts; a 401/403 is permanent and throws.
	 */
	async *stream(since: number | null, types: string[], signal: AbortSignal): AsyncGenerator<AgoraEvent> {
		let last = since;
		let delay = BACKOFF_MIN_MS;
		while (!signal.aborted) {
			const query = new URLSearchParams({ scope: "mine", types: types.join(",") });
			if (last !== null) query.set("since", String(last));
			const idle = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const arm = () => {
				clearTimeout(timer);
				timer = setTimeout(() => idle.abort(), STREAM_IDLE_MS);
			};
			try {
				arm();
				const res = await this.#fetch(this.#url(`/events/stream?${query}`), {
					headers: this.#headers({ Accept: "text/event-stream" }),
					signal: AbortSignal.any([signal, idle.signal]),
				});
				if (!res.ok) await this.#fail(res);
				if (!res.body) throw new Error("Agora event stream has no body");
				const body = res.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							arm();
							controller.enqueue(chunk);
						},
					}),
				);
				for await (const sse of readSseEvents(body, AbortSignal.any([signal, idle.signal]))) {
					if (!sse.data) continue;
					const data = JSON.parse(sse.data) as Record<string, unknown>;
					const id = Number(sse.id ?? data.id);
					if (!Number.isFinite(id)) continue;
					last = id;
					delay = BACKOFF_MIN_MS;
					yield { id, type: sse.event ?? String(data.type ?? ""), data };
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof AgoraApiError && (error.status === 401 || error.status === 403)) throw error;
				logger.warn("Agora event stream dropped", {
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				clearTimeout(timer);
			}
			if (signal.aborted) return;
			await new Promise<void>(resolve => {
				const wait = setTimeout(done, delay);
				function done() {
					clearTimeout(wait);
					signal.removeEventListener("abort", done);
					resolve();
				}
				signal.addEventListener("abort", done, { once: true });
			});
			delay = Math.min(delay * 2, BACKOFF_MAX_MS);
		}
	}
}
