/**
 * `ompx agora serve`: follows the @ompx agent's Agora event stream and drives one `SessionHost` per bound
 * conversation. Trust checks, binding, the per-repo main-checkout lock and the `maxSessions` queue live here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../config/settings";
import type { AgoraActor, AgoraChatMessage, AgoraClient, AgoraEvent } from "./client";
import { AgoraCommands } from "./commands";
import { type ChatHistoryItem, quoted, toInboundTurn } from "./inbound";
import type { HostTimers, HostTurn, SessionHostOptions } from "./session-host";
import type { AgoraBinding, AgoraStore } from "./store";

const EVENT_TYPES = ["chat.message", "chat.branched", "agent.question_answered"];
const WAIT_NOTE_MS = 60_000;
const SETTLE_POLL_MS = 100;
const MAX_TITLE = 100;
const PARENT_PAGE_SIZE = 50;
const MAX_PARENT_PAGES = 4;
const MAX_PARENT_MESSAGE = 2000;
const MAX_PARENT_CHARS = 30_000;
const REFUSAL = "I only take requests from people set up on this machine. Ask the owner to add you.";
const RESTART_NOTE = "ompx restarted; send your message again";

export interface AgoraDaemonSettings {
	repos: Record<string, string>;
	defaultRepo: string;
	allowedUsers: string[];
	maxSessions: number;
	idleMinutes: number;
	maxAttachmentMB: number;
}

/** What the daemon needs from a `SessionHost`. */
export interface DaemonHost {
	readonly busy: boolean;
	readonly sessionFile: string | undefined;
	send(turn: HostTurn): Promise<void>;
	steer(turn: HostTurn): Promise<void>;
	pendingQuestion?(): { stepId: string } | null;
	answerFromText?(text: string, answeredBy: string): boolean;
	answerFromAgora?(stepId: string, answers: Array<{ id: string; selected: string[]; custom?: string }>): boolean;
	abort(): Promise<void>;
	stop(): Promise<void>;
}

export interface DaemonLog {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

export interface AgoraDaemonDeps {
	client: Pick<
		AgoraClient,
		| "me"
		| "postMessage"
		| "setStatus"
		| "download"
		| "stream"
		| "branch"
		| "patchConversation"
		| "createConversation"
		| "getConversation"
		| "listMessages"
	>;
	store: Pick<
		AgoraStore,
		| "receive"
		| "cursor"
		| "pruneSeen"
		| "getBinding"
		| "putBinding"
		| "closeBinding"
		| "getAllowedActor"
		| "pinAllowedActor"
		| "hasRefused"
		| "addRefused"
		| "hasPosted"
		| "addPosted"
	>;
	settings: AgoraDaemonSettings;
	createHost(options: SessionHostOptions): DaemonHost;
	agentDir: string;
	/** Settings for creating a worktree off `cwd`; defaults to built-in settings. */
	settingsFor?(cwd: string): Promise<Settings>;
	now?: () => number;
	timers?: Pick<HostTimers, "setInterval" | "clearInterval">;
	log: DaemonLog;
}

export interface ChatMessageEventData {
	conversation?: { id: string; title?: string | null };
	message: AgoraChatMessage;
	history?: ChatHistoryItem[];
}

interface Live {
	host: DaemonHost;
	binding: AgoraBinding;
	/** Sends handed to the host that have not returned yet. */
	pending: number;
	tail: Promise<void>;
}

interface Queued {
	conv: string;
	binding: AgoraBinding;
	turn: HostTurn;
	timer: unknown;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** `--fork` applies only before the conversation has its own transcript. */
function hasTranscript(sessionDir: string): boolean {
	try {
		return fs.readdirSync(sessionDir).some(name => name.endsWith(".jsonl"));
	} catch {
		return false;
	}
}

export class AgoraDaemon {
	readonly #deps: AgoraDaemonDeps;
	readonly #live = new Map<string, Live>();
	readonly #queue: Queued[] = [];
	readonly #titles = new Map<string, string>();
	/** Conversations whose first-turn branch context was settled (sent, or not a branch). */
	readonly #seeded = new Set<string>();
	readonly #trustedActors = new Set<string>();
	readonly #abort = new AbortController();
	readonly #timers: Pick<HostTimers, "setInterval" | "clearInterval">;
	readonly #commands: AgoraCommands;
	#me: AgoraActor | undefined;
	#stopped: Promise<void> | undefined;

