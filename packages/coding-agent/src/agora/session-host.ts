import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger, ptree } from "@oh-my-pi/pi-utils";
import { buildToolCallStartUpdate } from "../modes/acp/acp-event-mapper";
import {
	type RpcAgentProcess,
	RpcClient,
	type RpcClientCustomTool,
	type RpcClientOptions,
} from "../modes/rpc/rpc-client";
import type { RpcAskDialogQuestion, RpcExtensionUIRequest, RpcExtensionUIResponse } from "../modes/rpc/rpc-types";
import type { AgentSessionEvent } from "../session/agent-session";
import { type AttachedFile, createAttachTool } from "./attach";
import type { AgoraClient, AgoraStep } from "./client";

const HEARTBEAT_MS = 60_000;
const NOTE_THROTTLE_MS = 15_000;
const PARTIAL_MS = 1000;
const PARTIAL_CHARS = 2000;
const STEP_FLUSH_MS = 500;
const STEP_BATCH = 50;
const MAX_MESSAGE_CHARS = 19_000;
const KILL_GRACE_MS = 5000;
const MAX_TITLE = 200;
const MAX_INPUT = 4000;
const MAX_OUTPUT = 8000;
const MAX_DIFF_TOTAL = 32_000;
const MAX_PLAN_ITEMS = 100;
const QUESTION_TIMEOUT_MS = 30 * 60_000;
const MAX_ATTACH_PER_MESSAGE = 20;
/** Agora's default `agora.envFile`; the daemon passes the configured path. */
const DEFAULT_ENV_FILE = "~/.config/agora-ompx/env";

export interface HostTimers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realTimers: HostTimers = {
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

export interface SessionHostStore {
	postedHas(conversation: string, entryId: string): boolean;
	postedAdd(conversation: string, entryId: string, messageId: string): void;
}

export interface SessionHostOptions {
	conversationId: string;
	cwd: string;
	sessionDir: string;
	/** Session file to fork from; pass only for the first spawn of a forked binding. Later spawns use `--continue`. */
	forkFrom?: string;
	client: AgoraClient;
	store: SessionHostStore;
	/** Argv prefix of the ompx executable (RpcClient adds `--mode rpc`). Defaults to the running executable. */
	command?: string[];
	spawn?: RpcClientOptions["spawn"];
	/** Root of downloaded inbound files; `agora_attach` also accepts paths under it. Defaults to `<sessionDir>/inbox`. */
	inboxDir?: string;
	/** Agora env file (holds the token); `agora_attach` refuses it. */
	envFile?: string;
	/** Host tools such as `agora_attach`. */
	customTools?: RpcClientCustomTool[];
	idleMs: number;
	onIdle(): void;
	/** Called each time the session settles (no run live, no background work). */
	onSettled?(): void;
	now?: () => number;
	timers?: HostTimers;
}

export interface HostTurn {
	text: string;
	images?: ImageContent[];
}

/** Split at paragraph boundaries into chunks of at most `max` characters (an oversized paragraph is hard-split). */
export function chunkReply(text: string, max = MAX_MESSAGE_CHARS): string[] {
	const out: string[] = [];
	let current = "";
	for (const paragraph of text.split("\n\n")) {
		let rest = paragraph;
		while (rest.length > max) {
			if (current) out.push(current);
			current = "";
			out.push(rest.slice(0, max));
			rest = rest.slice(max);
		}
		const joined = current ? `${current}\n\n${rest}` : rest;
		if (joined.length > max) {
			out.push(current);
			current = rest;
		} else {
			current = joined;
		}
	}
	if (current) out.push(current);
	return out;
}

/** Text blocks of a message or tool result, joined (the ACP extractor truncates at 4000 chars). */
function textOf(value: unknown): string {
	const content = value && typeof value === "object" && "content" in value ? value.content : undefined;
	if (!Array.isArray(content)) return "";
	return content
		.map(block =>
			block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "",
		)
		.filter(Boolean)
		.join("\n");
}

const clip = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

function defaultCommand(): string[] {
	const entry = process.argv[1];
	return entry && (entry.endsWith(".ts") || entry.endsWith(".js")) ? [process.execPath, entry] : [process.execPath];
}

function childEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("AGORA_")) env[key] = value;
	}
	return env;
}

