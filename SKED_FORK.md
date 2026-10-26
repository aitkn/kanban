# aitkn fork of Kanban

This is [cline/kanban](https://github.com/cline/kanban) with a few changes the Sked AI team
runs with. Every change is marked `sked fork:` in the source (`git grep "sked fork"`).

## Install

Download the tarball from the newest release on
[aitkn/kanban releases](https://github.com/aitkn/kanban/releases) and install it globally. It
replaces the official `kanban` command:

```bash
npm i -g https://github.com/aitkn/kanban/releases/download/v0.1.70-sked.3/kanban-0.1.70-sked.3.tgz
kanban --version   # 0.1.70-sked.3
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
| Card detail view diff poll (`web-ui/src/components/card-detail-view.tsx`) | every 1s | off |
| Self-update (`src/update/update.ts`) | from npm on startup | off for `-sked.N` versions |
| Autonomous Claude cards (`src/terminal/agent-session-adapters.ts`) | `--permission-mode auto` | same, unless `KANBAN_CLAUDE_SKIP_PERMISSIONS=1` |
| Board save conflict (`web-ui/src/runtime/use-workspace-persistence.ts`) | adopts the server revision, skips the reload, then saves the stale board over the server's | reloads the server board and drops the local edit, with the existing toast |
| Move to Done (`web-ui/src/hooks/use-linked-backlog-task-actions.ts`, `web-ui/src/stores/board-persistence-confirmations.ts`) | stops the session and deletes the worktree before the move is saved | waits until the server has the move; if it is lost, touches nothing and warns |
| Lost Start (`web-ui/src/hooks/use-board-interactions.ts`) | a Start dropped by a conflict leaves the agent running on a Backlog card | the card moves beside its session (only for a session started after the card was created) |
| Hidden agent terminals (`web-ui/src/terminal/persistent-terminal-manager.ts`, `web-ui/src/hooks/use-persistent-terminal-cleanup.ts`) | every card terminal a tab has shown stays connected and keeps parsing output until refresh | the shown terminal, the sidebar agent and the 3 most recently hidden stay connected; older ones close and restore from the server when reopened; a card's hidden terminals close when it leaves In Progress/Review |
| Agent and shell processes (`src/terminal/pty-host/`, `src/terminal/session-manager.ts`) | children of the runtime; a restart or crash kills every running agent | run in a detached PTY host; a restart with `--skip-shutdown-cleanup`, or a crash, leaves them running and the new runtime reattaches them |
| Stop on shutdown (`src/terminal/session-manager.ts`) | an agent stopped by shutdown can be relaunched by its exit handler (it dies with the runtime) | never relaunched |

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

### `KANBAN_CLAUDE_SKIP_PERMISSIONS`

This is off by default. With `KANBAN_CLAUDE_SKIP_PERMISSIONS=1` set in the environment that
starts `kanban`, autonomous Claude cards run with `--dangerously-skip-permissions`, which means
no permission checks of any kind. Plan-mode starts are unaffected. Opt in only if you want that
for every card:

```bash
KANBAN_CLAUDE_SKIP_PERMISSIONS=1 kanban
```

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