	constructor(deps: AgoraDaemonDeps) {
		this.#deps = deps;
		this.#commands = new AgoraCommands({
			deps,
			host: conv => this.#live.get(conv)?.host,
			active: conv => this.#isActive(conv),
			waitingReason: conv => {
				const queued = this.#queue.find(q => q.conv === conv);
				return queued ? (this.#blocker(queued) ?? "Queued.") : null;
			},
			release: conv => this.#release(conv),
			settled: conv => this.#waitSettled(conv),
			enqueue: (conv, binding, turn) => this.#enqueue(conv, binding, turn),
			isTrusted: author => this.#isTrusted(author),
			say: (conv, body) => this.#say(conv, body),
			setStatus: (conv, status, note) => this.#setStatus(conv, status, note),
		});
		this.#timers = deps.timers ?? {
			setInterval: (fn, ms) => setInterval(fn, ms),
			clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
		};
	}

	/** Follows the event stream until `stop()`. `once`: finish after the first message that reaches a session has settled. */
	async run(options: { once?: boolean } = {}): Promise<void> {
		const { settings, store, client, log } = this.#deps;
		if (settings.allowedUsers.length === 0) {
			throw new Error("agora.allowedUsers is empty: set the Agora usernames that may drive sessions in config.yml");
		}
		try {
			this.#me = await client.me();
			for (const username of settings.allowedUsers) {
				const actor = store.getAllowedActor(username);
				if (actor) this.#trustedActors.add(actor);
			}
			store.pruneSeen();
			log.info("agora: following events", { me: this.#me.username, cursor: store.cursor() });
			for await (const event of client.stream(store.cursor(), EVENT_TYPES, this.#abort.signal)) {
				if (!store.receive(event.id)) continue;
				let dispatched = false;
				try {
					dispatched = await this.#handle(event);
				} catch (error) {
					log.error("agora: event handling failed", { event: event.id, error: String(error) });
				}
				if (options.once && dispatched) {
					await this.#drain();
					break;
				}
			}
		} finally {
			await this.stop();
		}
	}

	/** Stops every host; a conversation with a turn in flight or waiting is told to resend. Idempotent. */
	stop(): Promise<void> {
		this.#stopped ??= this.#shutdown();
		return this.#stopped;
	}

	async #shutdown(): Promise<void> {
		this.#abort.abort();
		const interrupted = new Set<string>();
		for (const [conv, live] of this.#live) if (live.host.busy || live.pending > 0) interrupted.add(conv);
		for (const queued of this.#queue.splice(0)) {
			this.#timers.clearInterval(queued.timer);
			interrupted.add(queued.conv);
		}
		const hosts = [...this.#live.values()].map(live => live.host);
		this.#live.clear();
		await Promise.allSettled([
			...[...interrupted].map(conv => this.#deps.client.setStatus(conv, "failed", RESTART_NOTE)),
			...hosts.map(host => host.stop()),
		]);
	}

	async #drain(): Promise<void> {
		while (this.#queue.length > 0 || [...this.#live.values()].some(live => live.host.busy || live.pending > 0)) {
			await Bun.sleep(250);
		}
	}

	async #handle(event: AgoraEvent): Promise<boolean> {
		switch (event.type) {
			case "chat.message":
				return this.#onMessage(event.data as unknown as ChatMessageEventData);
			case "chat.branched":
				this.onBranched(event);
				return false;
			case "agent.question_answered":
				this.onQuestionAnswered(event);
				return false;
			default:
				return false;
		}
	}

	/** `chat.branched` (a branch made from the UI or by `/branch`): bind the new conversation to its own worktree. */
	protected onBranched(event: AgoraEvent): void {
		this.#commands.onBranched(event);
	}

	/** An Agora question card was answered: resolve the pending question of that conversation. */
	protected onQuestionAnswered(event: AgoraEvent): void {
		const data = event.data as { conversation_id?: string; step_id?: string; answers?: unknown };
		const host = data.conversation_id ? this.#live.get(data.conversation_id)?.host : undefined;
		if (!host?.answerFromAgora || !data.step_id || !Array.isArray(data.answers)) return;
		const answers = data.answers as Array<{ id: string; selected: string[]; custom?: string }>;
		if (!host.answerFromAgora(data.step_id, answers)) {
			this.#deps.log.info("agora: question answer ignored", { event: event.id, step: data.step_id });
		}
	}

	async #say(conv: string, body: string): Promise<void> {
		try {
			await this.#deps.client.postMessage(conv, { body });
		} catch (error) {
			this.#deps.log.warn("agora: reply failed", { conversation: conv, error: String(error) });
		}
	}

	async #setStatus(conv: string, status: "working" | "idle" | "failed", note?: string): Promise<void> {
		try {
			await this.#deps.client.setStatus(conv, status, note);
		} catch (error) {
			this.#deps.log.warn("agora: status failed", { conversation: conv, error: String(error) });
		}
	}

	/** Allowlisted by username and, once pinned, by the same actor id. */
	#isTrusted(author: AgoraActor): boolean {
		const { settings, store } = this.#deps;
		if (!settings.allowedUsers.includes(author.username)) return false;
		if (store.pinAllowedActor(author.username, author.id) !== author.id) return false;
		this.#trustedActors.add(author.id);
		return true;
	}