const TODO_STATUS: Record<string, "pending" | "in_progress" | "done" | "blocked"> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "done",
	abandoned: "done",
	blocked: "blocked",
};

function planItems(todos: unknown): Array<{ text: string; status: "pending" | "in_progress" | "done" | "blocked" }> {
	const items: Array<{ text: string; status: "pending" | "in_progress" | "done" | "blocked" }> = [];
	for (const todo of Array.isArray(todos) ? todos : []) {
		const content = (todo as { content?: unknown })?.content;
		if (typeof content !== "string" || !content) continue;
		items.push({ text: content, status: TODO_STATUS[(todo as { status?: string }).status ?? ""] ?? "pending" });
	}
	return items.slice(0, MAX_PLAN_ITEMS);
}

function todoPhasesToItems(result: unknown): ReturnType<typeof planItems> | undefined {
	const phases = (result as { details?: { phases?: unknown } } | null)?.details?.phases;
	if (!Array.isArray(phases)) return undefined;
	return planItems(phases.flatMap(phase => (Array.isArray(phase?.tasks) ? phase.tasks : [])));
}

function diffFiles(result: unknown): Array<{ path: string; patch: string }> {
	const details = (result as { details?: unknown } | null)?.details as
		| { perFileResults?: unknown; path?: unknown; diff?: unknown }
		| undefined;
	if (!details || typeof details !== "object") return [];
	const entries: unknown[] = Array.isArray(details.perFileResults) ? details.perFileResults : [details];
	const files: Array<{ path: string; patch: string }> = [];
	let total = 0;
	for (const entry of entries) {
		const { path, diff, isError } = (entry ?? {}) as { path?: unknown; diff?: unknown; isError?: unknown };
		if (typeof path !== "string" || typeof diff !== "string" || !diff || isError === true) continue;
		const patch = clip(diff, MAX_DIFF_TOTAL - total);
		if (!patch) break;
		files.push({ path, patch });
		total += patch.length;
	}
	return files;
}

/** Question shape of a dialog request, or undefined for methods that are not questions. */
function questionsOf(req: RpcExtensionUIRequest): RpcAskDialogQuestion[] | undefined {
	switch (req.method) {
		case "ask":
			return req.questions;
		case "select":
			return [
				{
					id: "answer",
					question: req.title,
					options: req.options.map((label, i) => ({ label, description: req.optionDetails?.[i]?.description })),
				},
			];
		case "confirm":
			return [
				{
					id: "answer",
					question: [req.title, req.message].filter(Boolean).join("\n"),
					options: [{ label: "Yes" }, { label: "No" }],
				},
			];
		case "input":
			return [{ id: "answer", question: req.title, options: [] }];
		default:
			return undefined;
	}
}

