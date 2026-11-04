// sked fork: cross-project links and project short names against a real project registry and boards.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { listProjects, setProjectShortName } from "../../src/commands/project";
import { linkCrossProjectTask, unlinkCrossProjectTask } from "../../src/commands/task-cross-project-link";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../../src/core/api-contract";
import {
	getWorkspacesRootPath,
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	loadWorkspaceState,
	removeWorkspaceIndexEntry,
	saveWorkspaceState,
	setWorkspaceShortName,
} from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

function createRepository(root: string, name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
	return path;
}

function card(id: string): RuntimeBoardCard {
	return { id, title: id, prompt: id, startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };
}

function board(cards: Partial<Record<RuntimeBoardColumnId, string[]>>): RuntimeBoardData {
	const columns: Array<{ id: RuntimeBoardColumnId; title: string }> = [
		{ id: "backlog", title: "Backlog" },
		{ id: "in_progress", title: "In Progress" },
		{ id: "review", title: "Review" },
		{ id: "trash", title: "Done" },
	];
	return {
		columns: columns.map((column) => ({ ...column, cards: (cards[column.id] ?? []).map(card) })),
		dependencies: [],
	};
}

interface Sandbox {
	webPath: string;
	dbPath: string;
	strayPath: string;
	webId: string;
	dbId: string;
}

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
	await withTemporaryHome(async () => {
		const { path: root, cleanup } = createTempDir("kanban-cross-project-");
		try {
			const webPath = createRepository(root, "skedai-web");
			const dbPath = createRepository(root, "skedai-db");
			const strayPath = createRepository(root, "not-registered");
			const web = await loadWorkspaceContext(webPath);
			const db = await loadWorkspaceContext(dbPath);
			await saveWorkspaceState(webPath, { board: board({ backlog: ["web01"], trash: ["web02"] }), sessions: {} });
			await saveWorkspaceState(dbPath, {
				board: board({ backlog: ["db001"], in_progress: ["db002"], trash: ["db003"] }),
				sessions: {},
			});
			await run({ webPath, dbPath, strayPath, webId: web.workspaceId, dbId: db.workspaceId });
		} finally {
			cleanup();
		}
	});
}

async function dependsOnOf(projectPath: string, taskId: string) {
	const state = await loadWorkspaceState(projectPath);
	return state.board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId)?.dependsOn;
}

