# Agora Chat Bridge Implementation Plan

> **For agentic workers:** implement task by task, in order. Each task names its files, its locked contract, and one acceptance check. Read `skill://ponytail` before writing code. No commit unless explicitly requested.

**Goal:** People talk to ompx from an Agora chat. A conversation with `@ompx` drives an ompx session in the repository's main checkout; `/branch` in any of those chats opens a new Agora conversation backed by its own git worktree and a fork of the session transcript. Messages carry text, images, files, page context and replies. Sessions run with no ompx TUI open, and every finished turn is posted back into its conversation — including turns that background jobs start after the prompt returned.

**Architecture:** `ompx agora serve` is a long-lived daemon (systemd user unit) on the machine that holds the repositories. It acts as the existing `@ompx` Agora agent and follows the agent's own event stream (`GET /api/v1/events/stream?scope=mine&types=chat.message`), so Agora already treats it as a *listener* route — no Agora change. Each Agora conversation is bound to one ompx session; each live session is one `ompx --mode rpc` child process driven through the in-repo `RpcClient`, with `cwd` = the main checkout or the branch's worktree. Replies, attachments and status go back over Agora REST.

**Tech stack:** TypeScript, Bun, `RpcClient` (`modes/rpc/rpc-client.ts`), `bun:sqlite`, `fetch` + `readSseEvents` (`@oh-my-pi/pi-utils/stream`), `createSessionWorktree` (`session/session-worktree.ts`). No new dependencies.

## Existing-code inventory

Opened in this checkout (ompx `/data/omppp/worktree-rapid-harbor-02e6`, Agora `origin/main` `25a04c9`).