/** Numbered plain-text rendering of the questions, for Agora versions without question cards. */
function questionText(questions: RpcAskDialogQuestion[]): string {
	const blocks = questions.map(q =>
		[
			q.header ? `${q.header}: ${q.question}` : q.question,
			...q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` - ${o.description}` : ""}`),
		].join("\n"),
	);
	const hint = questions.every(q => q.options.length === 0)
		? "Reply with your answer."
		: questions.length > 1
			? "Reply with one line per question, each a number or your own answer."
			: "Reply with a number or your own answer.";
	return `${blocks.join("\n\n")}\n\n${hint}`;
}

/** One typed line as an answer: valid option numbers (comma separated when `multi`) pick options, anything else is custom text. */
function answerOfLine(q: RpcAskDialogQuestion, line: string): { selected: string[]; custom?: string } {
	const text = line.trim();
	const picks = (q.multi ? text.split(/\s*,\s*/) : [text]).map(p => (/^\d+$/.test(p) ? Number(p) : 0));
	if (picks.every(n => n >= 1 && n <= q.options.length)) {
		return { selected: [...new Set(picks.map(n => q.options[n - 1].label))] };
	}
	return { selected: [], ...(text ? { custom: text } : {}) };
}

type QuestionReply =
	| { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }
	| { value: string }
	| { confirmed: boolean };

interface PendingQuestion {
	requestId: string;
	method: "ask" | "select" | "confirm" | "input";
	questions: RpcAskDialogQuestion[];
	turnId: string;
	step: AgoraStep;
	timer: unknown;
}

/** The `extension_ui_response` body for answers keyed by question id. */
function replyOf(
	method: PendingQuestion["method"],
	questions: RpcAskDialogQuestion[],
	answers: Array<{ id: string; selected: string[]; custom?: string }>,
): QuestionReply {
	const first = answers[0];
	if (method === "confirm") return { confirmed: first?.selected[0] === "Yes" };
	if (method === "select") return { value: first?.selected[0] ?? first?.custom ?? "" };
	if (method === "input") return { value: first?.custom ?? first?.selected[0] ?? "" };
	return {
		answers: questions.map(q => {
			const a = answers.find(x => x.id === q.id);
			return { id: q.id, selectedOptions: a?.selected ?? [], ...(a?.custom ? { customInput: a.custom } : {}) };
		}),
	};
}

/** One ompx RPC child bound to one Agora conversation: prompts in, posts/status/partial/steps out. */
export class SessionHost {
	readonly #opts: SessionHostOptions;
	readonly #timers: HostTimers;
	readonly #now: () => number;
	#forkFrom: string | undefined;
	#rpc: RpcClient | null = null;
	#exited: Promise<unknown> = Promise.resolve();
	#stopping = false;
	#busy = false;
	#sessionFile: string | undefined;
	#lastEntryId: string | undefined;
	#chain: Promise<void> = Promise.resolve();
	#putChain: Promise<void> = Promise.resolve();
	#heartbeat: unknown;
	#idleTimer: unknown;
	#note: string | undefined;
	#noteTool: string | undefined;
	#noteAt = Number.NEGATIVE_INFINITY;
	#turnId = randomUUID();
	#turnClosed = true;
	#runText = "";
	#partialAt = Number.NEGATIVE_INFINITY;
	#partialTimer: unknown;
	#partialOk = true;
	#activityOk = true;
	#steps = new Map<string, AgoraStep>();
	#dirty = new Set<string>();
	#seq = 0;
	#stepTimer: unknown;
	#attachments: AttachedFile[] = [];
	#question: PendingQuestion | null = null;

	constructor(options: SessionHostOptions) {
		this.#opts = options;
		this.#forkFrom = options.forkFrom;
		this.#timers = options.timers ?? realTimers;
		this.#now = options.now ?? Date.now;
	}

	get busy(): boolean {
		return this.#busy;
	}

	/** Session file reported by the child; refreshed after spawn and on every settle. */
	get sessionFile(): string | undefined {
		return this.#sessionFile;
	}

	/** The question waiting for a human answer, if any (one per host). */
	pendingQuestion(): { stepId: string } | null {
		return this.#question ? { stepId: this.#question.step.step_id } : null;
	}

	/**
	 * Answer the pending question from a chat message by `answeredBy` (the sender's actor id): a number picks that
	 * option, anything else is custom text. On success the step is PUT as `answered` with the answers and `answered_by`
	 * (a failed PUT only logs; an older Agora ignores it).
	 * `false` when nothing is pending, the text is blank, or a confirm question got text that is neither yes nor no.
	 */
	answerFromText(text: string, answeredBy: string): boolean {
		const q = this.#question;
		if (!q || !text.trim()) return false;
		const lines = q.questions.length === 1 ? [text] : text.split(/\r?\n/);
		const answers = q.questions.map((question, i) => ({
			id: question.id,
			...answerOfLine(question, lines[i] ?? ""),
		}));
		if (q.method === "confirm") {
			const t = text.trim();
			const word = /^y(es)?$/i.test(t) ? "Yes" : /^no?$/i.test(t) ? "No" : undefined;
			if (!word && answers[0].selected.length === 0) return false;
			if (word) answers[0] = { id: answers[0].id, selected: [word] };
		}
		if (!this.#answer(q, replyOf(q.method, q.questions, answers))) return false;
		this.#putSteps(q.turnId, [
			{ ...q.step, status: "answered", detail: { ...q.step.detail, answers, answered_by: answeredBy } },
		]);
		return true;
	}

	/** Answer the pending question from an Agora question card; `false` when `stepId` is not the pending one. */
	answerFromAgora(stepId: string, answers: Array<{ id: string; selected: string[]; custom?: string }>): boolean {
		const q = this.#question;
		if (!q || q.step.step_id !== stepId) return false;
		return this.#answer(q, replyOf(q.method, q.questions, answers));
	}

	async send(turn: HostTurn): Promise<void> {
		const rpc = await this.#ensure();
		this.#timers.clearTimeout(this.#idleTimer);
		if (this.#busy) {
			await rpc.followUp(turn.text, turn.images);
			return;
		}
		this.#busy = true;
		this.#mintTurn();
		this.#note = undefined;
		this.#noteTool = undefined;
		this.#noteAt = Number.NEGATIVE_INFINITY;
		this.#heartbeat = this.#timers.setInterval(() => this.#postWorking(), HEARTBEAT_MS);
		this.#postWorking();
		try {
			await rpc.prompt(turn.text, turn.images);
		} catch (error) {
			await this.#enqueue(() => this.#fail(error instanceof Error ? error.message : String(error)));
			throw error;
		}
	}

	async steer(turn: HostTurn): Promise<void> {
		const rpc = await this.#ensure();
		await rpc.steer(turn.text, turn.images);
	}

	async abort(): Promise<void> {
		await this.#rpc?.abort();
	}

	/** Abort, wait up to 5 s for the child to exit on its own, then kill it. */
	async stop(): Promise<void> {
		const rpc = this.#rpc;
		this.#stopping = true;
		this.#timers.clearTimeout(this.#idleTimer);
		this.#clearBusyTimers();
		this.#closeQuestion("cancelled");
		if (!rpc) return;
		this.#rpc = null;
		this.#busy = false;
		try {
			await rpc.abort();
		} catch {
			// The child may already be gone.
		}
		const grace = Promise.withResolvers<void>();
		const timer = this.#timers.setTimeout(grace.resolve, KILL_GRACE_MS);
		await Promise.race([this.#exited, grace.promise]);
		this.#timers.clearTimeout(timer);
		await rpc.stop();
	}

	async #ensure(): Promise<RpcClient> {
		if (this.#rpc) return this.#rpc;
		this.#stopping = false;
		const { command = defaultCommand(), spawn } = this.#opts;
		const args = this.#forkFrom ? ["--fork", this.#forkFrom] : ["--continue"];
		const rpc = new RpcClient({
			cwd: this.#opts.cwd,
			sessionDir: this.#opts.sessionDir,
			// The chat answers `ask` and confirmations: they arrive as extension UI requests and become question cards.
			uiDialogs: true,
			args,
			customTools: [
				createAttachTool({
					cwd: this.#opts.cwd,
					inboxDir: this.#opts.inboxDir ?? path.join(this.#opts.sessionDir, "inbox"),
					envFile: this.#opts.envFile ?? DEFAULT_ENV_FILE,
					client: this.#opts.client,
					queue: this.#attachments,
				}),
				...(this.#opts.customTools ?? []),
			],
			spawn: async agentArgs => {
				const child: RpcAgentProcess = spawn
					? await spawn(agentArgs)
					: ptree.spawn([...command, ...agentArgs], { cwd: this.#opts.cwd, env: childEnv(), stdin: "pipe" });
				this.#exited = child.exited.then(
					code => this.#enqueue(() => this.#onExit(rpc, code)),
					() => this.#enqueue(() => this.#onExit(rpc, undefined)),
				);
				return child;
			},
		});
		rpc.onSessionEvent(event => this.#onEvent(event));
		rpc.onExtensionUiRequest(req => this.#onUiRequest(req));
		rpc.onPromptResult(result => {
			if (result.status === "error") {
				const message = result.error?.message ?? "prompt failed";
				void this.#enqueue(() => this.#fail(message));
			} else if (result.sessionSettled) {
				void this.#enqueue(() => this.#settle());
			} else {
				this.#setNote("running in the background", undefined, true);
			}
		});
		rpc.onSessionSettled(() => void this.#enqueue(() => this.#settle()));
		await rpc.start();
		try {
			await rpc.setAskDialog(true);
		} catch (error) {
			logger.warn("agora: set_ask_dialog failed", { error: String(error) });
		}
		this.#rpc = rpc;
		this.#forkFrom = undefined;
		await this.#refreshSessionFile(rpc);
		return rpc;
	}

	async #refreshSessionFile(rpc: RpcClient): Promise<void> {
		try {
			this.#sessionFile = (await rpc.getState()).sessionFile;
		} catch (error) {
			logger.warn("agora: get_state failed", { error: String(error) });
		}
	}

	#enqueue(fn: () => Promise<void>): Promise<void> {
		this.#chain = this.#chain.then(fn).catch(error => {
			logger.warn("agora: session host task failed", {
				conversation: this.#opts.conversationId,
				error: String(error),
			});
		});
		return this.#chain;
	}

	#clearBusyTimers(): void {
		this.#timers.clearInterval(this.#heartbeat);
		this.#timers.clearTimeout(this.#partialTimer);
		this.#timers.clearTimeout(this.#stepTimer);
		this.#heartbeat = this.#partialTimer = this.#stepTimer = undefined;
	}

	#postWorking(): void {
		const { client, conversationId } = this.#opts;
		client.setStatus(conversationId, "working", this.#note, this.#noteTool).catch(error => {
			logger.warn("agora: setStatus failed", { error: String(error) });
		});
	}

	#setNote(note: string, tool: string | undefined, force = false): void {
		const now = this.#now();
		if (!force && now - this.#noteAt < NOTE_THROTTLE_MS) return;
		this.#noteAt = now;
		this.#note = note;
		this.#noteTool = tool;
	}

	async #settle(): Promise<void> {
		if (!this.#busy) return;
		this.#busy = false;
		this.#clearBusyTimers();
		if (this.#rpc) await this.#refreshSessionFile(this.#rpc);
		await this.#opts.client.setStatus(this.#opts.conversationId, "idle");
		this.#opts.onSettled?.();
		this.#timers.clearTimeout(this.#idleTimer);
		this.#idleTimer = this.#timers.setTimeout(() => this.#opts.onIdle(), this.#opts.idleMs);
	}

	async #fail(reason: string): Promise<void> {
		this.#busy = false;
		this.#clearBusyTimers();
		const note = clip(reason.replace(/\s+/g, " ").trim(), 200) || "failed";
		await this.#opts.client.setStatus(this.#opts.conversationId, "failed", note);
	}

	async #onExit(rpc: RpcClient, code: number | undefined): Promise<void> {
		if (this.#stopping || this.#rpc !== rpc) return;
		this.#rpc = null;
		this.#closeQuestion("cancelled");
		this.#timers.clearTimeout(this.#idleTimer);
		if (this.#busy) await this.#fail(`ompx exited${code === undefined ? "" : ` (code ${code})`}`);
		await rpc.stop();
	}

	#mintTurn(): void {
		this.#flushSteps();
		this.#turnId = randomUUID();
		this.#turnClosed = false;
		this.#steps.clear();
		this.#seq = 0;
		this.#runText = "";
	}

	#onEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				if (this.#turnClosed) this.#mintTurn();
				break;
			case "agent_end": {
				const turnId = this.#turnId;
				this.#turnClosed = true;
				this.#flushSteps();
				this.#timers.clearTimeout(this.#partialTimer);
				this.#partialTimer = undefined;
				if (this.#runText) this.#sendPartial();
				void this.#enqueue(() => this.#postFinal(turnId));
				break;
			}
			case "message_update": {
				const inner = event.assistantMessageEvent;
				if (inner.type === "text_delta") {
					this.#runText += inner.delta;
					this.#schedulePartial();
				} else if (inner.type === "thinking_end") {
					this.#upsertStep(`thinking:${this.#seq + 1}`, "thinking", "Thinking", "done", {
						text: clip(inner.content, MAX_OUTPUT),
					});
				}
				break;
			}
			case "tool_execution_start": {
				const title = (
					buildToolCallStartUpdate({
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						intent: event.intent,
						cwd: this.#opts.cwd,
					}) as { title: string }
				).title;
				this.#setNote(`${event.toolName}: ${title}`, event.toolName);
				this.#upsertStep(event.toolCallId, "tool", title, "running", {
					tool: event.toolName,
					input: clip(JSON.stringify(event.args ?? {}), MAX_INPUT),
				});
				break;
			}
			case "tool_execution_end": {
				const prev = this.#steps.get(event.toolCallId);
				this.#upsertStep(
					event.toolCallId,
					"tool",
					prev?.title ?? event.toolName,
					event.isError ? "failed" : "done",
					{
						...prev?.detail,
						tool: event.toolName,
						output: clip(textOf(event.result), MAX_OUTPUT),
					},
				);
				if (event.isError) break;
				const files = diffFiles(event.result);
				if (files.length > 0) {
					this.#upsertStep(`${event.toolCallId}:diff`, "diff", files.map(f => f.path).join(", "), "done", {
						files,
					});
				}
				const items = event.toolName === "todo" ? todoPhasesToItems(event.result) : undefined;
				if (items) this.#upsertStep("plan", "plan", "Plan", "done", { items });
				break;
			}
			case "todo_reminder":
				this.#upsertStep("plan", "plan", "Plan", "done", { items: planItems(event.todos) });
				break;
		}
	}

	#schedulePartial(): void {
		const wait = this.#partialAt + PARTIAL_MS - this.#now();
		if (wait <= 0) {
			this.#sendPartial();
		} else if (this.#partialTimer === undefined) {
			this.#partialTimer = this.#timers.setTimeout(() => {
				this.#partialTimer = undefined;
				this.#sendPartial();
			}, wait);
		}
	}

	#sendPartial(): void {
		this.#partialAt = this.#now();
		if (!this.#partialOk) return;
		this.#opts.client.partial(this.#opts.conversationId, this.#runText.slice(-PARTIAL_CHARS)).then(
			ok => {
				if (!ok) this.#partialOk = false;
			},
			error => logger.warn("agora: partial failed", { error: String(error) }),
		);
	}

	#upsertStep(
		stepId: string,
		kind: AgoraStep["kind"],
		title: string,
		status: AgoraStep["status"],
		detail: Record<string, unknown>,
	): void {
		const prev = this.#steps.get(stepId);
		this.#steps.set(stepId, {
			step_id: stepId,
			seq: prev?.seq ?? ++this.#seq,
			kind,
			title: clip(title, MAX_TITLE),
			status,
			detail,
		});
		this.#dirty.add(stepId);
		if (this.#stepTimer === undefined) {
			this.#stepTimer = this.#timers.setTimeout(() => {
				this.#stepTimer = undefined;
				this.#flushSteps();
			}, STEP_FLUSH_MS);
		}
	}

	/** Send changed steps in order (PUT is an upsert, so concurrent PUTs would let a stale `running` overwrite `done`). */
	#flushSteps(): void {
		this.#timers.clearTimeout(this.#stepTimer);
		this.#stepTimer = undefined;
		if (this.#dirty.size === 0) return;
		const steps = [...this.#dirty].flatMap(stepId => this.#steps.get(stepId) ?? []);
		this.#dirty.clear();
		if (!this.#activityOk) return;
		const turnId = this.#turnId;
		for (let i = 0; i < steps.length; i += STEP_BATCH) this.#putSteps(turnId, steps.slice(i, i + STEP_BATCH));
	}

	#putSteps(turnId: string, steps: AgoraStep[]): void {
		if (!this.#activityOk) return;
		this.#putChain = this.#putChain
			.then(() => this.#opts.client.putActivity(this.#opts.conversationId, turnId, steps))
			.then(ok => {
				if (!ok) this.#activityOk = false;
			})
			.catch(error => logger.warn("agora: putActivity failed", { error: String(error) }));
	}

	#post(body: string): Promise<void> {
		return this.#opts.client.postMessage(this.#opts.conversationId, { body, turn_id: this.#turnId }).then(() => {});
	}

	#onUiRequest(req: RpcExtensionUIRequest): void {
		if (req.method === "notify") {
			const body = req.message.trim();
			if (body) void this.#enqueue(() => this.#post(body));
			return;
		}
		if (req.method === "cancel") {
			if (this.#question?.requestId === req.targetId) this.#closeQuestion("cancelled");
			return;
		}
		const questions = questionsOf(req);
		if (!questions) return;
		if (this.#question) {
			this.#respond({ type: "extension_ui_response", id: req.id, cancelled: true });
			return;
		}
		const turnId = this.#turnId;
		const step: AgoraStep = {
			step_id: `q-${req.id}`,
			seq: ++this.#seq,
			kind: "question",
			title: clip(questions[0].question, MAX_TITLE),
			status: "waiting",
			detail: { questions },
		};
		const q: PendingQuestion = {
			requestId: req.id,
			method: req.method as PendingQuestion["method"],
			questions,
			turnId,
			step,
			timer: this.#timers.setTimeout(
				() => {
					this.#respond({ type: "extension_ui_response", id: q.requestId, cancelled: true, timedOut: true });
					this.#closeQuestion("cancelled");
				},
				("timeout" in req ? req.timeout : undefined) ?? QUESTION_TIMEOUT_MS,
			),
		};
		this.#question = q;
		this.#putSteps(turnId, [step]);
		void this.#enqueue(() => this.#post(questionText(questions)));
	}

	#respond(response: RpcExtensionUIResponse): boolean {
		try {
			this.#rpc?.respondExtensionUi(response);
			return this.#rpc !== null;
		} catch (error) {
			logger.warn("agora: extension_ui_response failed", { error: String(error) });
			return false;
		}
	}

	#answer(q: PendingQuestion, reply: QuestionReply): boolean {
		if (!this.#respond({ type: "extension_ui_response", id: q.requestId, ...reply })) return false;
		this.#closeQuestion();
		return true;
	}

	/** Forget the pending question; with `cancelled`, also mark its step so the card stops asking. */
	#closeQuestion(cancelled?: "cancelled"): void {
		const q = this.#question;
		if (!q) return;
		this.#question = null;
		this.#timers.clearTimeout(q.timer);
		if (cancelled) this.#putSteps(q.turnId, [{ ...q.step, status: cancelled }]);
	}

	/** Post the final assistant entry of the run that just ended, once per entry id, with any queued `agora_attach` files. */
	async #postFinal(turnId: string): Promise<void> {
		const rpc = this.#rpc;
		if (!rpc) return;
		const { entries } = await rpc.getEntries(this.#lastEntryId);
		const last = entries.at(-1);
		if (last) this.#lastEntryId = last.id;
		const { conversationId, client, store } = this.#opts;
		const found = entries.findLast(e => e.type === "message" && e.message.role === "assistant");
		const entry = found?.type === "message" && !store.postedHas(conversationId, found.id) ? found : undefined;
		const text = entry ? textOf(entry.message).trim() : "";
		if (!text && this.#attachments.length === 0) return;
		await this.#putChain;
		const files = this.#attachments.splice(0, MAX_ATTACH_PER_MESSAGE);
		const bodies = text ? chunkReply(text) : [files.map(f => f.caption ?? f.filename).join("\n")];
		let firstId: string | undefined;
		try {
			for (const body of bodies) {
				const { id } = await client.postMessage(conversationId, {
					body,
					turn_id: turnId,
					...(firstId === undefined && files.length > 0 ? { attachment_ids: files.map(f => f.id) } : {}),
				});
				firstId ??= id;
			}
		} catch (error) {
			if (firstId === undefined) this.#attachments.unshift(...files);
			throw error;
		}
		if (entry && text && firstId) store.postedAdd(conversationId, entry.id, firstId);
	}
}
