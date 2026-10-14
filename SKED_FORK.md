# aitkn fork of Kanban

This is [cline/kanban](https://github.com/cline/kanban) with a few changes the Sked AI team
runs with. Every change is marked `sked fork:` in the source (`git grep "sked fork"`).

## Install

Download the tarball from the newest release on
[aitkn/kanban releases](https://github.com/aitkn/kanban/releases) and install it globally. It
replaces the official `kanban` command:

```bash
npm i -g https://github.com/aitkn/kanban/releases/download/v0.1.70-sked.1/kanban-0.1.70-sked.1.tgz
kanban --version   # 0.1.70-sked.1
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