describe.sequential("sked fork: cross-project task links", () => {
	it("records a display-only ref to a task on another project's board", async () => {
		await withSandbox(async ({ webPath, dbPath, webId, dbId }) => {
			expect([webId, dbId]).toEqual(["skedai-web", "skedai-db"]);
			const saved: string[] = [];
			const result = await linkCrossProjectTask({
				cwd: webPath,
				taskId: "web01",
				linkedTaskId: "db002",
				linkedProject: { kind: "path", path: dbPath },
				onSaved: async (workspaceId) => {
					saved.push(workspaceId);
				},
			});

			expect(result).toMatchObject({
				ok: true,
				taskId: "web01",
				// Two projects sharing "skedai-": the default short name is "db".
				dependsOn: { taskId: "db002", projectId: "skedai-db", ref: "db#db002", column: "in_progress" },
			});
			expect(saved).toEqual(["skedai-web"]);
			expect(await dependsOnOf(webPath, "web01")).toEqual([{ taskId: "db002", projectId: "skedai-db" }]);
			const webState = await loadWorkspaceState(webPath);
			expect(webState.board.dependencies).toEqual([]);
			// The other project's board is untouched.
			expect((await loadWorkspaceState(dbPath)).revision).toBe(1);
		});
	});

	it("accepts the other project by ID and a backlog prerequisite", async () => {
		await withSandbox(async ({ webPath }) => {
			await linkCrossProjectTask({
				cwd: "/",
				projectPath: webPath,
				taskId: "web01",
				linkedTaskId: "db001",
				linkedProject: { kind: "id", workspaceId: "skedai-db" },
			});
			expect(await dependsOnOf(webPath, "web01")).toEqual([{ taskId: "db001", projectId: "skedai-db" }]);
		});
	});

	it("rejects invalid links with clear errors and leaves the board unchanged", async () => {
		await withSandbox(async ({ webPath, dbPath, strayPath }) => {
			const link = (overrides: Partial<Parameters<typeof linkCrossProjectTask>[0]>) =>
				linkCrossProjectTask({
					cwd: webPath,
					taskId: "web01",
					linkedTaskId: "db002",
					linkedProject: { kind: "path", path: dbPath },
					...overrides,
				});

			await expect(link({ linkedProject: { kind: "path", path: strayPath } })).rejects.toThrow(
				/Linked project .*not-registered.*is not added to Kanban yet/,
			);
			await expect(link({ linkedProject: { kind: "id", workspaceId: "skedai-nope" } })).rejects.toThrow(
				'Linked project "skedai-nope" is not added to Kanban.',
			);
			await expect(link({ linkedTaskId: "zzzzz" })).rejects.toThrow(
				'Task "zzzzz" was not found in project "skedai-db"',
			);
			await expect(link({ linkedTaskId: "db003" })).rejects.toThrow("is done; links cannot include done tasks");
			await expect(link({ linkedProject: { kind: "path", path: webPath } })).rejects.toThrow(
				"The linked project is this task's own project",
			);
			await expect(link({ taskId: "zzzzz" })).rejects.toThrow(
				'Task "zzzzz" was not found on this project\'s board.',
			);
			await expect(link({ taskId: "web02" })).rejects.toThrow("is done; a done task cannot wait on another");
			await expect(link({ cwd: strayPath })).rejects.toThrow("is not added to Kanban yet");

			const before = await loadWorkspaceState(webPath);
			await link({});
			await expect(link({})).rejects.toThrow('Task "web01" already depends on "db002" in project "skedai-db".');
			const after = await loadWorkspaceState(webPath);
			// Only the successful link was saved.
			expect(after.revision).toBe(before.revision + 1);
		});
	});

	it("unlinks by project path or ID, including a project removed from Kanban", async () => {
		await withSandbox(async ({ webPath, dbPath }) => {
			for (const linkedTaskId of ["db001", "db002"]) {
				await linkCrossProjectTask({
					cwd: webPath,
					taskId: "web01",
					linkedTaskId,
					linkedProject: { kind: "path", path: dbPath },
				});
			}

			const byPath = await unlinkCrossProjectTask({
				cwd: webPath,
				taskId: "web01",
				linkedTaskId: "db001",
				linkedProject: { kind: "path", path: dbPath },
			});
			expect(byPath).toMatchObject({ ok: true, removedDependsOn: { taskId: "db001", projectId: "skedai-db" } });
			expect(await dependsOnOf(webPath, "web01")).toEqual([{ taskId: "db002", projectId: "skedai-db" }]);

			await expect(
				unlinkCrossProjectTask({
					cwd: webPath,
					taskId: "web01",
					linkedTaskId: "db001",
					linkedProject: { kind: "path", path: dbPath },
				}),
			).rejects.toThrow('Task "web01" does not depend on "db001" in project "skedai-db".');

			await removeWorkspaceIndexEntry("skedai-db");
			await expect(
				unlinkCrossProjectTask({
					cwd: webPath,
					taskId: "web01",
					linkedTaskId: "db002",
					linkedProject: { kind: "path", path: dbPath },
				}),
			).rejects.toThrow("is not added to Kanban yet");
			const byId = await unlinkCrossProjectTask({
				cwd: webPath,
				taskId: "web01",
				linkedTaskId: "db002",
				linkedProject: { kind: "id", workspaceId: "skedai-db" },
			});
			expect(byId).toMatchObject({
				removedDependsOn: { projectId: "skedai-db", projectPath: null, ref: "skedai-db#db002" },
			});
			expect(await dependsOnOf(webPath, "web01")).toEqual([]);
		});
	});
});

describe.sequential("sked fork: project short names", () => {
	it("sets, displays and clears a short name, and keeps it unique", async () => {
		await withSandbox(async ({ webPath, dbPath }) => {
			expect(await listProjects()).toMatchObject({
				projects: [
					{ id: "skedai-db", shortName: null, displayShortName: "db" },
					{ id: "skedai-web", shortName: null, displayShortName: "web" },
				],
			});

			expect(await setProjectShortName({ set: "data" }, dbPath)).toMatchObject({
				project: { id: "skedai-db", shortName: "data", displayShortName: "data" },
			});
			await linkCrossProjectTask({
				cwd: webPath,
				taskId: "web01",
				linkedTaskId: "db002",
				linkedProject: { kind: "id", workspaceId: "skedai-db" },
			});
			await expect(
				linkCrossProjectTask({
					cwd: webPath,
					taskId: "web01",
					linkedTaskId: "db002",
					linkedProject: { kind: "id", workspaceId: "skedai-db" },
				}),
			).rejects.toThrow("already depends on");

			await expect(setProjectShortName({ projectId: "skedai-web", set: "data" }, "/")).rejects.toThrow(
				'Short name "data" is already used by project "skedai-db".',
			);
			await expect(setProjectShortName({ projectPath: webPath, set: "skedai-db" }, "/")).rejects.toThrow(
				'Short name "skedai-db" is the ID of another project.',
			);
			await expect(setProjectShortName({ projectPath: webPath, set: "Web" }, "/")).rejects.toThrow("lowercase");
			await expect(setProjectShortName({ projectPath: webPath }, "/")).rejects.toThrow("exactly one of");
			await expect(setProjectShortName({ projectPath: webPath, set: "w", clear: true }, "/")).rejects.toThrow(
				"exactly one of",
			);
			await expect(setWorkspaceShortName("skedai-nope", "x")).rejects.toThrow('Project "skedai-nope" is not added');

			// Re-setting a project's own short name is not a clash.
			await setProjectShortName({ projectId: "skedai-db", set: "data" }, "/");
			expect(await setProjectShortName({ projectId: "skedai-db", clear: true }, "/")).toMatchObject({
				project: { shortName: null, displayShortName: "db" },
			});
			const raw = JSON.parse(readFileSync(join(getWorkspacesRootPath(), "index.json"), "utf8"));
			expect(raw.entries["skedai-db"]).not.toHaveProperty("shortName");
		});
	});

	it("keeps a short name when another project is added or removed", async () => {
		await withSandbox(async ({ dbPath, strayPath }) => {
			await setWorkspaceShortName("skedai-db", "db");
			await loadWorkspaceContext(strayPath);
			await removeWorkspaceIndexEntry("skedai-web");
			const entries = await listWorkspaceIndexEntries();
			expect(entries.find((entry) => entry.workspaceId === "skedai-db")).toMatchObject({ shortName: "db" });
			expect((await loadWorkspaceContext(dbPath, { autoCreateIfMissing: false })).workspaceId).toBe("skedai-db");
		});
	});
});

