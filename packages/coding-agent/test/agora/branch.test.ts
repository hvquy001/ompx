import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgoraEvent } from "../../src/agora/client";
import { AgoraDaemon, type DaemonHost } from "../../src/agora/daemon";
import type { SessionHostOptions } from "../../src/agora/session-host";
import { AgoraStore } from "../../src/agora/store";

const ME = { id: "me", username: "ompx", kind: "agent" as const };
const alice = { id: "u-alice", username: "alice", kind: "human" as const };
const mallory = { id: "u-mallory", username: "mallory", kind: "human" as const };

class FakeHost implements DaemonHost {
	busy = false;
	sent: string[] = [];
	stopped = false;
	constructor(
		readonly options: SessionHostOptions,
		readonly sessionFile: string | undefined,
	) {}
	async send(turn: { text: string }) {
		this.sent.push(turn.text);
		this.busy = true;
	}
	async steer() {}
	async abort() {}
	async stop() {
		this.stopped = true;
		this.busy = false;
	}
	settle() {
		this.busy = false;
		this.options.onSettled?.();
	}
}

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 3000; i++) {
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`timed out waiting for ${what}`);
}

interface Harness {
	daemon: AgoraDaemon;
	store: AgoraStore;
	repo: string;
	agentDir: string;
	posts: Array<{ conv: string; body: string }>;
	statuses: Array<{ conv: string; status: string; note?: string }>;
	branchCalls: Array<{ conv: string; input: Record<string, unknown> }>;
	patches: Array<{ conv: string; patch: Record<string, unknown> }>;
	hosts: Map<string, FakeHost>;
	feed(event: AgoraEvent): void;
	running: Promise<void>;
}

let tmp: string;
let current: Harness | undefined;
let eventSeq = 5000;
const savedWorktreeDir = process.env.OMP_WORKTREE_DIR;

function setup(): Harness {
	const repo = path.join(tmp, "repo");
	fs.mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");

	const agentDir = path.join(tmp, "agent");
	const queue: AgoraEvent[] = [];
	let wake: (() => void) | undefined;
	const posts: Harness["posts"] = [];
	const statuses: Harness["statuses"] = [];
	const branchCalls: Harness["branchCalls"] = [];
	const patches: Harness["patches"] = [];
	const hosts = new Map<string, FakeHost>();
	const store = new AgoraStore(":memory:");
	const client = {
		me: async () => ME,
		postMessage: async (conv: string, msg: { body: string }) => {
			posts.push({ conv, body: msg.body });
			return { id: `m${posts.length}` };
		},
		setStatus: async (conv: string, status: string, note?: string) => {
			statuses.push({ conv, status, note });
		},
		download: async () => {},
		branch: async (conv: string, input: Record<string, unknown>) => {
			branchCalls.push({ conv, input });
			return { id: `branch-${branchCalls.length}` };
		},
		patchConversation: async (conv: string, patch: Record<string, unknown>) => {
			patches.push({ conv, patch });
		},
		createConversation: async () => ({ id: "created" }),
		async *stream(_since: number | null, _types: string[], signal: AbortSignal) {
			while (!signal.aborted) {
				const next = queue.shift();
				if (next) yield next;
				else
					await new Promise<void>(resolve => {
						wake = resolve;
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
			}
		},
	};
	const daemon = new AgoraDaemon({
		client: client as never,
		store,
		settings: {
			repos: { app: repo },
			defaultRepo: "app",
			allowedUsers: ["alice"],
			maxSessions: 4,
			idleMinutes: 30,
			maxAttachmentMB: 25,
		},
		createHost: options => {
			const host = new FakeHost(options, hosts.size === 0 ? path.join(tmp, "parent-session.jsonl") : undefined);
			hosts.set(options.conversationId, host);
			return host;
		},
		agentDir,
		log: { info() {}, warn() {}, error() {} },
	});
	const running = daemon.run();
	return {
		daemon,
		store,
		repo,
		agentDir,
		posts,
		statuses,
		branchCalls,
		patches,
		hosts,
		running,
		feed: event => {
			queue.push(event);
			wake?.();
		},
	};
}

function chat(conv: string, body: string, author = alice): AgoraEvent {
	const id = ++eventSeq;
	return {
		id,
		type: "chat.message",
		data: {
			conversation: { id: conv, title: `chat ${conv}` },
			message: {
				id: `msg-${id}`,
				conversation_id: conv,
				author,
				body,
				reply_to_id: null,
				context: null,
				attachments: [],
				created_at: null,
			},
			history: [],
		},
	};
}

function branched(conv: string, parent: string, title: string, by = alice): AgoraEvent {
	return {
		id: ++eventSeq,
		type: "chat.branched",
		data: {
			conversation: { id: conv, title, url: `http://agora/${conv}` },
			parent: { id: parent, title: `chat ${parent}` },
			from_message_id: null,
			by,
		},
	};
}

/** The parent conversation with one finished turn, so it has a live host with a session file. */
async function startParent(t: Harness): Promise<FakeHost> {
	t.feed(chat("c1", "hello"));
	await until(() => (t.hosts.get("c1")?.sent.length ?? 0) === 1, "parent turn");
	const host = t.hosts.get("c1")!;
	host.settle();
	return host;
}

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agora-branch-")));
	process.env.OMP_WORKTREE_DIR = path.join(tmp, "wt");
});

