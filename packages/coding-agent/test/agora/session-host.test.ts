import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcAgentProcess } from "../../src/modes/rpc/rpc-client";
import type { AgoraClient, AgoraStep } from "../../src/agora/client";
import { type HostTimers, SessionHost } from "../../src/agora/session-host";

interface Timer {
	handle: number;
	at: number;
	fn: () => void;
	every?: number;
}

/** Manual clock + timers: `advance(ms)` runs due callbacks in order. */
function fakeTime() {
	let nowMs = 1_000_000;
	let next = 1;
	let timers: Timer[] = [];
	const timersApi: HostTimers = {
		setTimeout: (fn, ms) => {
			const t = { handle: next++, at: nowMs + ms, fn };
			timers.push(t);
			return t.handle;
		},
		setInterval: (fn, ms) => {
			const t = { handle: next++, at: nowMs + ms, fn, every: ms };
			timers.push(t);
			return t.handle;
		},
		clearTimeout: handle => {
			timers = timers.filter(t => t.handle !== handle);
		},
		clearInterval: handle => {
			timers = timers.filter(t => t.handle !== handle);
		},
	};
	return {
		now: () => nowMs,
		timers: timersApi,
		advance(ms: number) {
			const end = nowMs + ms;
			for (;;) {
				const due = timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				nowMs = due.at;
				if (due.every) due.at += due.every;
				else timers = timers.filter(t => t !== due);
				due.fn();
			}
			nowMs = end;
		},
	};
}