describe.sequential("sked fork: state files written before cross-project links", () => {
	it("loads an index.json without short names", async () => {
		await withTemporaryHome(async () => {
			mkdirSync(getWorkspacesRootPath(), { recursive: true });
			writeFileSync(
				join(getWorkspacesRootPath(), "index.json"),
				JSON.stringify({
					version: 1,
					entries: {
						"skedai-db": { workspaceId: "skedai-db", repoPath: "/repos/skedai-db" },
						"sked-ai": { workspaceId: "sked-ai", repoPath: "/repos/sked-ai" },
					},
					repoPathToId: { "/repos/skedai-db": "skedai-db", "/repos/sked-ai": "sked-ai" },
				}),
				"utf8",
			);

			expect(await listWorkspaceIndexEntries()).toEqual([
				{ workspaceId: "sked-ai", repoPath: "/repos/sked-ai" },
				{ workspaceId: "skedai-db", repoPath: "/repos/skedai-db" },
			]);
			expect(await listProjects()).toMatchObject({
				projects: [
					{ id: "sked-ai", shortName: null, displayShortName: "sked-ai" },
					{ id: "skedai-db", shortName: null, displayShortName: "skedai-db" },
				],
			});
			await setWorkspaceShortName("skedai-db", "db");
			const raw = JSON.parse(readFileSync(join(getWorkspacesRootPath(), "index.json"), "utf8"));
			expect(raw.version).toBe(1);
			expect(raw.entries["skedai-db"]).toEqual({
				workspaceId: "skedai-db",
				repoPath: "/repos/skedai-db",
				shortName: "db",
			});
			expect(raw.entries["sked-ai"]).toEqual({ workspaceId: "sked-ai", repoPath: "/repos/sked-ai" });
		});
	});

	it("loads a board.json without dependsOn, and keeps cross-project refs through a save", async () => {
		await withTemporaryHome(async () => {
			const { path: root, cleanup } = createTempDir("kanban-cross-project-board-");
			try {
				const webPath = createRepository(root, "skedai-web");
				const context = await loadWorkspaceContext(webPath);
				mkdirSync(context.statePath, { recursive: true });
				const legacyCard = (id: string) => ({
					id,
					prompt: id,
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 1,
					updatedAt: 1,
				});
				writeFileSync(
					join(context.statePath, "board.json"),
					JSON.stringify({
						columns: [
							{ id: "backlog", title: "Backlog", cards: [legacyCard("web01")] },
							{ id: "in_progress", title: "In Progress", cards: [] },
							{ id: "review", title: "Review", cards: [] },
							{ id: "trash", title: "Done", cards: [] },
						],
						dependencies: [],
					}),
					"utf8",
				);

				const loaded = await loadWorkspaceState(webPath);
				expect(loaded.board.columns[0]?.cards[0]?.dependsOn).toBeUndefined();

				const withRef = board({ backlog: ["web01"] });
				const first = withRef.columns[0]?.cards[0];
				if (!first) {
					throw new Error("missing card");
				}
				first.dependsOn = [{ taskId: "web00" }, { taskId: "db002", projectId: "skedai-db" }];
				await saveWorkspaceState(webPath, { board: withRef, sessions: {} });
				const raw = JSON.parse(readFileSync(join(context.statePath, "board.json"), "utf8"));
				expect(raw.columns[0].cards[0].dependsOn).toEqual([
					{ taskId: "web00" },
					{ taskId: "db002", projectId: "skedai-db" },
				]);
				expect((await loadWorkspaceState(webPath)).board.columns[0]?.cards[0]?.dependsOn).toEqual([
					{ taskId: "web00" },
					{ taskId: "db002", projectId: "skedai-db" },
				]);
			} finally {
				cleanup();
			}
		});
	});
});