afterEach(async () => {
	await current?.daemon.stop();
	await current?.running.catch(() => {});
	current?.store.close();
	current = undefined;
	if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
	else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("agora branching", () => {
	it("/branch creates a worktree branch, binds the conversation, forks the transcript once and labels it", async () => {
		const t = (current = setup());
		await startParent(t);

		t.feed(chat("c1", "/branch fix-login check the form"));
		await until(() => t.branchCalls.length === 1, "client.branch");
		expect(t.branchCalls[0].conv).toBe("c1");
		expect(t.branchCalls[0].input).toMatchObject({
			title: "ompx · agora/fix-login",
			message: { body: "check the form" },
		});
		// Agora then announces the new conversation; the command and the event share one setup.
		t.feed(branched("branch-1", "c1", "ompx · agora/fix-login"));
		await until(() => t.store.getBinding("branch-1") !== null && t.patches.length === 1, "branch binding");

		const binding = t.store.getBinding("branch-1")!;
		expect(binding.kind).toBe("worktree");
		expect(binding.parent_conversation_id).toBe("c1");
		expect(binding.forked_from).toBe(path.join(tmp, "parent-session.jsonl"));
		expect(git(t.repo, "branch", "--list", "agora/fix-login")).toContain("agora/fix-login");
		expect(fs.realpathSync(binding.cwd)).toBe(binding.cwd);
		expect(git(binding.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agora/fix-login");
		expect(t.patches[0]).toEqual({ conv: "branch-1", patch: { branch_label: "agora/fix-login" } });
		const head = git(t.repo, "rev-parse", "HEAD").slice(0, 7);
		expect(t.posts.find(p => p.conv === "branch-1")?.body).toBe(
			`Working in branch agora/fix-login at ${binding.cwd} (from ${head}).`,
		);

		// The task ran in the worktree with a forked first spawn.
		await until(() => (t.hosts.get("branch-1")?.sent.length ?? 0) === 1, "task turn");
		const first = t.hosts.get("branch-1")!;
		expect(first.sent[0]).toContain("check the form");
		expect(first.options.cwd).toBe(binding.cwd);
		expect(first.options.forkFrom).toBe(binding.forked_from!);

		// After the session has its own transcript, a respawn uses --continue: no fork.
		fs.mkdirSync(binding.session_dir, { recursive: true });
		fs.writeFileSync(path.join(binding.session_dir, "s.jsonl"), "{}\n");
		first.settle();
		first.options.onIdle();
		t.feed(chat("branch-1", "and then?"));
		await until(() => t.hosts.get("branch-1") !== first, "respawn");
		const second = t.hosts.get("branch-1")!;
		await until(() => second.sent.length === 1, "second turn");
		expect(second.options.forkFrom).toBeUndefined();
		expect(second.options.cwd).toBe(binding.cwd);
	});

	it("names a UI branch from the title and suffixes a taken branch name", async () => {
		const t = (current = setup());
		await startParent(t);
		git(t.repo, "branch", "agora/try-this");

		t.feed(branched("ui-1", "c1", "Try this!"));
		await until(() => t.store.getBinding("ui-1") !== null, "ui binding");
		const name = t.store.getBinding("ui-1")!;
		const label = t.patches.find(p => p.conv === "ui-1")?.patch.branch_label as string;
		expect(label).toMatch(/^agora\/try-this-\d{8}-\d{4}$/);
		expect(git(name.cwd, "rev-parse", "--abbrev-ref", "HEAD")).toBe(label);

		t.feed(branched("ui-2", "c1", "ompx · agora/same"));
		t.feed(branched("ui-3", "c1", "ompx · agora/same"));
		await until(() => t.patches.filter(p => p.conv !== "ui-1").length === 2, "suffix");
		const labels = t.patches.filter(p => p.conv !== "ui-1").map(p => p.patch.branch_label);
		expect(labels.sort()).toEqual(["agora/same", "agora/same-2"]);
	});

	it("waits for a busy parent to settle before branching", async () => {
		const t = (current = setup());
		t.feed(chat("c1", "long task"));
		await until(() => (t.hosts.get("c1")?.sent.length ?? 0) === 1, "parent turn");
		const parent = t.hosts.get("c1")!;
		expect(parent.busy).toBe(true);

		t.feed(branched("ui-1", "c1", "later"));
		await until(() => t.statuses.some(s => s.conv === "ui-1" && s.status === "working"), "working note");
		expect(t.statuses.find(s => s.conv === "ui-1")?.note).toBe("Branching after the current turn finishes");
		expect(t.store.getBinding("ui-1")).toBeNull();

		parent.settle();
		await until(() => t.store.getBinding("ui-1") !== null, "binding after settle");
		expect(t.statuses.at(-1)).toMatchObject({ conv: "ui-1", status: "idle" });
	});

	it("refuses a /branch name that is not a safe branch name", async () => {
		const t = (current = setup());
		await startParent(t);
		t.feed(chat("c1", "/branch ../x"));
		await until(() => t.posts.some(p => p.body.startsWith("Usage: /branch")), "usage reply");
		expect(t.branchCalls).toHaveLength(0);
		expect(git(t.repo, "branch", "--list")).not.toContain("x");
	});

	it("/close keeps a dirty worktree and says why, and removes a clean one", async () => {
		const t = (current = setup());
		await startParent(t);
		t.feed(chat("c1", "/branch dirty"));
		await until(() => t.store.getBinding("branch-1") !== null, "first branch");
		t.feed(chat("c1", "/branch clean"));
		await until(() => t.store.getBinding("branch-2") !== null, "second branch");
		const dirty = t.store.getBinding("branch-1")!;
		const clean = t.store.getBinding("branch-2")!;
		fs.writeFileSync(path.join(dirty.cwd, "wip.txt"), "work in progress\n");

		t.feed(chat("branch-1", "/close"));
		await until(() => t.store.getBinding("branch-1")?.closed_at != null, "dirty closed");
		expect(fs.existsSync(dirty.cwd)).toBe(true);
		const kept = t.posts.filter(p => p.conv === "branch-1").at(-1)!.body;
		expect(kept).toContain(dirty.cwd);
		expect(kept).toContain("uncommitted changes");
		expect(git(t.repo, "branch", "--list", "agora/dirty")).toContain("agora/dirty");

		t.feed(chat("branch-2", "/close"));
		await until(() => t.store.getBinding("branch-2")?.closed_at != null, "clean closed");
		expect(fs.existsSync(clean.cwd)).toBe(false);
		expect(git(t.repo, "branch", "--list", "agora/clean")).toBe("");
		expect(t.posts.filter(p => p.conv === "branch-2").at(-1)!.body).toContain("Removed");
	});

	it("ignores chat.branched from an actor who is not allowlisted", async () => {
		const t = (current = setup());
		await startParent(t);
		t.feed(branched("evil-1", "c1", "x", mallory));
		t.feed(chat("c1", "/help"));
		await until(() => t.posts.some(p => p.body.startsWith("Commands:")), "later event handled");
		expect(t.store.getBinding("evil-1")).toBeNull();
		expect(git(t.repo, "worktree", "list")).not.toContain("agora/");
	});
});