| Capability | State | Evidence |
|---|---|---|
| Agent hears its chat messages without a webhook | EXISTS | Agora `apps/server/src/rest/events.ts:58` SSE `/events/stream` (`scope=mine`, `types`, `since`/`Last-Event-ID`); a written event is acked as delivered (`:118`); the stream records a listener heartbeat; `packages/domain/src/wake-ops.ts:63` routes the agent as `listener`. The agent's own events are never sent to it (`packages/domain/src/inputs.ts:124` `SELF_VISIBLE_EVENTS` has no `chat.message`); agent messages wake only agents they @mention (`chat.ts:495-496`) |
| Chat event carries the full message | EXISTS | Agora `packages/domain/src/chat.ts:~520` `chat.message` `data`: `conversation{id,title,url,participants}`, `message` (`ChatMessageDTO` `chat.ts:120-133`: `author{id,username,kind}`, `body`, `reply_to_id`, `context{text}`, `attachments[]`), `history` (last 10) |
| Post reply / status / new conversation / upload | EXISTS | Agora `apps/server/src/rest/chat.ts:63` POST messages (body ≤ 20 000, `chat-inputs.ts:11`; ≤ 20 `attachment_ids`, `:51`), `:88` POST status `working\|idle\|failed` + note ≤ 200, `:36` POST conversations (creator is always a participant, `chat-inputs.ts:66`); `rest/attachments.ts:74` POST multipart `file` → `{id,url,attachment}` |
| Attachment download | EXISTS | Agora `serialize.ts:108` `url = <base>/api/v1/attachments/<id>` (bearer token); DTO `mime`, `kind` (`image\|video\|file`), `filename`, `size` |
| Watchdog marks a silent wake stalled | EXISTS (constraint) | Agora `wakes.ts:38` `chatStallS: 180`; an agent message resolves its open wakes (`chat.ts:485-488`), a status post is a sign of life |
| Partial text in Agora's typing line for listener agents | MISSING (Agora) | only `hermes.ts:1100` feeds `feedWake` partials — out of scope |
| Branch/thread concept in Agora chat | MISSING (Agora) | `packages/db/src/schema/public.ts:1590` `conversation` has no parent column; only `chatMessage.replyToId`. Bridge models a branch as a new conversation + link messages |
| Agora identity for ompx | EXISTS | `~/.config/agora-ompx/env` (`AGORA_URL`, `AGORA_TOKEN`, `AGORA_WORKSPACE=trdo`, mode 0600), used by `~/.local/bin/agora-ompx` |
| Headless session protocol | EXISTS | `modes/rpc/rpc-types.ts:40-49` `prompt{message,images,streamingBehavior}`, `steer`, `follow_up`, `abort`, `new_session`; `:114-115` `branch`/`fork`; `:234` `prompt_result{status,error,sessionSettled}`; `:254` `session_settled` |
| Host-side client that spawns and drives it | EXISTS | `modes/rpc/rpc-client.ts:77-108` options `command`/`spawn`/`cwd`/`env`/`sessionDir`/`args`/`customTools`; `start()` prepends `--mode rpc` (`:379`); `prompt:728`, `steer:737`, `followUp:744`, `abort:769`, `getState:822`, `getEntries:993`, `getLastAssistantText:1190`, `setCustomTools:1338`; `onEvent:610`, `onSessionEvent:623`, `onPromptResult:678`, `onSessionSettled:689`; fake-process tests at `test/rpc-client.start.test.ts:62` |
| Questions/approvals from a headless session | EXISTS | `rpc-types.ts:62` `set_ask_dialog`; `:700-760` `extension_ui_request` (`select`/`confirm`/`input`/`ask`/`cancel`/…); `:886-895` `extension_ui_response` |
| Host-provided tools inside the session | EXISTS | `RpcClientCustomTool` `rpc-client.ts:130-139`, registered via `setCustomTools` |
| Session worktree | EXISTS | `session/session-worktree.ts:116` `createSessionWorktree(cwd, settings, branch, {keepChanges})` (base = `cwd` HEAD, path `getWorktreeDir(<slug>-<hash>)`, `:143-155`) → `SessionWorktree{path,branch,sourceCwd,baseCommit}` (`:23-38`); `:218` `inspectSessionWorktree` (`dirty`/`moved`/`offBranch`); `:308` `removeSessionWorktree(wt, moved)`; `ompx worktree clear` removes only orphaned entries unless `--all` (`cli/worktree-cli.ts:12-14,193`) |
| Fork a transcript into a new cwd | EXISTS | `main.ts:1270-1277` `--fork <path.jsonl>` → `SessionManager.forkFrom(source, cwd, sessionDir)`; `--session-dir` (`cli/flag-tables.ts:194`), `--continue` (`:394`) |
| Chat image to model input | EXISTS | `utils/image-loading.ts:403` `loadImageAttachmentInput({image,label,uri,autoResize})` (MIME allowlist, size cap, resize) |
| SSE parser | EXISTS | `packages/utils/src/stream.ts:549` `readSseEvents(stream, signal)` |
| Command line of the running ompx | PARTIAL | `task/omp-command.ts:1685` `currentOmpxBaseCommand` is private; export and reuse |
| Settings / CLI registries | EXISTS | `config/registry.ts:816` `register`; `config/all-settings.ts` imports each domain's `settings.ts`; `cli-commands.ts:339` entry shape; `commands/linear.ts` small-command pattern; `cli/command-help.ts:119` |
| Chat bridge precedent | EXISTS | `telegram/bridge.ts:35` `TelegramBridge` (`/steer`, `/queue`, outbound chunking); `python/robomp` runs `omp --mode rpc` per worktree with persistent `session_dir` + `--continue` (README "Architecture") |
| Daemon, bindings store, message conversion, chat commands, unit file | MISSING | designed below |

## Decisions

- **Transport: ompx RPC, one child per live conversation.** Alternatives: ACP, in-process sessions.
  - ACP (`omp acp`) is built for an editor client, not a chat bridge: `acp-client-bridge.ts:38` forces `requestPermission: true` (every bash/edit/delete/move becomes a round trip); `:41` sets `deferAgentInitiatedTurns: true`, which hides turns background jobs start after the prompt returns (`session/agent-session.ts:11092-11145`) — exactly the "finished later, report back" turns this feature exists for; `acp-agent.ts:2134` turns audio into `[audio omitted]`. Agora is not an ACP client, so ACP brings no reuse; its one gain (many sessions per process) does not matter at chat volume.
  - In-process `createAgentSession`: sessions share process-wide project state (`main.ts:573`, `setProjectDir` `:1891`) and one crash ends every chat.
  - RPC gives images on every input command, `followUp`/`steer`, `prompt_result.sessionSettled` + `session_settled`, host tools, ask/confirm forwarding and fork; `python/robomp` proves the shape in production.
