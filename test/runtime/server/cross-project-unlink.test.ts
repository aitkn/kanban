import { describe, expect, it, vi } from "vitest";
import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskDependsOnRef,
	RuntimeWorkspaceStateResponse,
} from "../../../src/core/api-contract";
import {
	type CrossProjectUnlinkDependencies,
	unlinkCrossProjectDependent,
} from "../../../src/server/cross-project-unlink";
import type { RuntimeWorkspaceIndexEntry } from "../../../src/state/workspace-state";

function card(id: string, dependsOn?: RuntimeTaskDependsOnRef[]): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...(dependsOn ? { dependsOn } : {}),
	};
}

function board(cards: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

const projects: RuntimeWorkspaceIndexEntry[] = [
	{ workspaceId: "web", repoPath: "/repos/web" },
	{ workspaceId: "db", repoPath: "/repos/db" },
];

/** Fake storage: one board per repo path, mutated the way `mutateWorkspaceState` does. */
function createDeps(boards: Record<string, RuntimeBoardData>) {
	const saved: string[] = [];
	const notifyWorkspaceStateUpdated = vi.fn();
	const deps: CrossProjectUnlinkDependencies = {
		listProjects: async () => projects,
		mutateWorkspaceState: async (repoPath, mutate) => {
			const current = boards[repoPath];
			if (!current) {
				throw new Error(`no board at ${repoPath}`);
			}
			const state = { board: current } as RuntimeWorkspaceStateResponse;
			const mutation = mutate(state);
			if (mutation.save !== false) {
				boards[repoPath] = mutation.board;
				saved.push(repoPath);
			}
			return { value: mutation.value, state, saved: mutation.save !== false };
		},
		notifyWorkspaceStateUpdated,
	};
	return { deps, boards, saved, notifyWorkspaceStateUpdated };
}

function dependsOnOf(data: RuntimeBoardData | undefined, taskId: string): RuntimeTaskDependsOnRef[] | undefined {
	return data?.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId)?.dependsOn;
}

describe("sked fork: unlink a cross-project dependent from the prerequisite's side", () => {
	it("removes the entry from the dependent's board, keeps its other refs, and notifies that board", async () => {
		const { deps, boards, saved, notifyWorkspaceStateUpdated } = createDeps({
			"/repos/web": board([
				card("wait1", [
					{ taskId: "dbA", projectId: "db" },
					{ taskId: "dbB", projectId: "db" },
					{ taskId: "local" },
				]),
				card("local"),
			]),
		});

		const response = await unlinkCrossProjectDependent(deps, "db", {
			taskId: "dbA",
			dependentProjectId: "web",
			dependentTaskId: "wait1",
		});

		expect(response).toEqual({ ok: true });
		expect(saved).toEqual(["/repos/web"]);
		expect(dependsOnOf(boards["/repos/web"], "wait1")).toEqual([
			{ taskId: "dbB", projectId: "db" },
			{ taskId: "local" },
		]);
		expect(notifyWorkspaceStateUpdated).toHaveBeenCalledWith({ workspaceId: "web", workspacePath: "/repos/web" });
	});

	it("only removes a ref naming the REQUEST's project, not a same-id task on another board", async () => {
		const { deps, saved, notifyWorkspaceStateUpdated } = createDeps({
			"/repos/web": board([card("wait1", [{ taskId: "dbA", projectId: "api" }, { taskId: "dbA" }])]),
		});

		const response = await unlinkCrossProjectDependent(deps, "db", {
			taskId: "dbA",
			dependentProjectId: "web",
			dependentTaskId: "wait1",
		});

		expect(response).toEqual({ ok: false, error: 'Task "wait1" no longer depends on "dbA".' });
		expect(saved).toEqual([]);
		expect(notifyWorkspaceStateUpdated).not.toHaveBeenCalled();
	});

	it("reports a dependent that was deleted, and a project that was removed, without writing", async () => {
		const { deps, saved, notifyWorkspaceStateUpdated } = createDeps({ "/repos/web": board([]) });

		expect(
			await unlinkCrossProjectDependent(deps, "db", {
				taskId: "dbA",
				dependentProjectId: "web",
				dependentTaskId: "wait1",
			}),
		).toEqual({ ok: false, error: 'Task "wait1" no longer exists.' });
		expect(
			await unlinkCrossProjectDependent(deps, "db", {
				taskId: "dbA",
				dependentProjectId: "gone",
				dependentTaskId: "wait1",
			}),
		).toEqual({ ok: false, error: 'Project "gone" is not added to Kanban.' });
		expect(saved).toEqual([]);
		expect(notifyWorkspaceStateUpdated).not.toHaveBeenCalled();
	});
});
