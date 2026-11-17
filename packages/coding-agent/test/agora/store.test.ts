import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgoraBinding, AgoraStore } from "../../src/agora/store";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function binding(over: Partial<AgoraBinding> = {}): AgoraBinding {
	return {
		conversation_id: "c1",
		repo: "agora",
		kind: "main",
		cwd: "/repo",
		session_dir: "/s/c1",
		worktree: null,
		forked_from: null,
		parent_conversation_id: null,
		created_by: "u1",
		created_at: "2026-11-17T00:00:00Z",
		closed_at: null,
		...over,
	};
}

describe("AgoraStore", () => {
	test("receive accepts an event once and rejects a replayed id", () => {
		const store = new AgoraStore(":memory:");
		expect(store.cursor()).toBeNull();
		expect(store.receive(5)).toBe(true);
		expect(store.receive(5)).toBe(false);
		expect(store.cursor()).toBe(5);
	});

	test("the cursor never moves backwards and pruneSeen keeps the replay guard at the cursor", () => {
		const store = new AgoraStore(":memory:");
		store.receive(10);
		store.receive(7);
		expect(store.cursor()).toBe(10);
		store.pruneSeen();
		expect(store.receive(10)).toBe(false);
	});

	test("state survives reopening the file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-agora-store-"));
		dirs.push(dir);
		const file = path.join(dir, "nested", "state.db");
		const first = new AgoraStore(file);
		first.receive(3);
		first.putBinding(binding());
		first.close();
		const second = new AgoraStore(file);
		expect(second.cursor()).toBe(3);
		expect(second.receive(3)).toBe(false);
		expect(second.getBinding("c1")?.cwd).toBe("/repo");
		second.close();
	});

	test("bindings: put, get, replace, close, list", () => {
		const store = new AgoraStore(":memory:");
		expect(store.getBinding("c1")).toBeNull();
		store.putBinding(binding());
		store.putBinding(
			binding({
				conversation_id: "c2",
				kind: "worktree",
				worktree: '{"path":"/wt"}',
				parent_conversation_id: "c1",
				created_at: "2026-11-17T01:00:00Z",
			}),
		);
		expect(store.getBinding("c2")).toMatchObject({ kind: "worktree", parent_conversation_id: "c1", closed_at: null });
		store.closeBinding("c2", "2026-11-17T02:00:00Z");
		expect(store.getBinding("c2")?.closed_at).toBe("2026-11-17T02:00:00Z");
		expect(store.listBindings().map(b => b.conversation_id)).toEqual(["c1", "c2"]);
		store.putBinding(binding({ repo: "other" }));
		expect(store.getBinding("c1")?.repo).toBe("other");
	});

	test("kind is constrained to main or worktree", () => {
		const store = new AgoraStore(":memory:");
		expect(() => store.putBinding(binding({ kind: "bogus" as AgoraBinding["kind"] }))).toThrow();
	});

	test("allowed actor pins the first actor id and never replaces it", () => {
		const store = new AgoraStore(":memory:");
		expect(store.getAllowedActor("alice")).toBeNull();
		expect(store.pinAllowedActor("alice", "u1")).toBe("u1");
		expect(store.pinAllowedActor("alice", "u2")).toBe("u1");
		expect(store.getAllowedActor("alice")).toBe("u1");
	});

	test("refused and posted are idempotent sets", () => {
		const store = new AgoraStore(":memory:");
		expect(store.hasRefused("c1")).toBe(false);
		store.addRefused("c1");
		store.addRefused("c1");
		expect(store.hasRefused("c1")).toBe(true);

		expect(store.hasPosted("c1", "e1")).toBe(false);
		store.addPosted("c1", "e1", "m1");
		store.addPosted("c1", "e1", "m2");
		expect(store.hasPosted("c1", "e1")).toBe(true);
		expect(store.hasPosted("c2", "e1")).toBe(false);
	});
});