- **Runs on the repository machine, not in Agora:** Agora's server spawns no processes, its image ships no ompx and no repositories, and the `listener` route already exists.
- **Trust boundary: an allowlist of people, pinned by actor id.** The child runs shell commands on this machine.
  - The daemon refuses to start with an empty `agora.allowedUsers`.
  - Only `author.kind === "human"` messages are routed; anything else is dropped silently (the agent never receives its own messages; other agents only reach it by @mention).
  - The first message from an allowlisted username pins `username → author.id` in the store; afterwards both must match (a renamed or reused username does not inherit access). Others get one short refusal per conversation and nothing runs.
  - Text from people outside the allowlist never reaches the model as instructions: reply excerpts and history from non-allowlisted authors are omitted; page context and quoted excerpts are wrapped in a delimited `<quoted untrusted>` block.
  - Honest limit: the child runs as the same unix user, so it can read any file that user can (including the token file). The allowlist is the real boundary; the path checks below stop accidental leaks, not a determined injection.
- **Inbound delivery is at-most-once.** On receipt the event id goes into `seen_event` and the cursor advances in one transaction, *before* dispatch. A crash mid-turn never re-runs a prompt on restart; the restart notice tells the person to resend.
- **A branch = new Agora conversation + new git worktree + forked transcript.**
  - Base: the source conversation's cwd HEAD (main checkout, or the source worktree's branch). Uncommitted changes are carried only from a bridge worktree (`keepChanges: true`); a main checkout is branched clean (`keepChanges: false`), because other chats share it.
  - The fork reads the source transcript only when the source session is settled; `/branch` sent mid-turn waits for `session_settled` (note: "Branching after the current turn finishes").
  - `--fork <file>` is used only on the first spawn (empty `session_dir`); the binding records `forked_from`; every later spawn uses `--continue`.
  - The new conversation is created by `@ompx` (so it is a participant) with the sender as the other participant; link messages in both conversations stand in for the missing parent column.
- **Main checkout is shared, so it is locked per repo from prompt dispatch until `session_settled`** (background jobs included). Waiting conversations get the note `Waiting for "<title of the blocking chat>" to finish` and the same heartbeat. `/branch` is the way out, and the docs say so. Worktree conversations run in parallel up to `agora.maxSessions`.
- **What gets posted:** for every `agent_end`, the text of the final assistant entry of that run, keyed by its session entry id (from `getEntries`). A run whose final entry is already posted (or has no text) posts nothing. Long replies split at paragraph boundaries into ≤ 19 000-char messages. Attachments queued by `agora_attach` ride on the next post, ≤ 20 per message.
- **Liveness (180 s stall window):** a session is *busy* from prompt dispatch until `session_settled`. While busy, an independent 60 s timer posts `working` with the latest note (`<tool>: <title>` from `tool_execution_start`, throttled to one change per 15 s; `running in the background` after `prompt_result{sessionSettled:false}`). `session_settled` → `idle`. `prompt_result.status=error` or child exit while busy → `failed` with a one-line reason. A posted question resolves the open wake (it is an agent message), so waiting for an answer needs no heartbeat.
- **Lifecycle:** a settled child is stopped after `agora.idleMinutes` (default 30); the next message respawns it with `--session-dir <dir> --continue`.
- **Identity:** the existing `@ompx` agent; the token is read from `agora.envFile` (mode 0600 enforced, like the `agora-ompx` wrapper), held in memory only, never put in `process.env` or the child's env, never stored in settings.

## Global constraints