	async #onMessage(data: ChatMessageEventData): Promise<boolean> {
		const { client, store, settings } = this.#deps;
		const msg = data.message;
		const author = msg.author;
		if (!author || author.id === this.#me?.id || author.kind !== "human") return false;
		const conv = msg.conversation_id;
		const title = data.conversation?.title;
		if (title) this.#titles.set(conv, title);

		if (!this.#isTrusted(author)) {
			if (!store.hasRefused(conv)) {
				store.addRefused(conv);
				await this.#say(conv, REFUSAL);
			}
			return false;
		}

		const setup = this.#commands.setupOf(conv);
		if (setup) {
			// The branch is still being prepared (it may wait for its parent): never block the event loop on it.
			void setup
				.then(() => this.#onMessage(data))
				.catch(error => {
					this.#deps.log.error("agora: event handling failed", { message: msg.id, error: String(error) });
				});
			return false;
		}

		const binding = await this.#bindingFor(conv, msg, author);
		if (!binding) return false;
		if (binding.closed_at) {
			await this.#say(conv, "This conversation is closed. Start a new one to keep working.");
			return false;
		}
		if (await this.handleCommand(binding, msg)) return false;
		// A pending question takes the next message as its answer, not as a new turn.
		const host = this.#live.get(conv)?.host;
		if (host?.pendingQuestion?.() && host.answerFromText?.(msg.body, author.id)) return false;

		let turn: HostTurn;
		try {
			turn = await toInboundTurn(msg, data.history ?? [], {
				download: (url, dest, maxBytes) => client.download(url, dest, maxBytes),
				inboxDir: path.join(binding.session_dir, "inbox", msg.id),
				maxBytes: settings.maxAttachmentMB * 1024 * 1024,
				isAllowed: actorId => this.#trustedActors.has(actorId),
			});
		} catch (error) {
			this.#deps.log.warn("agora: could not read message", { message: msg.id, error: String(error) });
			await this.#say(conv, "I couldn't read that message. Try sending it again.");
			return false;
		}
		const prefix = await this.#branchPrefix(conv, binding);
		if (prefix) turn = { ...turn, text: prefix + turn.text };
		this.#enqueue(conv, binding, turn);
		return true;
	}

	/** The conversation's binding, creating a main-checkout one on first contact; `null` = a reply was sent instead. */
	async #bindingFor(conv: string, msg: AgoraChatMessage, author: AgoraActor): Promise<AgoraBinding | null> {
		const { store, settings, agentDir, now = Date.now } = this.#deps;
		const existing = store.getBinding(conv);
		if (existing) return existing;

		const names = Object.keys(settings.repos);
		const chosen = /^\/repo\s+(\S+)/i.exec(msg.body.trim())?.[1];
		let repo = chosen && settings.repos[chosen] ? chosen : undefined;
		if (!repo) {
			const fallback = settings.defaultRepo || (names.length === 1 ? names[0] : "");
			if (fallback && settings.repos[fallback]) repo = fallback;
		}
		if (!repo) {
			await this.#say(
				conv,
				names.length === 0
					? "No repositories are set up on this machine yet. Ask the owner to add one."
					: `Which repository should I work in? Reply with /repo <name>. Available: ${names.join(", ")}`,
			);
			return null;
		}
		const binding: AgoraBinding = {
			conversation_id: conv,
			repo,
			kind: "main",
			cwd: settings.repos[repo],
			session_dir: path.join(agentDir, "agora", "sessions", conv),
			worktree: null,
			forked_from: null,
			parent_conversation_id: null,
			created_by: author.id,
			created_at: new Date(now()).toISOString(),
			closed_at: null,
		};
		store.putBinding(binding);
		if (chosen === repo) {
			await this.#say(conv, `Working in ${repo}. Send your request.`);
			return null;
		}
		return binding;
	}

	/**
	 * A branch's first turn into a fresh session (no transcript, no `--fork`) carries its parent chat up to the branch
	 * point, so the agent has the context the reader sees. Empty when not applicable or on any fetch failure.
	 */
	async #branchPrefix(conv: string, binding: AgoraBinding): Promise<string> {
		if (binding.forked_from || this.#seeded.has(conv) || hasTranscript(binding.session_dir)) return "";
		const { client, log } = this.#deps;
		try {
			const self = await client.getConversation(conv);
			if (!self.parent_id) {
				this.#seeded.add(conv);
				return "";
			}
			const messages: AgoraChatMessage[] = [];
			let before: string | undefined;
			for (let page = 0; page < MAX_PARENT_PAGES; page++) {
				const res = await client.listMessages(self.parent_id, { limit: PARENT_PAGE_SIZE, before });
				messages.unshift(...res.messages);
				if (!self.branch_from_message_id || res.messages.some(m => m.id === self.branch_from_message_id)) break;
				if (!res.next_before) break;
				before = res.next_before;
			}
			let upto = messages;
			if (self.branch_from_message_id) {
				const at = messages.findIndex(m => m.id === self.branch_from_message_id);
				if (at < 0) {
					log.warn("agora: branch point not in parent history", { conversation: conv, parent: self.parent_id });
					return "";
				}
				upto = messages.slice(0, at + 1);
			}
			this.#seeded.add(conv);
			return this.#renderParent(self.title, upto);
		} catch (error) {
			log.warn("agora: could not load parent chat", { conversation: conv, error: String(error) });
			return "";
		}
	}

	/** Newest messages that fit `MAX_PARENT_CHARS`, oldest first; text from people off the allowlist is quoted as untrusted. */
	#renderParent(title: string | null, messages: AgoraChatMessage[]): string {
		const lines: string[] = [];
		let total = 0;
		let omitted = false;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			const body = m.body.trim();
			if (!body) continue;
			const name = m.author?.username ?? "unknown";
			const text = clip(body, MAX_PARENT_MESSAGE);
			const trusted = m.author !== null && (m.author.kind === "agent" || this.#trustedActors.has(m.author.id));
			const line = trusted ? `@${name}: ${text}` : `@${name}:\n${quoted(text)}`;
			if (total + line.length > MAX_PARENT_CHARS) {
				omitted = true;
				break;
			}
			total += line.length;
			lines.unshift(line);
		}
		if (lines.length === 0) return "";
		const head = `This chat is a branch of "${clip((title ?? "untitled").replace(/\s+/g, " "), MAX_TITLE)}". The parent chat up to the branch point:`;
		return `${head}\n${omitted ? "[earlier messages omitted]\n" : ""}${lines.join("\n")}\n\n`;
	}

	/** Chat commands (see `commands.ts`). Returns true when the message was consumed; any other `/word` goes to the session. */
	handleCommand(binding: AgoraBinding, msg: AgoraChatMessage): Promise<boolean> {
		return this.#commands.handle(binding, msg);
	}

	/** A turn is running, being handed to the host, or queued. */
	#isActive(conv: string): boolean {
		const live = this.#live.get(conv);
		return Boolean(live && (live.host.busy || live.pending > 0)) || this.#queue.some(q => q.conv === conv);
	}

	async #waitSettled(conv: string): Promise<void> {
		while (this.#isActive(conv) && !this.#abort.signal.aborted) await Bun.sleep(SETTLE_POLL_MS);
	}

	async #release(conv: string): Promise<void> {
		const live = this.#live.get(conv);
		if (!live) return;
		this.#live.delete(conv);
		await live.host.stop();
		this.#pump();
	}

	/** Why `queued` cannot dispatch yet, or `null`. */
	#blocker(queued: Queued): string | null {
		const { settings } = this.#deps;
		const { conv, binding } = queued;
		if (binding.kind === "main") {
			for (const [other, live] of this.#live) {
				if (other === conv || live.binding.kind !== "main" || live.binding.repo !== binding.repo) continue;
				if (live.host.busy || live.pending > 0) {
					const title = clip(this.#titles.get(other) ?? "another chat", MAX_TITLE);
					return `Waiting for "${title}" to finish`;
				}
			}
		}
		if (!this.#live.has(conv) && this.#live.size >= settings.maxSessions && !this.#idleVictim()) {
			return "Waiting for a free session";
		}
		return null;
	}

	#idleVictim(): string | undefined {
		for (const [conv, live] of this.#live) if (!live.host.busy && live.pending === 0) return conv;
		return undefined;
	}

	#enqueue(conv: string, binding: AgoraBinding, turn: HostTurn): void {
		const queued: Queued = { conv, binding, turn, timer: undefined };
		this.#queue.push(queued);
		this.#pump();
		if (!this.#queue.includes(queued)) return;
		const announce = () => {
			this.#pump();
			if (!this.#queue.includes(queued)) return;
			void this.#setStatus(conv, "working", this.#blocker(queued) ?? undefined);
		};
		queued.timer = this.#timers.setInterval(announce, WAIT_NOTE_MS);
		void this.#setStatus(conv, "working", this.#blocker(queued) ?? undefined);
	}

	/** Dispatches every queued turn that is no longer blocked, oldest first; a conversation's turns never overtake each other. */
	#pump(): void {
		const blocked = new Set<string>();
		for (const queued of [...this.#queue]) {
			if (blocked.has(queued.conv) || this.#blocker(queued)) {
				blocked.add(queued.conv);
				continue;
			}
			this.#queue.splice(this.#queue.indexOf(queued), 1);
			this.#timers.clearInterval(queued.timer);
			this.#dispatch(queued);
		}
	}

	#dispatch({ conv, binding, turn }: Queued): void {
		let live = this.#live.get(conv);
		if (!live) {
			const victim = this.#live.size >= this.#deps.settings.maxSessions ? this.#idleVictim() : undefined;
			if (victim) {
				const evicted = this.#live.get(victim);
				this.#live.delete(victim);
				void evicted?.host
					.stop()
					.catch(error => this.#deps.log.warn("agora: stop failed", { error: String(error) }));
			}
			live = { host: this.#createHost(conv, binding), binding, pending: 0, tail: Promise.resolve() };
			this.#live.set(conv, live);
		}
		const entry = live;
		entry.pending++;
		entry.tail = entry.tail
			.then(() => entry.host.send(turn))
			.catch(error => {
				this.#deps.log.warn("agora: send failed", { conversation: conv, error: String(error) });
				return this.#setStatus(conv, "failed", "Couldn't start the session. Send your message again.");
			})
			.finally(() => {
				entry.pending--;
				this.#pump();
			});
	}

	#createHost(conv: string, binding: AgoraBinding): DaemonHost {
		const { client, store, settings } = this.#deps;
		const host: DaemonHost = this.#deps.createHost({
			conversationId: conv,
			cwd: binding.cwd,
			sessionDir: binding.session_dir,
			forkFrom: binding.forked_from && !hasTranscript(binding.session_dir) ? binding.forked_from : undefined,
			client: client as AgoraClient,
			store: {
				postedHas: (c, entryId) => store.hasPosted(c, entryId),
				postedAdd: (c, entryId, messageId) => store.addPosted(c, entryId, messageId),
			},
			idleMs: settings.idleMinutes * 60_000,
			onSettled: () => this.#pump(),
			onIdle: () => this.#retire(conv, host),
		});
		return host;
	}

	#retire(conv: string, host: DaemonHost): void {
		const live = this.#live.get(conv);
		if (!live || live.host !== host || host.busy || live.pending > 0) return;
		this.#live.delete(conv);
		void host.stop().catch(error => this.#deps.log.warn("agora: stop failed", { error: String(error) }));
		this.#pump();
	}
}
