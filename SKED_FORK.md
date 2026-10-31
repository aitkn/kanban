# aitkn fork of Kanban

This is [cline/kanban](https://github.com/cline/kanban) with a few changes the Sked AI team
runs with. Every change is marked `sked fork:` in the source (`git grep "sked fork"`).

## Install

Download the tarball from the newest release on
[aitkn/kanban releases](https://github.com/aitkn/kanban/releases) and install it globally. It
replaces the official `kanban` command:

```bash
npm i -g https://github.com/aitkn/kanban/releases/download/v0.1.70-sked.7/kanban-0.1.70-sked.7.tgz
kanban --version   # 0.1.70-sked.7
```

To go back to the official build: `npm i -g kanban@latest`.

A fork build never updates itself: the official build auto-installs `kanban@latest` from npm on
startup, which would silently replace the fork. `kanban update` prints this page's release link
instead. To upgrade, install the newer release tarball.

## What differs from upstream

| Change | Upstream | Fork |
|---|---|---|
| File lock stale timeout (`src/fs/locked-file-system.ts`) | 10s | 30s |
| Workspace git metadata poll (`src/server/workspace-metadata-monitor.ts`) | 1s | 10s |
| Card detail "Changes" panel (`web-ui/src/components/card-detail-view.tsx`) | a diff column beside the agent, loaded with `workspace.getChanges` on open, on every metadata update and every 1s | removed: the agent takes the full width and opening a card loads no diff; the git history view (Ctrl+G) still shows diffs |
| Self-update (`src/update/update.ts`) | from npm on startup | off for `-sked.N` versions |
| Autonomous Claude cards (`src/terminal/agent-session-adapters.ts`) | `--permission-mode auto` | `--dangerously-skip-permissions`, unless `KANBAN_CLAUDE_SKIP_PERMISSIONS=0`; the sidebar Kanban agent keeps auto mode |
| Board save conflict (`web-ui/src/runtime/use-workspace-persistence.ts`) | adopts the server revision, skips the reload, then saves the stale board over the server's | reloads the server board and drops the local edit, with the existing toast |
| Move to Done (`web-ui/src/hooks/use-linked-backlog-task-actions.ts`, `web-ui/src/stores/board-persistence-confirmations.ts`) | stops the session and deletes the worktree before the move is saved | waits until the server has the move; if it is lost, touches nothing and warns |
| Lost Start (`web-ui/src/hooks/use-board-interactions.ts`) | a Start dropped by a conflict leaves the agent running on a Backlog card | the card moves beside its session (only for a session started after the card was created) |
| Hidden agent terminals (`web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/hooks/use-persistent-terminal-cleanup.ts`) | every card terminal a tab has shown stays connected and keeps parsing output until refresh | the shown terminal, the sidebar agent and the 3 most recently hidden stay connected; older ones close and restore from the server when reopened; a card's hidden terminals close when it leaves In Progress/Review |
| Agent and shell processes (`src/terminal/pty-host/`, `src/terminal/session-manager.ts`) | children of the runtime; a restart or crash kills every running agent | run in a detached PTY host; a restart with `--skip-shutdown-cleanup`, or a crash, leaves them running and the new runtime reattaches them |
| Stop on shutdown (`src/terminal/session-manager.ts`) | an agent stopped by shutdown can be relaunched by its exit handler (it dies with the runtime) | never relaunched |
| Claude turn ends on background work (`src/trpc/hooks-api.ts`, `src/trpc/background-work-holds.ts`, `src/commands/hook-events/claude-hook-events.ts`) | Stop moves the card to Review while background Bash, subagents or Monitor are still running; it bounces back when Claude resumes | the card stays in In Progress as "Waiting on background job (N)" until a turn ends with nothing outstanding |
| Claude waiting for the user (`src/terminal/session-state-machine.ts`, `src/commands/hook-events/approval-hook-events.ts`, `web-ui/src/utils/pending-approval.ts`) | a permission prompt moves the card to Review as if done, any tool finishing (a parallel call, a subagent) pulls it back while the prompt is still open, and an MCP elicitation form (Supabase `apply_migration`) leaves it in In Progress; auto-review can commit it mid-task | the card goes to Review marked "Waiting for your approval: <tool or MCP server>" and fires the ready notification; only that prompt's answer releases it; auto-review skips it |
| Hook debug log (`src/commands/hook-events/hook-debug-log.ts`) | none; hook delivery failures are silent | `KANBAN_HOOK_DEBUG_LOG=<file>` appends one JSON line per hook |
| Linked backlog cards (`src/core/task-board-mutations.ts`, `web-ui/src/hooks/use-linked-backlog-task-actions.ts`) | a card linked to several prerequisites auto-starts when the FIRST one moves from Review to Done | auto-starts when the LAST one does (join); only Review to Done counts, so a prerequisite moved to Done from another column, or deleted, just drops its link; a backlog card waiting on 2 or more shows a link badge with the count |

### Board writes under load

The three board rows above fix lost board writes: a CLI-created card vanishing, a deleted card
coming back, and a card moved to Done jumping back to Review with its session and worktree
gone. Reported upstream as [cline/kanban#674](https://github.com/cline/kanban/issues/674), tracked
as sked_ai#4951.

### Hidden agent terminals

Upstream keeps every card terminal a tab has shown connected: each one holds two WebSockets and
parses its agent's full TUI output on the main thread. A tab got slower with every card viewed until
it was refreshed, and with enough cards it could run out of browser WebSockets, at which point the
board stream could not reconnect and cards stopped showing. The fork caps hidden terminals at
`MAX_PARKED_PERSISTENT_TERMINALS` (3). Reopening a closed one replays the server's copy of the screen
and its 10,000-line scrollback. Text that only ever lived in the browser is not replayed: a
local Clear, the `[kanban] session exited` line, and the scroll position.

### Agents survive a Kanban restart

Agent and shell terminals run in a separate PTY host process (`dist/pty-host.js`) that Kanban starts
on first use. Restarting Kanban with `--skip-shutdown-cleanup`, or Kanban crashing, leaves every
agent running mid-turn. On startup Kanban reattaches each card to its process, with the screen and
scrollback intact. The resurrect skill is only needed after a reboot or after the host itself died.

- A normal shutdown (without `--skip-shutdown-cleanup`) still stops every agent, as upstream does.
  Removing a project or moving a card to Done stops its agents too.
- The host exits on its own 30 seconds after Kanban is gone and no agent is running. Its log is
  `~/.cline/kanban/pty-host-<port>.log`. There is one host per Kanban home and port, and its socket is
  in `/tmp/kanban-pty-<uid>/`. Kanban refuses that directory unless it belongs to you with mode 700.
- `KANBAN_PTY_HOST=0` starts new terminals inside Kanban as upstream does. Sessions an earlier run
  left in a host are still reattached.
- Not reattached: Codex's output-based prompt detection and a pending workspace-trust auto-confirm.
  Hooks still update card state. Windows always runs terminals inside Kanban.

**Upgrading to the first build with the host still kills the running agents**, because they are
children of the old Kanban. From then on, restarts keep them.

**Before going back to the official build or an older fork build, stop your cards or kill the host**
(`pkill -f pty-host.js`, which kills every agent in it). Otherwise the agents keep running where the
older Kanban cannot see them, and resuming those cards starts a second agent in the same worktree.

For maintainers: changing `PTY_HOST_PROTOCOL_VERSION` gives the new Kanban a new host, so the agents
running in the old host are left unseen in exactly that way. Bump it only with a migration plan.

### Background work keeps a Claude card In Progress

Claude Code's Stop hook payload lists the session's in-flight background work in `background_tasks`
(background Bash, background subagents, Monitor). When that list is not empty the turn ended only to
wait: Claude starts a new turn by itself when a task finishes, and that turn's Stop decides the column.
Auto-commit and auto-PR act only on the Review column, so they no longer fire in the middle of the work.

If a task ends without Claude resuming (a task stopped from Claude's `/tasks` view records its end in
the transcript but starts no turn), Kanban notices on a re-check every 15 seconds that reads only the
bytes appended to the session transcript, and moves the card to Review. A Claude Code without the
field, or a transcript Kanban cannot read, gets the upstream behaviour. A job that hangs keeps the card
In Progress, labelled with the number of jobs it is waiting on. A Kanban restart forgets the re-check;
the card then waits for Claude's next Stop.

A permission prompt or MCP form raised meanwhile (for example by a background subagent) ends the wait
and shows the card as waiting for your approval, as described below. After the answer the card is In
Progress again until Claude's next Stop.

This is deliberate for jobs meant to run forever too: a dev server, a watcher, `tail -f` or a persistent
Monitor started in the background keeps the card In Progress, labelled "Waiting on background job (N)",
for as long as it runs. The card never reaches Review on its own, and that includes a turn that ends
with Claude asking you a question, so no ready-for-review signal fires. Stop the job (Claude's `/tasks`)
or move the card yourself. Moving to Review anyway would let auto-commit and auto-PR fire mid-work, which
is what this change exists to prevent.

### Waiting for your approval

A Claude card whose agent is blocked on the user, either a permission prompt or an MCP elicitation
form, sits in Review with a gold border, a shield icon and "Waiting for your approval", naming the
tool or MCP server. It returns to In Progress only when a hook shows the agent moved on:
`ElicitationResult` (for a form), the `PostToolUse` of the same tool call, a new prompt, or the end of
the turn. Another tool finishing does not release it. Auto-commit and auto-PR never act on a card in
this state, and its Commit / Open PR buttons are hidden, because their trailing Enter would answer the
open dialog.

Claude's `PermissionRequest` payload has no `tool_use_id`, so a prompt is matched to its tool call by
tool name plus a hash of the tool input (`AskUserQuestion` and `ExitPlanMode` by name alone, because
Claude rewrites their input before `PostToolUse`). Answering in the terminal does not release the card: a "No"
fires no hook while Claude waits for the user to type, and the keypress cannot tell it from "Yes". So
after a "Yes" the card keeps waiting until the approved tool finishes.

`KANBAN_HOOK_DEBUG_LOG=/path/hooks.jsonl` in the environment that starts `kanban` logs every hook
Kanban receives (event, notification type, tool, `tool_use_id`, agent, permission mode, what Kanban
derived from it, and whether the runtime accepted it). Agents inherit it, so set it before starting
the cards you want to trace.

### `KANBAN_CLAUDE_SKIP_PERMISSIONS`

This is on by default: autonomous Claude cards run with `--dangerously-skip-permissions`, which means
no permission checks of any kind. Upstream runs them with `--permission-mode auto`, whose classifier
refuses tool calls it cannot evaluate; on a long unattended card that halts the agent until someone
switches modes by hand. Plan-mode starts are unaffected (they still start in `--permission-mode plan`),
and so is a card whose agent arguments already set a permission mode. The sidebar Kanban agent is not a
card and runs in the main checkout, so it always keeps `--permission-mode auto`.

To get upstream's auto mode back for cards, set `KANBAN_CLAUDE_SKIP_PERMISSIONS` to `0`, `false`, `no`,
`off` or an empty value in the environment that starts `kanban`:

```bash
KANBAN_CLAUDE_SKIP_PERMISSIONS=0 kanban
```

The settings dialog always shows the default command (`claude --dangerously-skip-permissions`); it
cannot see the runtime's environment.

## Cutting a release on a new upstream version

```bash
git fetch upstream --tags
git checkout -b sked/vX.Y.Z vX.Y.Z
git cherry-pick <previous sked/... branch commits>   # or: git rebase --onto vX.Y.Z <old tag> <old branch>
npm version X.Y.Z-sked.1 --no-git-tag-version
npm ci && npm --prefix web-ui ci
npm run typecheck && npm run test:fast && npm run web:test
SENTRY_AUTH_TOKEN= npm run build && npm pack
git commit -am "chore(release): vX.Y.Z-sked.1" && git tag vX.Y.Z-sked.1 && git push origin sked/vX.Y.Z vX.Y.Z-sked.1
# then create a GitHub release for the tag and attach kanban-X.Y.Z-sked.1.tgz
```

Run the tests with `KANBAN_RUNTIME_PORT` unset. A shell started inside a Kanban card inherits
the running board's port, which fails `test/runtime/server/middleware.test.ts`.