- Code lives in `packages/coding-agent/src/agora/` (new) plus `commands/agora.ts` and the registry lines named below. No Agora change.
- Reuse the inventory; no second SSE parser, image loader, worktree helper or settings mechanism.
- Timeouts on every network call: REST 15 s, upload/download 120 s. The SSE stream reconnects with backoff 1 s → 60 s, resuming from the stored cursor.
- Downloads only from `AGORA_URL`'s origin; file names reduced to a sanitized basename; cap `agora.maxAttachmentMB` (default 25).
- `agora_attach` accepts only a path whose `realpath` is under the session cwd or its `<session_dir>/inbox`, never the env file, ≤ the Agora upload limit.
- Chat text is product copy: what happened and what the person can do next; never stack traces or raw protocol errors.
- Gates: `bun run check:types` (in `packages/coding-agent`), `bun run check:tools` (root), focused `bun test` files below. No new dependencies.

## Locked contracts

### Settings (`agora/settings.ts`, registered in `config/all-settings.ts`)

| key | type | default | meaning |
|---|---|---|---|
| `agora.envFile` | string | `~/.config/agora-ompx/env` | `AGORA_URL`, `AGORA_TOKEN`, optional `AGORA_WORKSPACE` |
| `agora.repos` | record name→absolute path | `{}` | main checkouts the bridge may use |
| `agora.defaultRepo` | string | `""` | repo for new conversations; empty + exactly one repo = that one |
| `agora.allowedUsers` | array of usernames | `[]` | who may drive sessions; empty = refuse to start |
| `agora.maxSessions` | number | `4` | live RPC children at once |
| `agora.idleMinutes` | number | `30` | keep a settled child this long |
| `agora.maxAttachmentMB` | number | `25` | per inbound file |

### Store (`<agentDir>/agora/state.db`, `bun:sqlite`, WAL)

```sql
create table if not exists cursor (k text primary key, event_id integer not null);
create table if not exists seen_event (event_id integer primary key);        -- pruned below cursor
create table if not exists allowed_actor (username text primary key, actor_id text not null);
create table if not exists refused (conversation_id text primary key);
create table if not exists binding (
  conversation_id text primary key,
  repo text not null,
  kind text not null check (kind in ('main','worktree')),
  cwd text not null,
  session_dir text not null,
  worktree text,                 -- JSON SessionWorktree when kind='worktree'
  forked_from text,              -- source transcript path, used once
  parent_conversation_id text,
  created_by text not null,      -- actor id
  created_at text not null,
  closed_at text
);
create table if not exists posted (conversation_id text, entry_id text, message_id text, primary key (conversation_id, entry_id));
```

`session_dir` = `<agentDir>/agora/sessions/<conversation_id>`; inbound files land in `<session_dir>/inbox/<message_id>/<basename>`.

### Inbound turn (`agora/inbound.ts`)

```ts
export interface InboundTurn { text: string; images: ImageContent[] }
export async function toInboundTurn(msg: ChatMessageDTO, event: ChatMessageEventData, deps: InboundDeps): Promise<InboundTurn>;
```

`text`, in order: `From @<user>:` · reply line when `reply_to_id` is set (`In reply to @<author>:` + excerpt ≤ 300 from `history`, only if that author is allowlisted, else `[earlier message from someone else omitted]`) · the body · `Page context:` block when present · `Files:` + one absolute inbox path per non-image file. Quoted excerpts and page context sit inside `<quoted untrusted>…</quoted>`. Images become `images` when `loadImageAttachmentInput` accepts them; otherwise they are saved and listed like files. Video and audio are always files.

### Host tool exposed to every session (`agora/session-host.ts`)

```ts
defineRpcClientTool({
  name: "agora_attach",
  description: "Attach a file from this workspace (image, log, patch, build output) to your next reply in this Agora chat.",
  parameters: { type: "object", properties: { path: { type: "string" }, caption: { type: "string" } }, required: ["path"] },
  execute: ({ path, caption }) => /* path checks, upload, queue id for the next post, return "attached <filename>" */,
});
```

### Chat commands (`agora/commands.ts`)

A message whose first token is one of these is handled by the daemon, not sent to the model.

