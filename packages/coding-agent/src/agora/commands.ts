/**
 * Chat commands (`/branch`, `/new`, `/status`, `/repo`, `/stop`, `/steer`, `/close`, `/help`) and the worktree
 * branching that both `/branch` and a UI branch (`chat.branched`) go through.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { Settings } from "../config/settings";
import {
	createSessionWorktree,
	inspectSessionWorktree,
	removeSessionWorktree,
	type SessionWorktree,
} from "../session/session-worktree";
import type { AgoraActor, AgoraChatMessage, AgoraEvent } from "./client";
import type { AgoraDaemonDeps, DaemonHost } from "./daemon";
import type { HostTurn } from "./session-host";
import type { AgoraBinding } from "./store";

const TITLE_NAME_RE = /^ompx · agora\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SLUG = 40;
const MAX_BRANCH_SUFFIX = 99;

const HELP = [
	"Commands:",
	"/branch [name] [task] - continue in a new conversation with its own git branch and folder",
	"/new - start a fresh session in this folder (the old transcript is kept)",
	"/status - where I am working and what I am doing",
	"/repo <name> - switch an idle conversation to another repository",
	"/stop - stop the running task",
	"/steer <text> - change course while a task runs",
	"/close - finish a branch conversation; its folder is removed when it has no changes",
	"/help - this list",
].join("\n");

/** What the commands need from the daemon. */
export interface CommandEnv {
	readonly deps: AgoraDaemonDeps;
	host(conv: string): DaemonHost | undefined;
	/** A turn is running or still being handed to the host. */
	active(conv: string): boolean;
	/** Why the conversation's queued turn cannot run yet, if one is queued. */
	waitingReason(conv: string): string | null;
	/** Forgets and stops the conversation's host. */
	release(conv: string): Promise<void>;
	/** Resolves once `conv` has no running turn (or the daemon stopped). */
	settled(conv: string): Promise<void>;
	enqueue(conv: string, binding: AgoraBinding, turn: HostTurn): void;
	isTrusted(author: AgoraActor): boolean;
	say(conv: string, body: string): Promise<void>;
	setStatus(conv: string, status: "working" | "idle" | "failed", note?: string): Promise<void>;
}

interface BranchedData {
	conversation: { id: string; title?: string | null; url?: string };
	parent: { id: string; title?: string | null };
	by?: AgoraActor;
}

interface BranchJob {
	conv: string;
	title: string;
	parent: string;
	by: AgoraActor;
	/** Branch name without the `agora/` prefix; derived from the title when unset. */
	name?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function stamp(ms: number): string {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

function slug(title: string): string {
	const s = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_SLUG)
		.replace(/-+$/g, "");
	return s || "branch";
}

/** Newest transcript in `dir`, for a parent whose host was retired. */
function newestTranscript(dir: string | undefined): string | undefined {
	if (!dir) return undefined;
	try {
		const files = fs
			.readdirSync(dir)
			.filter(name => name.endsWith(".jsonl"))
			.map(name => ({ file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }));
		return files.sort((a, b) => b.mtime - a.mtime)[0]?.file;
	} catch {
		return undefined;
	}
}

function worktreeOf(binding: AgoraBinding): SessionWorktree | null {
	return binding.worktree ? (JSON.parse(binding.worktree) as SessionWorktree) : null;
}

export class AgoraCommands {
	readonly #env: CommandEnv;
	readonly #setups = new Map<string, Promise<void>>();
	#gitTurn: Promise<void> = Promise.resolve();

	constructor(env: CommandEnv) {
		this.#env = env;
	}

	/** In-flight branch setup for `conv`; messages for it wait on this. */
	setupOf(conv: string): Promise<void> | undefined {
		return this.#setups.get(conv);
	}