function assistantEntry(id: string, text: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "",
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

async function until(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(2);
	expect(cond()).toBe(true);
}

function setup(
	over: { posted?: Set<string>; failPartial?: boolean; cwd?: string; envFile?: string; activity?: boolean } = {},
) {
	const time = fakeTime();
	const posts: Array<{ body: string; turn_id?: string; attachment_ids?: string[] }> = [];
	const frames: Array<Record<string, unknown>> = [];
	const uploads: string[] = [];
	const statuses: Array<{ state: string; note?: string; tool?: string }> = [];
	const partials: string[] = [];
	const activity: Array<{ turnId: string; steps: AgoraStep[] }> = [];
	const entries: unknown[] = [];
	const posted = over.posted ?? new Set<string>();
	let msgSeq = 0;
	const client = {
		postMessage: async (_c: string, msg: { body: string; turn_id?: string; attachment_ids?: string[] }) => {
			posts.push(msg);
			return { id: `m${++msgSeq}` };
		},
		setStatus: async (_c: string, state: string, note?: string, tool?: string) => {
			statuses.push({ state, note, tool });
		},
		partial: async (_c: string, text: string) => {
			partials.push(text);
			return true;
		},
		putActivity: async (_c: string, turnId: string, steps: AgoraStep[]) => {
			activity.push({ turnId, steps: structuredClone(steps) });
			return over.activity ?? true;
		},
		upload: async (file: string) => {
			uploads.push(file);
			return {
				id: `a${uploads.length}`,
				url: "",
				filename: path.basename(file),
				mime: "text/plain",
				kind: "file",
				size: 1,
			};
		},
	} as unknown as AgoraClient;

	const exited = Promise.withResolvers<number>();
	let emit: (frame: unknown) => void = () => {};
	const reply = (cmd: { id: string; type: string; since?: string }) => {
		let data: unknown = {};
		if (cmd.type === "get_state") data = { sessionFile: "/tmp/s.jsonl", sessionId: "s" };
		if (cmd.type === "get_entries") {
			const idx = cmd.since ? entries.findIndex(e => (e as { id: string }).id === cmd.since) : -1;
			data = { entries: entries.slice(idx + 1), leafId: null };
		}
		emit({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
	};
	const proc: RpcAgentProcess = {
		stdin: {
			write: (line: string | Uint8Array) => {
				const frame = JSON.parse(String(line)) as Record<string, unknown> & { id: string; type: string };
				frames.push(frame);
				if (frame.type !== "extension_ui_response" && frame.type !== "host_tool_result") reply(frame);
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
	let idled = 0;
	const host = new SessionHost({
		conversationId: "c1",
		cwd: over.cwd ?? "/tmp",
		sessionDir: "/tmp/sd",
		inboxDir: over.cwd ? path.join(over.cwd, "inbox") : undefined,
		envFile: over.envFile,
		client,
		store: {
			postedHas: (_c, entryId) => posted.has(entryId),
			postedAdd: (_c, entryId) => void posted.add(entryId),
		},
		spawn: () => proc,
		idleMs: 30 * 60_000,
		onIdle: () => void idled++,
		now: time.now,
		timers: time.timers,
	});
	return {
		host,
		time,
		posts,
		statuses,
		partials,
		activity,
		frames,
		uploads,
		entries,
		posted,
		emit: (frame: unknown) => emit(frame),
		crash: () => exited.resolve(1),
		idled: () => idled,
	};
}

const textDelta = (delta: string) => ({
	type: "message_update",
	message: { role: "assistant", content: [] },
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: {} },
});

describe("SessionHost", () => {
	it("posts the final assistant text once, with the run's turn_id", async () => {
		const t = setup();
		await t.host.send({ text: "hi" });
		expect(t.host.busy).toBe(true);
		expect(t.host.sessionFile).toBe("/tmp/s.jsonl");
		t.entries.push(assistantEntry("e1", "hello there"));
		t.emit({ type: "agent_start" });
		t.emit({ type: "agent_end", messages: [] });
		t.emit({ type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: true });
		await until(() => t.posts.length === 1 && t.statuses.at(-1)?.state === "idle");
		expect(t.posts[0].body).toBe("hello there");
		expect(typeof t.posts[0].turn_id).toBe("string");
		expect(t.posted.has("e1")).toBe(true);
		expect(t.host.busy).toBe(false);
	});

	it("posts a second message for a later agent_end after sessionSettled:false", async () => {
		const t = setup();
		await t.host.send({ text: "run a job" });
		t.entries.push(assistantEntry("e1", "started the job"));
		t.emit({ type: "agent_start" });
		t.emit({ type: "agent_end", messages: [] });
		t.emit({ type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: false });
		await until(() => t.posts.length === 1);
		expect(t.host.busy).toBe(true);
		const first = t.posts[0].turn_id;

		t.entries.push(assistantEntry("e2", "job finished"));
		t.emit({ type: "agent_start" });
		t.emit({ type: "agent_end", messages: [] });
		t.emit({ type: "session_settled" });
		await until(() => t.posts.length === 2 && t.statuses.at(-1)?.state === "idle");
		expect(t.posts[1].body).toBe("job finished");
		expect(t.posts[1].turn_id).not.toBe(first);
	});

	it("posts nothing for a repeated agent_end with the same final entry", async () => {
		const t = setup();
		await t.host.send({ text: "hi" });
		t.entries.push(assistantEntry("e1", "once"));
		t.emit({ type: "agent_end", messages: [] });
		await until(() => t.posts.length === 1);
		t.emit({ type: "agent_end", messages: [] });
		t.emit({ type: "session_settled" });
		await until(() => t.statuses.at(-1)?.state === "idle");
		expect(t.posts.length).toBe(1);
	});

	it("skips an entry the store already recorded as posted", async () => {
		const t = setup({ posted: new Set(["e1"]) });
		await t.host.send({ text: "hi" });
		t.entries.push(assistantEntry("e1", "already out"));
		t.emit({ type: "agent_end", messages: [] });
		t.emit({ type: "session_settled" });
		await until(() => t.statuses.at(-1)?.state === "idle");
		expect(t.posts.length).toBe(0);
	});

	it("splits a 45 000-char reply into 3 messages at paragraph boundaries", async () => {
		const t = setup();
		await t.host.send({ text: "long" });
		const paragraphs = Array.from({ length: 9 }, (_, i) => String(i).repeat(5000));
		const text = paragraphs.join("\n\n");
		t.entries.push(assistantEntry("e1", text));
		t.emit({ type: "agent_end", messages: [] });
		await until(() => t.posts.length === 3);
		expect(t.posts.every(p => p.body.length <= 19_000)).toBe(true);
		expect(t.posts.map(p => p.body).join("\n\n")).toBe(text);
		expect(new Set(t.posts.map(p => p.turn_id)).size).toBe(1);
	});

	it("heartbeats working every 60 s without tool events, then idles on settle", async () => {
		const t = setup();
		await t.host.send({ text: "think" });
		const before = t.statuses.filter(s => s.state === "working").length;
		t.time.advance(150_000);
		const working = t.statuses.filter(s => s.state === "working").length - before;
		expect(working).toBeGreaterThanOrEqual(2);
		t.emit({ type: "session_settled" });
		await until(() => t.statuses.at(-1)?.state === "idle");
		const afterIdle = t.statuses.length;
		t.time.advance(120_000);
		expect(t.statuses.length).toBe(afterIdle);
		t.time.advance(30 * 60_000);
		expect(t.idled()).toBe(1);
	});

	it("posts failed when the child exits while busy", async () => {
		const t = setup();
		await t.host.send({ text: "crash" });
		t.crash();
		await until(() => t.statuses.at(-1)?.state === "failed");
		expect(t.statuses.at(-1)?.note).toContain("exited");
		expect(t.host.busy).toBe(false);
	});

	it("puts a running then a done tool step under the reply's turn_id", async () => {
		const t = setup();
		await t.host.send({ text: "list" });
		t.emit({ type: "agent_start" });
		t.emit({ type: "tool_execution_start", toolCallId: "call1", toolName: "bash", args: { command: "ls" } });
		await t.host.abort(); // response frames follow earlier event frames on the same stream
		t.time.advance(500);
		await until(() => t.activity.length === 1);
		expect(t.activity[0].steps[0]).toMatchObject({
			step_id: "call1",
			kind: "tool",
			status: "running",
			detail: { tool: "bash" },
		});
		t.emit({
			type: "tool_execution_end",
			toolCallId: "call1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "a.txt" }] },
		});
		t.entries.push(assistantEntry("e1", "done"));
		t.emit({ type: "agent_end", messages: [] });
		await until(() => t.posts.length === 1);
		expect(t.activity.length).toBe(2);
		expect(t.activity[1].steps[0]).toMatchObject({
			step_id: "call1",
			status: "done",
			detail: { tool: "bash", output: "a.txt" },
		});
		expect(t.activity[0].turnId).toEqual(t.posts[0].turn_id as string);
		expect(t.activity[1].turnId).toEqual(t.posts[0].turn_id as string);
	});

	it("throttles partial text to one call per second and flushes once more at agent_end", async () => {
		const t = setup();
		await t.host.send({ text: "stream" });
		t.emit({ type: "agent_start" });
		t.emit(textDelta("a".repeat(1500)));
		await until(() => t.partials.length === 1);
		t.emit(textDelta("b".repeat(1500)));
		t.emit(textDelta("c"));
		await t.host.abort();
		expect(t.partials.length).toBe(1);
		t.time.advance(1000);
		expect(t.partials.length).toBe(2);
		expect(t.partials[1].length).toBe(2000);
		expect(t.partials[1].endsWith("bc")).toBe(true);
		t.emit(textDelta("d"));
		await t.host.abort();
		t.entries.push(assistantEntry("e1", "abcd"));
		t.emit({ type: "agent_end", messages: [] });
		await until(() => t.partials.length === 3);
		expect(t.partials[2].endsWith("cd")).toBe(true);
	});

	const dirs: string[] = [];
	afterAll(async () => {
		await Promise.all(dirs.map(d => fs.rm(d, { recursive: true, force: true })));
	});
	async function workspace() {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agora-attach-")));
		dirs.push(root);
		const cwd = path.join(root, "work");
		await fs.mkdir(cwd);
		await Bun.write(path.join(cwd, "out.log"), "hello");
		const envFile = path.join(root, "env");
		await Bun.write(envFile, "AGORA_TOKEN=secret");
		await fs.symlink(root, path.join(cwd, "up"));
		return { root, cwd, envFile };
	}
	const toolCall = (t: ReturnType<typeof setup>, callId: string, args: Record<string, unknown>) =>
		t.emit({ type: "host_tool_call", id: callId, toolCallId: callId, toolName: "agora_attach", arguments: args });
	const toolResult = async (t: ReturnType<typeof setup>, callId: string) => {
		await until(() => t.frames.some(f => f.type === "host_tool_result" && f.id === callId));
		const frame = t.frames.find(f => f.type === "host_tool_result" && f.id === callId) as {
			isError?: boolean;
			result: { content: Array<{ text: string }> };
		};
		return { isError: frame.isError === true, text: frame.result.content[0].text };
	};

	it("agora_attach then agent_end posts one message carrying the attachment id", async () => {
		const w = await workspace();
		const t = setup({ cwd: w.cwd, envFile: w.envFile });
		await t.host.send({ text: "make a log" });
		toolCall(t, "h1", { path: "out.log", caption: "the log" });
		expect(await toolResult(t, "h1")).toEqual({ isError: false, text: "attached out.log" });
		t.entries.push(assistantEntry("e1", "done, log attached"));
		t.emit({ type: "agent_end", messages: [] });
		await until(() => t.posts.length === 1);
		expect(t.posts[0].attachment_ids).toEqual(["a1"]);
		expect(t.posts[0].body).toBe("done, log attached");
		expect(t.uploads).toEqual([path.join(w.cwd, "out.log")]);
	});

	it("posts the caption alone when the turn has attachments but no text", async () => {
		const w = await workspace();
		const t = setup({ cwd: w.cwd, envFile: w.envFile });
		await t.host.send({ text: "make a log" });
		toolCall(t, "h1", { path: "out.log", caption: "the log" });
		await toolResult(t, "h1");
		t.emit({ type: "agent_end", messages: [] });
		await until(() => t.posts.length === 1);
		expect(t.posts[0]).toMatchObject({ body: "the log", attachment_ids: ["a1"] });
	});

	it("refuses paths outside the workspace, symlink escapes and the env file", async () => {
		const w = await workspace();
		const t = setup({ cwd: w.cwd, envFile: w.envFile });
		await t.host.send({ text: "go" });
		toolCall(t, "h1", { path: "../../etc/passwd" });
		toolCall(t, "h2", { path: w.envFile });
		toolCall(t, "h3", { path: "up/env" });
		for (const callId of ["h1", "h2", "h3"]) expect((await toolResult(t, callId)).isError).toBe(true);
		expect(t.uploads).toEqual([]);
	});

	it("puts a waiting question step and posts the numbered text for an ask request", async () => {
		const t = setup();
		await t.host.send({ text: "go" });
		t.emit({
			type: "extension_ui_request",
			id: "r1",
			method: "ask",
			questions: [{ id: "q1", question: "Which db?", options: [{ label: "pg" }, { label: "sqlite" }] }],
		});
		await until(() => t.posts.length === 1);
		expect(t.posts[0].body).toBe("Which db?\n1. pg\n2. sqlite\n\nReply with a number or your own answer.");
		await until(() => t.activity.some(a => a.steps[0].kind === "question"));
		const step = t.activity.find(a => a.steps[0].kind === "question")!;
		expect(step.steps[0]).toMatchObject({ step_id: "q-r1", status: "waiting" });
		expect(step.steps[0].detail).toEqual({
			questions: [{ id: "q1", question: "Which db?", options: [{ label: "pg" }, { label: "sqlite" }] }],
		});
		expect(t.host.pendingQuestion()).toEqual({ stepId: "q-r1" });
	});

	it("still posts the numbered text when Agora has no activity endpoint", async () => {
		const t = setup({ activity: false });
		await t.host.send({ text: "go" });
		t.emit({ type: "extension_ui_request", id: "r1", method: "select", title: "Pick", options: ["a", "b"] });
		await until(() => t.posts.length === 1);
		expect(t.posts[0].body).toContain("2. b");
	});

	it("answerFromText maps a number to the option label and anything else to custom text", async () => {
		const t = setup();
		await t.host.send({ text: "go" });
		const ask = (reqId: string) =>
			t.emit({
				type: "extension_ui_request",
				id: reqId,
				method: "ask",
				questions: [{ id: "q1", question: "Which?", options: [{ label: "pg" }, { label: "sqlite" }] }],
			});
		ask("r1");
		await until(() => t.host.pendingQuestion() !== null);
		expect(t.host.answerFromText("2", "u1")).toBe(true);
		expect(t.frames.at(-1)).toEqual({
			type: "extension_ui_response",
			id: "r1",
			answers: [{ id: "q1", selectedOptions: ["sqlite"] }],
		});
		expect(t.host.pendingQuestion()).toBeNull();
		expect(t.host.answerFromText("2", "u1")).toBe(false);
		await until(() => t.activity.some(a => a.steps[0].status === "answered"));
		const answered = t.activity.find(a => a.steps[0].status === "answered")!;
		expect(answered.steps[0]).toMatchObject({
			step_id: "q-r1",
			kind: "question",
			detail: {
				questions: [{ id: "q1", question: "Which?", options: [{ label: "pg" }, { label: "sqlite" }] }],
				answers: [{ id: "q1", selected: ["sqlite"] }],
				answered_by: "u1",
			},
		});

		ask("r2");
		await until(() => t.host.pendingQuestion() !== null);
		expect(t.host.answerFromText("neither, use duckdb", "u1")).toBe(true);
		expect(t.frames.at(-1)).toEqual({
			type: "extension_ui_response",
			id: "r2",
			answers: [{ id: "q1", selectedOptions: [], customInput: "neither, use duckdb" }],
		});
	});

	it("answers select, confirm and input requests with value / confirmed", async () => {
		const t = setup();
		await t.host.send({ text: "go" });
		const request = async (frame: Record<string, unknown>) => {
			t.emit({ type: "extension_ui_request", ...frame });
			await until(() => t.host.pendingQuestion() !== null);
		};
		await request({ id: "s1", method: "select", title: "Pick", options: ["a", "b"] });
		t.host.answerFromText("1", "u1");
		expect(t.frames.at(-1)).toEqual({ type: "extension_ui_response", id: "s1", value: "a" });
		await request({ id: "c1", method: "confirm", title: "Sure?", message: "really" });
		expect(t.host.answerFromText("maybe", "u1")).toBe(false);
		t.host.answerFromText("1", "u1");
		expect(t.frames.at(-1)).toEqual({ type: "extension_ui_response", id: "c1", confirmed: true });
		await request({ id: "i1", method: "input", title: "Name?" });
		t.host.answerFromText("Ada", "u1");
		expect(t.frames.at(-1)).toEqual({ type: "extension_ui_response", id: "i1", value: "Ada" });
	});

	it("answerFromAgora maps selected to selectedOptions and ignores another step", async () => {
		const t = setup();
		await t.host.send({ text: "go" });
		t.emit({
			type: "extension_ui_request",
			id: "r1",
			method: "ask",
			questions: [
				{ id: "q1", question: "Which?", multi: true, options: [{ label: "a" }, { label: "b" }] },
				{ id: "q2", question: "Why?", options: [] },
			],
		});
		await until(() => t.host.pendingQuestion() !== null);
		expect(t.host.answerFromAgora("q-other", [])).toBe(false);
		expect(
			t.host.answerFromAgora("q-r1", [
				{ id: "q1", selected: ["a", "b"] },
				{ id: "q2", selected: [], custom: "because" },
			]),
		).toBe(true);
		expect(t.frames.at(-1)).toEqual({
			type: "extension_ui_response",
			id: "r1",
			answers: [
				{ id: "q1", selectedOptions: ["a", "b"] },
				{ id: "q2", selectedOptions: [], customInput: "because" },
			],
		});
	});

	it("cancels a question that times out and puts the step as cancelled", async () => {
		const t = setup();
		await t.host.send({ text: "go" });
		t.emit({ type: "extension_ui_request", id: "r1", method: "confirm", title: "Sure?", message: "", timeout: 5000 });
		await until(() => t.host.pendingQuestion() !== null);
		t.time.advance(5000);
		expect(t.frames.at(-1)).toEqual({ type: "extension_ui_response", id: "r1", cancelled: true, timedOut: true });
		expect(t.host.pendingQuestion()).toBeNull();
		await until(() => t.activity.some(a => a.steps[0].status === "cancelled"));
	});

	it("posts a notify request as a normal message and ignores other methods", async () => {
		const t = setup();
		await t.host.send({ text: "go" });
		t.emit({ type: "extension_ui_request", id: "n1", method: "setTitle", title: "x" });
		t.emit({ type: "extension_ui_request", id: "n2", method: "notify", message: "heads up" });
		await until(() => t.posts.length === 1);
		expect(t.posts[0].body).toBe("heads up");
		expect(t.host.pendingQuestion()).toBeNull();
	});
});