| command | effect |
|---|---|
| `/branch [name] [task…]` | name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (else a short usage reply); branch `agora/<name or yyyymmdd-hhmm>`, suffixed `-2`, `-3`… when taken; worktree from the source cwd (see Decisions); new conversation `ompx · <branch>` with the sender; fork; link posted in both; optional `task…` runs there |
| `/steer <text>` | `steer` into the running turn |
| `/stop` | `abort` the running turn |
| `/new` | new session in the same cwd (old transcript kept) |
| `/status` | repo, kind, cwd, branch, dirty/moved, running/idle, what it waits for |
| `/repo <name>` | rebind a idle main conversation to another configured repo |
| `/close` | worktree conversations: stop the child; remove the worktree when clean and unmoved, otherwise keep it and say where and why; mark closed |
| `/help` | list these |

Any other `/word` goes to the session unchanged (ompx's own slash commands keep working). A plain message during a busy session becomes `followUp`.

### Questions from the session

The daemon enables `set_ask_dialog` once per child. `ask`/`select`/`confirm`/`input` are posted as a numbered question ("Reply with a number or your own answer"); the next allowlisted message in that conversation answers it (`answers` / `value` / `confirmed`). After the request's `timeout` or 30 min → `{cancelled: true, timedOut: true}`. `notify` → a normal message. `setStatus`, `setWidget`, `setTitle`, `set_editor_text` and the rest are ignored.

## Tasks

### Phase 1 — direct chat with the main checkout, headless

**Task 1: Settings, Agora client, store.** Files: create `src/agora/settings.ts`, `src/agora/client.ts`, `src/agora/store.ts`; modify `src/config/all-settings.ts`; export `currentOmpxBaseCommand` from `src/task/omp-command.ts`.
`client.ts`: `loadAgoraEnv(path)` (parse, enforce 0600, return values — never touch `process.env`); `AgoraClient` with `me()`, `postMessage(conv, {body, attachment_ids, reply_to})`, `setStatus(conv, state, note)`, `createConversation({title, participants, message})`, `upload(path)` (multipart), `download(url, dest, maxBytes)`, `stream(since, signal)` (async generator over `readSseEvents` yielding `{id, type, data}`); every request sends `Authorization: Bearer` + `X-Agora-Workspace`. `store.ts`: the schema above, typed helpers, `receive(eventId)` = insert seen + advance cursor in one transaction, returns false for a duplicate.
Acceptance: `bun test test/agora/client.test.ts test/agora/store.test.ts` — a `Bun.serve` fake asserts headers and multipart, streams 3 events, drops the connection, the client resumes from `since`; `receive` rejects a replayed id; failure path: env file with mode 0644 is refused.

**Task 2: Session host.** Files: create `src/agora/session-host.ts`.
`SessionHost` wraps one `RpcClient`: `command` from `currentOmpxBaseCommand()` (RpcClient adds `--mode rpc`), `cwd`, `sessionDir`, `args` = `["--fork", forked_from]` on the first spawn of a forked binding, else `["--continue"]`; `env` = parent env minus `AGORA_*`; `customTools: [agora_attach]`; then `set_ask_dialog`. `send(turn)` → `prompt`, or `followUp` while busy; `steer`, `abort`, `stop()` (abort, kill after 5 s). Outbound and liveness exactly per Decisions (posted keyed by final assistant entry id; 60 s busy heartbeat; `idle` on `session_settled`; `failed` on error/exit). Idle timer from `session_settled`.
Acceptance: `bun test test/agora/session-host.test.ts` with `RpcClient`'s `spawn` fake (pattern `test/rpc-client.start.test.ts:62`): (1) a prompt's final text is posted once; (2) a second `agent_end` after `prompt_result{sessionSettled:false}` posts a second message (background report); (3) a repeated `agent_end` with the same final entry posts nothing; (4) a 45 000-char reply becomes 3 messages; (5) with fake timers, a 150 s busy stretch with no tool events posts ≥ 2 `working` heartbeats, then `idle` on settle; (6) failure path: child exit while busy posts `failed`.

**Task 3: Daemon and command.** Files: create `src/agora/daemon.ts`, `src/commands/agora.ts`; modify `src/cli-commands.ts` (entry `agora`), `src/cli/command-help.ts` (`agoraHelp`).
`ompx agora serve`: load settings + env, refuse an empty allowlist; `me()`; stream `types=chat.message`; `store.receive` before anything else; trust checks per Decisions; bind an unknown conversation to the default repo (`kind: main`), or with several repos and no default, reply with the `/repo` choices; route commands or turns; per-repo main-checkout lock until `session_settled`; `maxSessions` queue with waiting notes and heartbeat. SIGTERM: stop children and post `failed` "ompx restarted; send your message again" where a turn was running.
Acceptance: `bun test test/agora/daemon.test.ts` (fake Agora via `Bun.serve` + fake child): an allowlisted human message gets a reply; a non-allowlisted author gets one refusal and no child; a pinned username with a different actor id is refused; two main-bound conversations never run at once and the second shows the waiting note.

### Phase 2 — every kind of message

**Task 4: Inbound conversion.** Files: create `src/agora/inbound.ts`; wire into `daemon.ts`. Per the locked `InboundTurn`.
Acceptance: `bun test test/agora/inbound.test.ts` — a PNG becomes one `ImageContent`; a PDF becomes an inbox path in the text; an oversize file becomes `<name> skipped: larger than 25 MB` with no download; a non-allowlisted reply excerpt is omitted; reply and page context appear in order inside the quoted block.

**Task 5: Outbound files and questions.** Files: modify `src/agora/session-host.ts`, `src/agora/daemon.ts`. `agora_attach` with the path checks; the `extension_ui_request` flow per "Questions from the session" (daemon routes the next allowlisted message to a pending question before treating it as a turn).
Acceptance: extend `test/agora/session-host.test.ts` — `agora_attach` + `agent_end` posts one message with one attachment id; `agora_attach` of `../../etc/passwd` and of the env file are refused; an `ask` request posts a numbered question and the reply `2` returns `answers[0].selectedOptions = [<option 2 label>]`; a timeout returns `cancelled`.

### Phase 3 — branch to a worktree

**Task 6: Commands and worktree lifecycle.** Files: create `src/agora/commands.ts`; modify `daemon.ts`, `session-host.ts`.
`/branch`: wait for the source to settle → `getState().sessionFile` (none yet → fresh session) → `createSessionWorktree(sourceCwd, settingsFor(repo), branch, {keepChanges: source.kind === "worktree"})` → `createConversation({title, participants: [senderUsername], message})` → bind `kind: worktree`, `forked_from` → spawn → link in parent → optional task. `/close` via `inspectSessionWorktree` + `removeSessionWorktree` (a moved branch is kept). `/new`, `/status`, `/repo`, `/stop`, `/steer`, `/help` per the table.
Acceptance: `bun test test/agora/branch.test.ts` (temp git repo, fake Agora, fake child): `/branch fix-login check the form` creates `agora/fix-login`, a new bound conversation, a child spawned with `cwd` = worktree and `--fork`; a respawn after idle uses `--continue`, not `--fork`; `/branch ../x` is refused; `/close` keeps a dirty worktree and reports why, removes a clean one.

### Phase 4 — run it for real

**Task 7: Service, docs, changelog, live check.** Files: create `docs/agora-bridge.md` (setup, settings, commands, unit file, limits incl. "never `ompx worktree clear --all` on the bridge host"); modify `packages/coding-agent/CHANGELOG.md` (`### Added` under `[Unreleased]`).
Unit `~/.config/systemd/user/ompx-agora.service`: `ExecStart=%h/.bun/bin/ompx agora serve`, `Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`, `Restart=always`, `RestartSec=5`, `WantedBy=default.target`; `loginctl enable-linger`.
Live acceptance on Agora workspace `trdo` as `@ompx` against a scratch repo in `agora.repos`, each checked through `GET /api/v1/chat/conversations/<id>/messages` (and `/wakes` for stalls), not only the UI:
1. A text chat gets a reply.
2. A screenshot gets a reply that describes it.
3. A prompt that starts `sleep 90 && echo done` as an async bash job gets the job's result posted after the first reply; `/wakes` shows no `stalled`.
4. `/branch try-x` opens a linked conversation; the worktree exists on disk on branch `agora/try-x`.
5. `systemctl --user restart ompx-agora` mid-turn posts the restart notice; the next message resumes the same transcript and the interrupted message is not re-run by itself.

## Prerequisites and out of scope (owned elsewhere)

- Agora, optional, not required: an endpoint for listener agents to stream partial text into the typing line; a "Branch to worktree" action in the chat header; a parent link on `conversation`. Each is its own Agora change.
- Issue mentions/assignments for `@ompx` (`mention`, `issue.assigned`) are not handled; the `agora-ompx` CLI workflow covers worker reporting on issues.
- Picking a repo from the chat's linked entity (issue → team → repo); `/repo` covers it by hand.

## Risks

- Main-checkout chats see each other's uncommitted edits across turns; the lock prevents overlap, not sharing. `/branch` is the isolation tool.
- A long background job in a main-bound chat blocks other main-bound chats of that repo until it settles (visible in their waiting note).
- Each child is a full ompx process; `agora.maxSessions` and the idle timeout bound it.
- A daemon restart mid-turn loses that turn's in-flight work; the transcript stays on disk and the chat is told to resend.

## Amendment 2026-11-17: Agora parity endpoints

The Agora parity plan (`/data/code/agora` branch `feat/agent-runs-branching`, `docs/plans/2026-11-17-agent-chat-parity.md`) adds endpoints. The bridge uses them, so the plain-text fallbacks above apply only when an endpoint answers 404 (an older Agora).

- **Stream:** `types=chat.message,chat.branched,agent.question_answered`.
- **Turn id:** each prompt dispatch mints a `turn_id` (uuid). Every step, partial and final reply of that run carries it. A background-started run gets a fresh one.
- **Partial:** on `message_update` `text_delta`, `POST /chat/conversations/{id}/partial` with the run's text so far (the last 2000 chars). Sent at most once per second, and once more on `agent_end`.
- **Status:** `working` posts also send `tool` = the tool name.
- **Steps:** `PUT /chat/conversations/{id}/activity`. Steps are batched (one flush per 500 ms, ≤ 50 steps) and keyed `step_id` = tool call id. Event mapping:

  | ompx event | step |
  |---|---|
  | `tool_execution_start` | `{kind:'tool', status:'running', title, detail:{tool, input}}` |
  | `tool_execution_end` | `done` or `failed`, plus `output` (truncated to the caps) |
  | edit results with `perFileResults` | `{kind:'diff', detail:{files:[{path, patch}]}}`; the patch is built with the existing diff helper (`@oh-my-pi/pi-diff` or the edit tool's diff output) |
  | todo results / `todo_reminder` | `{kind:'plan'}` |
  | thinking (`thinking_end`) | `{kind:'thinking'}` |

  The final reply is posted with `turn_id`.
- **Questions:**
  - An `ask`, `select`, `confirm` or `input` request creates a `question` step (`status:'waiting'`). Its `detail.questions` map from `RpcAskDialogQuestion`. `select` and `confirm` become one question each; `input` becomes a question with no options, answered through `custom`.
  - The `agent.question_answered` event with matching `turn_id`/`step_id` resolves the pending `extension_ui_response`.
  - A typed numbered reply still answers it as well. The daemon then sets the step to `answered` itself.
  - A timeout sets the step to `cancelled`.
- **Branching from the UI:** on `chat.branched`, the daemon binds the new conversation as `kind: worktree`:
  - worktree from the parent binding's cwd, using the same rules as `/branch` (wait for the parent to settle, `keepChanges` by parent kind);
  - branch name `agora/<slug of title>-<yyyymmdd-hhmm>`;
  - fork from the parent's session file;
  - `PATCH branch_label` = the branch name;
  - one message naming the branch and the path.

  A parent with no binding (a plain chat) gets a fresh session in the default repo's worktree.
- **`/branch` command:** calls `POST /chat/conversations/{id}/branch` (`from_message` = the command message) instead of `createConversation`. The daemon then handles the resulting `chat.branched` exactly like a UI branch, and the optional task is sent as the first message. There is no separate code path.
- **Task mapping:** Task 2 owns partial, steps and status tool. Task 5 owns question steps. Task 6 owns `chat.branched` handling. Acceptance adds:
  - a fake-Agora assertion that one prompt with one tool call produces `PUT activity` with a running and then a done step, plus a reply with the same `turn_id`;
  - an `agent.question_answered` event resolving an `ask`.