	/** Returns true when the message was a daemon command; any other `/word` is left for the session. */
	async handle(binding: AgoraBinding, msg: AgoraChatMessage): Promise<boolean> {
		const conv = binding.conversation_id;
		const [word = "", ...rest] = msg.body.trim().split(/\s+/);
		const arg = rest.join(" ");
		switch (word.toLowerCase()) {
			case "/stop":
				return this.#stop(conv);
			case "/steer":
				return this.#steer(conv, arg);
			case "/status":
				await this.#env.say(conv, await this.#statusText(binding));
				return true;
			case "/repo":
				await this.#rebind(binding, arg);
				return true;
			case "/new":
				await this.#newSession(binding);
				return true;
			case "/close":
				await this.#close(binding);
				return true;
			case "/branch":
				await this.#branchCommand(binding, msg, arg);
				return true;
			case "/help":
				await this.#env.say(conv, HELP);
				return true;
			default:
				return false;
		}
	}

	async #stop(conv: string): Promise<boolean> {
		const host = this.#env.host(conv);
		if (host?.busy) {
			await host.abort();
			await this.#env.say(conv, "Stopping the current task.");
		} else {
			await this.#env.say(conv, "Nothing is running.");
		}
		return true;
	}

	async #steer(conv: string, text: string): Promise<boolean> {
		const host = this.#env.host(conv);
		if (!text) await this.#env.say(conv, "Usage: /steer <what to change>");
		else if (host?.busy) await host.steer({ text });
		else await this.#env.say(conv, "Nothing is running to steer. Just send your request.");
		return true;
	}

	async #statusText(binding: AgoraBinding): Promise<string> {
		const conv = binding.conversation_id;
		const waiting = this.#env.waitingReason(conv);
		const activity = waiting ?? (this.#env.active(conv) ? "Working." : "Idle.");
		const lines = [
			`Repo: ${binding.repo} (${binding.kind === "main" ? "main checkout" : "own worktree"})`,
			`Folder: ${binding.cwd}`,
		];
		const wt = worktreeOf(binding);
		if (wt) {
			lines.push(`Branch: ${wt.branch}`);
			try {
				const state = await inspectSessionWorktree(wt);
				const parts = [state.dirty && "uncommitted changes", state.moved && "new commits"].filter(Boolean);
				lines.push(`Changes: ${parts.length > 0 ? parts.join(", ") : "none"}`);
			} catch (error) {
				this.#env.deps.log.warn("agora: worktree inspect failed", { conversation: conv, error: String(error) });
			}
		}
		if (binding.closed_at) lines.push("Closed.");
		lines.push(activity);
		return lines.join("\n");
	}

	async #rebind(binding: AgoraBinding, name: string): Promise<void> {
		const { settings, store } = this.#env.deps;
		const conv = binding.conversation_id;
		const cwd = settings.repos[name];
		if (!cwd) {
			await this.#env.say(
				conv,
				`Usage: /repo <name>. Available: ${Object.keys(settings.repos).join(", ") || "none"}`,
			);
			return;
		}
		if (binding.kind !== "main") {
			await this.#env.say(conv, "This conversation has its own worktree; it stays on its repository.");
			return;
		}
		if (this.#env.active(conv)) {
			await this.#env.say(conv, "A task is running. Send /stop first, then switch repositories.");
			return;
		}
		await this.#env.release(conv);
		store.putBinding({ ...binding, repo: name, cwd });
		await this.#env.say(conv, `Switched to ${name}. Send your request.`);
	}

	/** Moves the transcripts aside (kept in `previous/`) so the next spawn starts a fresh session. */
	async #newSession(binding: AgoraBinding): Promise<void> {
		const conv = binding.conversation_id;
		if (this.#env.active(conv)) {
			await this.#env.say(conv, "A task is running. Send /stop first, then start a new session.");
			return;
		}
		await this.#env.release(conv);
		const dir = binding.session_dir;
		try {
			const transcripts = fs.readdirSync(dir).filter(name => name.endsWith(".jsonl"));
			if (transcripts.length > 0) fs.mkdirSync(path.join(dir, "previous"), { recursive: true });
			for (const name of transcripts) fs.renameSync(path.join(dir, name), path.join(dir, "previous", name));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.#env.deps.log.warn("agora: /new failed", { conversation: conv, error: String(error) });
				await this.#env.say(conv, "I couldn't start a new session. Try again.");
				return;
			}
		}
		// `--fork` applies only to a conversation without a transcript; a fresh session must not re-fork.
		this.#env.deps.store.putBinding({ ...binding, forked_from: null });
		await this.#env.say(conv, "Started a new session. Send your request.");
	}

	async #close(binding: AgoraBinding): Promise<void> {
		const { store, now = Date.now } = this.#env.deps;
		const conv = binding.conversation_id;
		const wt = worktreeOf(binding);
		if (binding.kind !== "worktree" || !wt) {
			await this.#env.say(conv, "Only branch conversations can be closed.");
			return;
		}
		await this.#env.release(conv);
		let outcome: string;
		try {
			const state = await inspectSessionWorktree(wt);
			const why = [
				state.dirty && "it has uncommitted changes",
				state.moved && "its branch has new commits",
				state.offBranch && "it is not on its branch",
			].filter(Boolean);
			if (why.length > 0) {
				outcome = `Kept the folder ${wt.path} on branch ${wt.branch}: ${why.join(" and ")}.`;
			} else {
				await removeSessionWorktree(wt, false);
				outcome = `Removed the folder and branch ${wt.branch}.`;
			}
		} catch (error) {
			this.#env.deps.log.warn("agora: worktree cleanup failed", { conversation: conv, error: String(error) });
			outcome = `Kept the folder ${wt.path} on branch ${wt.branch}: I couldn't remove it.`;
		}
		store.closeBinding(conv, new Date(now()).toISOString());
		await this.#env.say(conv, `Closed this conversation. ${outcome}`);
	}

	async #branchCommand(binding: AgoraBinding, msg: AgoraChatMessage, arg: string): Promise<void> {
		const { client, store, now = Date.now, log } = this.#env.deps;
		const conv = binding.conversation_id;
		const first = arg.split(/\s+/)[0] ?? "";
		if (first && !NAME_RE.test(first)) {
			await this.#env.say(
				conv,
				"Usage: /branch [name] [task]. The name may use letters, digits, '.', '_' and '-' (up to 64 characters).",
			);
			return;
		}
		const name = first || stamp(now());
		const task = arg.slice(first.length).trim();
		const title = `ompx · agora/${name}`;
		try {
			const created = await client.branch(conv, {
				from_message: msg.id,
				title,
				message: task ? { body: task } : undefined,
			});
			const author = msg.author;
			if (!author) return;
			// An older Agora has no branch endpoint: create the conversation ourselves and run the same setup.
			// `chat.branched` may have beaten this response; the setup then already runs and is shared.
			const child = (created ?? (await client.createConversation({ title, participants: [author.username] }))).id;
			if (!this.#setups.has(child) && !store.getBinding(child)) {
				this.#start({ conv: child, title, parent: conv, by: author, name });
			}
			await this.#setups.get(child);
			// The task was posted by this agent, so it never arrives as a human `chat.message`: run it here.
			const bound = store.getBinding(child);
			if (task && bound && !bound.closed_at) {
				this.#env.enqueue(child, bound, { text: `From @${author.username}:\n\n${task}` });
			}
		} catch (error) {
			log.warn("agora: branch failed", { conversation: conv, error: String(error) });
			await this.#env.say(conv, "I couldn't start a branch. Try again in a moment.");
		}
	}

	/** `chat.branched`: bind the new conversation to a worktree branched from the parent. Never blocks the event loop. */
	onBranched(event: AgoraEvent): void {
		const data = event.data as unknown as BranchedData;
		const by = data.by;
		const conv = data.conversation?.id;
		if (!conv || !data.parent?.id || !by || by.kind !== "human" || !this.#env.isTrusted(by)) return;
		if (this.#env.deps.store.getBinding(conv) || this.#setups.has(conv)) return;
		const named = TITLE_NAME_RE.exec(data.conversation.title ?? "")?.[1];
		this.#start({
			conv,
			title: data.conversation.title || data.parent.title || "branch",
			parent: data.parent.id,
			by,
			name: named,
		});
	}

	#start(job: BranchJob): void {
		const setup = this.#setup(job).finally(() => this.#setups.delete(job.conv));
		this.#setups.set(job.conv, setup);
	}

	/** Never rejects; failures are reported in the new conversation. */
	async #setup(job: BranchJob): Promise<void> {
		const { store, settings, client, agentDir, now = Date.now, log } = this.#env.deps;
		const { conv, parent, by } = job;
		let announced = false;
		try {
			const parentBinding = store.getBinding(parent);
			const names = Object.keys(settings.repos);
			const parentRepo = parentBinding?.repo ?? (settings.defaultRepo || (names.length === 1 ? names[0] : ""));
			const parentCwd = parentBinding?.cwd ?? settings.repos[parentRepo];
			if (!parentCwd) {
				await this.#env.say(conv, "I don't know which repository to branch from. Ask the owner to set a default.");
				return;
			}
			if (this.#env.active(parent)) {
				announced = true;
				await this.#env.setStatus(conv, "working", "Branching after the current turn finishes");
				await this.#env.settled(parent);
			}
			const forkFrom = this.#env.host(parent)?.sessionFile ?? newestTranscript(parentBinding?.session_dir) ?? null;
			const base = `agora/${job.name ?? `${slug(job.title)}-${stamp(now())}`}`;
			const settingsForCwd = await (this.#env.deps.settingsFor?.(parentCwd) ?? Settings.isolated());
			// Picking a free name and creating the branch must not interleave with another setup.
			const turn = this.#gitTurn;
			const done = Promise.withResolvers<void>();
			this.#gitTurn = done.promise;
			await turn;
			let wt: SessionWorktree;
			try {
				const branch = await this.#freeBranch(parentCwd, base);
				wt = await createSessionWorktree(parentCwd, settingsForCwd, branch, {
					keepChanges: parentBinding?.kind === "worktree",
				});
			} finally {
				done.resolve();
			}
			const branch = wt.branch;
			const binding: AgoraBinding = {
				conversation_id: conv,
				repo: parentRepo,
				kind: "worktree",
				cwd: wt.path,
				session_dir: path.join(agentDir, "agora", "sessions", conv),
				worktree: JSON.stringify(wt),
				forked_from: forkFrom,
				parent_conversation_id: parent,
				created_by: by.id,
				created_at: new Date(now()).toISOString(),
				closed_at: null,
			};
			store.putBinding(binding);
			try {
				await client.patchConversation(conv, { branch_label: branch });
			} catch (error) {
				log.warn("agora: branch label failed", { conversation: conv, error: String(error) });
			}
			await this.#env.say(conv, `Working in branch ${branch} at ${wt.path} (from ${wt.baseCommit.slice(0, 7)}).`);
		} catch (error) {
			log.error("agora: branch setup failed", { conversation: conv, error: String(error) });
			await this.#env.say(
				conv,
				"I couldn't set up a branch here. Check that the repository is a git checkout with at least one commit, then try /branch again.",
			);
			// A later message must not fall back to a main-checkout binding.
			const cwd = store.getBinding(parent)?.cwd ?? settings.repos[settings.defaultRepo] ?? "";
			store.putBinding({
				conversation_id: conv,
				repo: store.getBinding(parent)?.repo ?? settings.defaultRepo,
				kind: "main",
				cwd,
				session_dir: path.join(agentDir, "agora", "sessions", conv),
				worktree: null,
				forked_from: null,
				parent_conversation_id: parent,
				created_by: by.id,
				created_at: new Date(now()).toISOString(),
				closed_at: new Date(now()).toISOString(),
			});
		} finally {
			if (announced) await this.#env.setStatus(conv, "idle");
		}
	}

	/** `base`, or `base-2`, `base-3`… when the branch exists. */
	async #freeBranch(cwd: string, base: string): Promise<string> {
		const repository = vcs.git(cwd);
		if (!repository) return base;
		for (let n = 1; n <= MAX_BRANCH_SUFFIX; n++) {
			const candidate = n === 1 ? base : `${base}-${n}`;
			if (!(await repository.refExists(`refs/heads/${candidate}`))) return candidate;
		}
		throw new Error(`no free branch name for ${base}`);
	}
}
