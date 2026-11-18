/**
 * Durable state of the Agora chat bridge: event cursor + dedupe, trusted actors, conversation bindings and
 * what was already posted. One SQLite file under the agent dir; WAL.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

const CURSOR_KEY = "events";

export interface AgoraBinding {
	conversation_id: string;
	repo: string;
	kind: "main" | "worktree";
	cwd: string;
	session_dir: string;
	/** JSON `SessionWorktree` when kind = 'worktree'. */
	worktree: string | null;
	/** Source transcript path, used for `--fork` on the first spawn only. */
	forked_from: string | null;
	parent_conversation_id: string | null;
	/** Actor id of the person who created it. */
	created_by: string;
	created_at: string;
	closed_at: string | null;
}

const SCHEMA = `
create table if not exists cursor (k text primary key, event_id integer not null);
create table if not exists seen_event (event_id integer primary key);
create table if not exists allowed_actor (username text primary key, actor_id text not null);
create table if not exists refused (conversation_id text primary key);
create table if not exists binding (
  conversation_id text primary key,
  repo text not null,
  kind text not null check (kind in ('main','worktree')),
  cwd text not null,
  session_dir text not null,
  worktree text,
  forked_from text,
  parent_conversation_id text,
  created_by text not null,
  created_at text not null,
  closed_at text
);
create table if not exists posted (conversation_id text, entry_id text, message_id text, primary key (conversation_id, entry_id));
`;

/** One store per Agora workspace a daemon serves; the default (`trdo`-era) file keeps its name. */
export function defaultAgoraStorePath(workspace?: string): string {
	return path.join(getAgentDir(), "agora", workspace ? `state-${workspace}.db` : "state.db");
}

export class AgoraStore {
	readonly #db: Database;

	constructor(dbPath: string = defaultAgoraStorePath()) {
		if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		this.#db = new Database(dbPath);
		this.#db.exec("PRAGMA busy_timeout = 5000");
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec(SCHEMA);
	}

	close(): void {
		this.#db.close();
	}

	/** Records `eventId` as seen and advances the cursor in one transaction. `false` = replay, do not dispatch. */
	receive(eventId: number): boolean {
		return this.#db.transaction(() => {
			const { changes } = this.#db.query("insert or ignore into seen_event (event_id) values (?)").run(eventId);
			if (changes === 0) return false;
			this.#db
				.query(
					"insert into cursor (k, event_id) values (?, ?) on conflict(k) do update set event_id = max(event_id, excluded.event_id)",
				)
				.run(CURSOR_KEY, eventId);
			return true;
		})();
	}

	/** Last event received, or `null` on first run. */
	cursor(): number | null {
		const row = this.#db.query("select event_id from cursor where k = ?").get(CURSOR_KEY) as {
			event_id: number;
		} | null;
		return row?.event_id ?? null;
	}

	/** Drops seen-event rows at or below the cursor: the stream never resends them. */
	pruneSeen(): void {
		this.#db
			.query("delete from seen_event where event_id < (select event_id from cursor where k = ?)")
			.run(CURSOR_KEY);
	}

	getBinding(conversationId: string): AgoraBinding | null {
		return this.#db
			.query("select * from binding where conversation_id = ?")
			.get(conversationId) as AgoraBinding | null;
	}

	putBinding(binding: AgoraBinding): void {
		this.#db
			.query(
				`insert or replace into binding (conversation_id, repo, kind, cwd, session_dir, worktree, forked_from, parent_conversation_id, created_by, created_at, closed_at)
				values ($conversation_id, $repo, $kind, $cwd, $session_dir, $worktree, $forked_from, $parent_conversation_id, $created_by, $created_at, $closed_at)`,
			)
			.run({
				$conversation_id: binding.conversation_id,
				$repo: binding.repo,
				$kind: binding.kind,
				$cwd: binding.cwd,
				$session_dir: binding.session_dir,
				$worktree: binding.worktree,
				$forked_from: binding.forked_from,
				$parent_conversation_id: binding.parent_conversation_id,
				$created_by: binding.created_by,
				$created_at: binding.created_at,
				$closed_at: binding.closed_at,
			});
	}

	closeBinding(conversationId: string, at: string): void {
		this.#db.query("update binding set closed_at = ? where conversation_id = ?").run(at, conversationId);
	}

	listBindings(): AgoraBinding[] {
		return this.#db.query("select * from binding order by created_at").all() as AgoraBinding[];
	}

	getAllowedActor(username: string): string | null {
		const row = this.#db.query("select actor_id from allowed_actor where username = ?").get(username) as {
			actor_id: string;
		} | null;
		return row?.actor_id ?? null;
	}

	/** First writer wins: an existing pin is never replaced. Returns the pinned actor id. */
	pinAllowedActor(username: string, actorId: string): string {
		this.#db.query("insert or ignore into allowed_actor (username, actor_id) values (?, ?)").run(username, actorId);
		return this.getAllowedActor(username) ?? actorId;
	}

	hasRefused(conversationId: string): boolean {
		return this.#db.query("select 1 from refused where conversation_id = ?").get(conversationId) !== null;
	}

	addRefused(conversationId: string): void {
		this.#db.query("insert or ignore into refused (conversation_id) values (?)").run(conversationId);
	}

	hasPosted(conversationId: string, entryId: string): boolean {
		return (
			this.#db
				.query("select 1 from posted where conversation_id = ? and entry_id = ?")
				.get(conversationId, entryId) !== null
		);
	}

	addPosted(conversationId: string, entryId: string, messageId: string): void {
		this.#db
			.query("insert or ignore into posted (conversation_id, entry_id, message_id) values (?, ?, ?)")
			.run(conversationId, entryId, messageId);
	}
}
