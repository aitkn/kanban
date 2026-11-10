// sked fork: a card blocked by prerequisites on two boards, against a real runtime and the CLI.
// The agent is a stand-in `claude` on PATH that just stays alive, so a started card gets a real
// session and worktree without any credentials.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskDependsOnRef,
} from "../../src/core/api-contract";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function createRepository(root: string, name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	runGit(path, ["init", "-q"]);
	runGit(path, ["checkout", "-q", "-B", "main"]);
	writeFileSync(join(path, "README.md"), `# ${name}\n`, "utf8");
	runGit(path, ["add", "."]);
	runGit(path, ["commit", "-qm", "init"]);
	return path;
}

function card(id: string, dependsOn?: RuntimeTaskDependsOnRef[]): RuntimeBoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Task ${id}`,
		startInPlanMode: false,
		agentId: "claude",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...(dependsOn ? { dependsOn } : {}),
	};
}

function board(
	cards: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>,
	dependencies: RuntimeBoardData["dependencies"] = [],
): RuntimeBoardData {
	const columns: Array<{ id: RuntimeBoardColumnId; title: string }> = [
		{ id: "backlog", title: "Backlog" },
		{ id: "in_progress", title: "In Progress" },
		{ id: "review", title: "Review" },
		{ id: "trash", title: "Done" },
	];
	return { columns: columns.map((column) => ({ ...column, cards: cards[column.id] ?? [] })), dependencies };
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	if (!address || typeof address !== "object") {
		throw new Error("Could not allocate a test port.");
	}
	return address.port;
}

function spawnCli(args: string[], cwd: string, env: NodeJS.ProcessEnv, extra: { ipc?: boolean } = {}): ChildProcess {
	return spawn(
		process.execPath,
		[
			...(extra.ipc ? ["--require", resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs")] : []),
			"--import",
			pathToFileURL(requireFromHere.resolve("tsx")).href,
			resolve(process.cwd(), "src/cli.ts"),
			...args,
		],
		{ cwd, env, stdio: extra.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"] },
	);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null) {
		return true;
	}
	return await new Promise<boolean>((resolveExit) => {
		const timeoutId = setTimeout(() => resolveExit(false), timeoutMs);
		child.once("exit", () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		});
	});
}

async function waitForServerStart(child: ChildProcess): Promise<void> {
	let output = "";
	await new Promise<void>((resolveStart, rejectStart) => {
		const timeoutId = setTimeout(() => rejectStart(new Error(`Server did not start:\n${output}`)), 20_000);
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("Cline Kanban running at ")) {
				clearTimeout(timeoutId);
				resolveStart();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", () => rejectStart(new Error(`Server exited before startup:\n${output}`)));
	});
}

interface CliResult {
	exitCode: number | null;
	json: Record<string, unknown>;
}

async function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
	const child = spawnCli(args, cwd, env);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	if (!(await waitForExit(child, 30_000))) {
		child.kill("SIGKILL");
		throw new Error(`kanban ${args.join(" ")} did not exit.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	try {
		return { exitCode: child.exitCode, json: JSON.parse(stdout) as Record<string, unknown> };
	} catch {
		throw new Error(`kanban ${args.join(" ")} printed no JSON.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	}
}

/** Runs `run` with HOME pointing at `home`, so the in-process board helpers use the sandbox. */
async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await run();
	} finally {
		process.env.HOME = previousHome;
		process.env.USERPROFILE = previousUserProfile;
	}
}

function columnOf(projectBoard: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | undefined {
	return projectBoard.columns.find((column) => column.cards.some((candidate) => candidate.id === taskId))?.id;
}

describe.sequential("sked fork: prerequisites across two boards", () => {
	it(
		"holds a card until its last prerequisite on either board is done, then starts it with a session",
		{ timeout: 180_000 },
		async () => {
			const { path: home, cleanup: cleanupHome } = createTempDir("kanban-home-prereq-");
			const { path: root, cleanup: cleanupRoot } = createTempDir("kanban-prereq-");
			try {
				const webPath = createRepository(root, "skedai-web");
				const dbPath = createRepository(root, "skedai-db");
				await withHome(home, async () => {
					const web = await loadWorkspaceContext(webPath);
					const db = await loadWorkspaceContext(dbPath);
					expect([web.workspaceId, db.workspaceId]).toEqual(["skedai-web", "skedai-db"]);
					// web01 waits on web02 (same board, live link) and on db001 (other board). web03 waits on
					// db002, which is still running.
					await saveWorkspaceState(webPath, {
						board: board(
							{
								backlog: [
									card("web01", [{ taskId: "web02" }, { taskId: "db001", projectId: "skedai-db" }]),
									card("web03", [{ taskId: "db002", projectId: "skedai-db" }]),
								],
								review: [card("web02")],
							},
							[{ id: "dep00001", fromTaskId: "web01", toTaskId: "web02", createdAt: 1 }],
						),
						sessions: {},
					});
					await saveWorkspaceState(dbPath, {
						board: board({ in_progress: [card("db002")], review: [card("db001")] }),
						sessions: {},
					});
				});

				// A stand-in agent: `claude` that stays alive until the runtime stops it.
				const binDir = join(root, "bin");
				mkdirSync(binDir);
				writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexec sleep 600\n", "utf8");
				chmodSync(join(binDir, "claude"), 0o755);

				const port = String(await getAvailablePort());
				const env = createGitTestEnv({
					HOME: home,
					USERPROFILE: home,
					KANBAN_RUNTIME_PORT: port,
					KANBAN_PTY_HOST: "0",
					PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
				});
				for (const key of Object.keys(env)) {
					if (key.startsWith("KANBAN_HOOK_")) {
						delete env[key];
					}
				}

				const server = spawnCli(["--no-open"], webPath, env, { ipc: true });
				try {
					await waitForServerStart(server);

					// 1. The same-board prerequisite finishes, but db001 is still in Review: web01 waits.
					const webDone = await runCli(
						["task", "done", "--task-id", "web02", "--project-path", webPath],
						webPath,
						env,
					);
					expect(webDone.exitCode).toBe(0);
					expect(webDone.json).toMatchObject({
						ok: true,
						readyTaskIds: [],
						autoStartedTasks: [],
						crossProjectAutoStartedTasks: [],
					});
					const afterWebDone = await withHome(home, () => loadWorkspaceState(webPath));
					expect(columnOf(afterWebDone.board, "web01")).toBe("backlog");

					// 2. A manual start of a card blocked by another board is refused and names what blocks it.
					const refused = await runCli(
						["task", "start", "--task-id", "web03", "--project-path", webPath],
						webPath,
						env,
					);
					expect(refused.exitCode).toBe(1);
					expect(refused.json).toMatchObject({
						ok: false,
						taskId: "web03",
						openPrerequisites: [
							{
								ref: "db#db002",
								taskId: "db002",
								projectId: "skedai-db",
								column: "in_progress",
								title: "Task db002",
							},
						],
					});
					expect(String(refused.json.error)).toContain("--force");
					const afterRefusal = await withHome(home, () => loadWorkspaceState(webPath));
					expect(columnOf(afterRefusal.board, "web03")).toBe("backlog");

					// 3. --force starts it anyway.
					const forced = await runCli(
						["task", "start", "--task-id", "web03", "--project-path", webPath, "--force"],
						webPath,
						env,
					);
					expect(forced.exitCode).toBe(0);
					expect(forced.json).toMatchObject({ ok: true, task: { id: "web03", column: "in_progress" } });

					// 4. The last prerequisite finishes on the OTHER board: the runtime starts web01 on web's board.
					const dbDone = await runCli(
						["task", "done", "--task-id", "db001", "--project-path", dbPath],
						dbPath,
						env,
					);
					expect(dbDone.exitCode).toBe(0);
					expect(dbDone.json).toMatchObject({
						ok: true,
						crossProjectAutoStartedTasks: [{ projectId: "skedai-web", taskId: "web01", title: "Task web01" }],
						crossProjectAutoStartFailedTasks: [],
					});

					const listed = await runCli(["task", "list", "--project-path", webPath], webPath, env);
					const tasks = listed.json.tasks as Array<{
						id: string;
						column: string;
						session: { state: string } | null;
					}>;
					expect(tasks.find((task) => task.id === "web01")).toMatchObject({
						column: "in_progress",
						session: { state: "running" },
					});
					const worktreeRoot = join(home, ".cline", "worktrees", "web01");
					expect(existsSync(worktreeRoot)).toBe(true);
					const [worktreeDir] = readdirSync(worktreeRoot);
					expect(worktreeDir && existsSync(join(worktreeRoot, worktreeDir, "README.md"))).toBe(true);
				} finally {
					if (server.connected) {
						server.send({ type: "kanban.shutdown" });
					} else {
						server.kill("SIGINT");
					}
					if (!(await waitForExit(server, 10_000))) {
						server.kill("SIGKILL");
						await waitForExit(server, 5_000);
					}
				}
			} finally {
				cleanupRoot();
				cleanupHome();
			}
		},
	);
});
