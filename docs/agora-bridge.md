# Agora chat bridge

`ompx agora serve` lets people chat with ompx from an [Agora](https://agora-dev.typhon-buri.ts.net:3300) conversation. ompx keeps working when no terminal is open and posts every result back into the chat. That includes results of background jobs that finish after the first reply.

## How it works

- The daemon logs in as an Agora agent (default identity: `@ompx`) and follows that agent's event stream. Agora sees it as a *listener*, so the agent needs no webhook.
- Each conversation is bound to one ompx session. A session runs as its own `ompx --mode rpc` child process.
  - A normal chat works in the repository's main checkout. Chats of the same repository take turns there: a waiting chat shows `Waiting for "<chat>" to finish`.
  - A branch gets its own conversation, its own git worktree (branch `agora/<name>`) and a copy of the parent chat's transcript. Branches run side by side, up to `agora.maxSessions`.
- Images go to the model directly. Other files are saved under the session's `inbox/` folder and the model gets their paths. Replies and page context are quoted.
- Back in Agora, the chat shows:
  - the final answer of every turn;
  - files the agent attaches with the `agora_attach` tool;
  - a streamed draft while it writes;
  - the steps it took (tools, diffs, plans, thinking);
  - questions as clickable cards. You can also answer them by typing a number or your own answer.
- A settled session's process stops after `agora.idleMinutes`. The next message resumes the same transcript.

## Who can use it

Only people listed in `agora.allowedUsers` can drive a session. The first message from each listed username pins that Agora account, so a renamed or reused username does not inherit access. Messages from anyone else get one short refusal per conversation, and nothing runs. Text quoted from other people (replies, page context) reaches the model marked as untrusted.

The sessions run shell commands as your user on this machine. Allow only people you would give a shell to.

## Setup

1. Make sure the Agora identity file exists and is private:

   ```sh
   cat ~/.config/agora-ompx/env      # AGORA_URL=…  AGORA_TOKEN=agr_…  AGORA_WORKSPACE=<slug>
   chmod 600 ~/.config/agora-ompx/env
   ```

2. Configure ompx (`~/.omp/agent/config.yml`):

   ```yaml
   agora:
     allowedUsers: [qq]
     repos:
       app: /home/me/code/app
     defaultRepo: app
     maxSessions: 4
     idleMinutes: 30
     maxAttachmentMB: 25
     # envFile: ~/.config/agora-ompx/env
   ```

3. Run it as a user service. Save this as `~/.config/systemd/user/ompx-agora.service`:

   ```ini
   [Unit]
   Description=ompx Agora chat bridge
   After=network-online.target

   [Service]
   ExecStart=%h/.local/bin/ompx agora serve
   Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now ompx-agora
   loginctl enable-linger "$USER"   # keep it running after logout
   ```

## Chat commands

| Command | What it does |
|---|---|
| `/branch [name] [task…]` | Opens a linked conversation on a new worktree branch `agora/<name>`, and starts `task` there if you give one. Agora's "Branch from here" does the same. |
| `/steer <text>` | Adds guidance to the turn that is running. |
| `/stop` | Stops the running turn. |
| `/new` | Starts a fresh session in the same folder. The old transcript is kept. |
| `/status` | Shows the repository, folder, branch, whether the worktree has changes, and what the session is doing or waiting for. |
| `/repo <name>` | Points an idle chat at another configured repository. |
| `/close` | Branch chats only. Stops the session and removes the worktree when nothing would be lost; otherwise keeps it and says why. |
| `/help` | Lists these commands. |

Any other `/command` goes to ompx unchanged.

## Limits

- Chats on the main checkout see each other's uncommitted edits. Use `/branch` when work must not mix.
- A long background job in a main-checkout chat holds that checkout until it finishes.
- If the service restarts in the middle of a turn, that turn's unfinished work is lost. The chat is told to send the message again, and the transcript stays.
- Do not run `ompx worktree clear --all` on the bridge machine: it would remove the worktrees of open branch chats.
