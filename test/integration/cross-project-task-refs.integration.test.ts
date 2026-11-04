// sked fork: cross-project chip status as the runtime state stream delivers it, built from a real
// project registry and real boards by `buildProjectsPayload`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../src/config/runtime-config";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectSummary,
	RuntimeTaskSessionSummary,
} from "../../src/core/api-contract";
import { createWorkspaceRegistry, type WorkspaceRegistry } from "../../src/server/workspace-registry";
import {
	getWorkspacesRootPath,
	loadWorkspaceContext,
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

function card(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: `Title ${id}`,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function board(cards: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	const columns: Array<{ id: RuntimeBoardColumnId; title: string }> = [
		{ id: "backlog", title: "Backlog" },
		{ id: "in_progress", title: "In Progress" },
		{ id: "review", title: "Review" },
		{ id: "trash", title: "Done" },
	];
	return {
		columns: columns.map((column) => ({ ...column, cards: cards[column.id] ?? [] })),
		dependencies: [],
	};
}

function session(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "claude",
		workspacePath: null,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

interface Sandbox {
	registry: WorkspaceRegistry;
	webId: string;
	dbId: string;
	dbPath: string;
}

async function withSandbox(run: (sandbox: Sandbox) => Promise<void>): Promise<void> {
	await withTemporaryHome(async () => {
		const { path: root, cleanup } = createTempDir("kanban-cross-project-refs-");
		try {
			const webPath = createRepository(root, "skedai-web");
			const dbPath = createRepository(root, "skedai-db");
			const web = await loadWorkspaceContext(webPath);
			const db = await loadWorkspaceContext(dbPath);
			await saveWorkspaceState(dbPath, {
				board: board({ in_progress: [card("dbProg")], review: [card("dbRevw")] }),
				// The agent ended its turn, but no browser had db open to move the card.
				sessions: { dbProg: session("dbProg", "awaiting_review") },
			});
			await saveWorkspaceState(webPath, {
				board: board({
					backlog: [
						card("wait1", {
							dependsOn: [
								{ taskId: "dbProg", projectId: db.workspaceId },
								{ taskId: "dbRevw", projectId: db.workspaceId },
								{ taskId: "dbGone", projectId: db.workspaceId },
							],
						}),
					],
				}),
				sessions: {},
			});
			const registry = await createWorkspaceRegistry({
				cwd: webPath,
				loadGlobalRuntimeConfig,
				loadRuntimeConfig,
				hasGitRepository: (path) => existsSync(join(path, ".git")),
				pathIsDirectory: async (path) => existsSync(path) && statSync(path).isDirectory(),
			});
			await run({ registry, webId: web.workspaceId, dbId: db.workspaceId, dbPath });
		} finally {
			cleanup();
		}
	});
}

function summaryOf(projects: RuntimeProjectSummary[], id: string): RuntimeProjectSummary {
	const found = projects.find((project) => project.id === id);
	if (!found) {
		throw new Error(`No summary for ${id}`);
	}
	return found;
}

describe.sequential("sked fork: cross-project task refs in the projects payload", () => {
	it("carries each project's short name and the tasks other boards reference", async () => {
		await withSandbox(async ({ registry, webId, dbId }) => {
			await setWorkspaceShortName(dbId, "db");
			const { projects } = await registry.buildProjectsPayload(webId);

			expect(summaryOf(projects, dbId).shortName).toBe("db");
			// Derived: the ID minus the "skedai-" prefix both projects share.
			expect(summaryOf(projects, webId).shortName).toBe("web");
			// The deleted card is absent; nothing references web from elsewhere.
			expect(summaryOf(projects, dbId).referencedTasks).toEqual([
				{ taskId: "dbProg", title: "Title dbProg", columnId: "in_progress" },
				{ taskId: "dbRevw", title: "Title dbRevw", columnId: "review" },
			]);
			expect(summaryOf(projects, webId).referencedTasks).toEqual([]);
		});
	});

	it("applies the other project's live sessions once they are loaded", async () => {
		await withSandbox(async ({ registry, webId, dbId, dbPath }) => {
			await registry.ensureTerminalManagerForWorkspace(dbId, dbPath);
			const { projects } = await registry.buildProjectsPayload(webId);

			expect(summaryOf(projects, dbId).referencedTasks?.find((task) => task.taskId === "dbProg")?.columnId).toBe(
				"review",
			);
		});
	});

	it("keeps the last-read status when the other board cannot be read", async () => {
		await withSandbox(async ({ registry, webId, dbId }) => {
			const before = summaryOf((await registry.buildProjectsPayload(webId)).projects, dbId).referencedTasks;
			writeFileSync(join(getWorkspacesRootPath(), dbId, "board.json"), "{ not json");

			const after = summaryOf((await registry.buildProjectsPayload(webId)).projects, dbId).referencedTasks;

			expect(after).toEqual(before);
			expect(after).toHaveLength(2);
		});
	});
});
