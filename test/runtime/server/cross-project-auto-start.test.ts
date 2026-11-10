// sked fork: the runtime starts cards on other boards when their last open prerequisite finishes.
import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskDependsOnRef,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { getTaskColumnId } from "../../../src/core/task-board-mutations";
import {
	type CrossProjectAutoStartScope,
	createCrossProjectAutoStarter,
	moveBacklogTaskToInProgressOnBoard,
} from "../../../src/server/cross-project-auto-start";
import type { ProjectBoardSnapshot } from "../../../src/server/workspace-registry";

function card(id: string, dependsOn?: RuntimeTaskDependsOnRef[]): RuntimeBoardCard {
	return {
		id,
		title: `Title of ${id}`,
		prompt: `Prompt for ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...(dependsOn ? { dependsOn } : {}),
	};
}

function board(cards: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	const columns: Array<{ id: RuntimeBoardColumnId; title: string }> = [
		{ id: "backlog", title: "Backlog" },
		{ id: "in_progress", title: "In Progress" },
		{ id: "review", title: "Review" },
		{ id: "trash", title: "Done" },
	];
	return { columns: columns.map((column) => ({ ...column, cards: cards[column.id] ?? [] })), dependencies: [] };
}

function running(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/x",
		pid: 1,
		startedAt: 2,
		updatedAt: 2,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

/** In-memory projects whose boards the fake dependencies read and write. */
function createHarness(
	boards: Record<string, RuntimeBoardData>,
	sessions: Record<string, RuntimeTaskSessionSummary[]> = {},
) {
	const started: Array<{ projectId: string; request: RuntimeTaskSessionStartRequest }> = [];
	const notified: string[] = [];
	let failStartFor: string | null = null;
	const pathOf = (projectId: string) => `/repos/${projectId}`;
	const starter = createCrossProjectAutoStarter({
		loadProjectBoards: async (): Promise<ProjectBoardSnapshot[]> =>
			Object.entries(boards).map(([workspaceId, projectBoard]) => ({
				workspaceId,
				repoPath: pathOf(workspaceId),
				board: projectBoard,
				sessionsByTaskId: new Map((sessions[workspaceId] ?? []).map((summary) => [summary.taskId, summary])),
			})),
		ensureTaskWorktree: async ({ cwd, taskId, baseRef }) => ({
			ok: true,
			path: `${cwd}/worktrees/${taskId}`,
			baseRef,
			baseCommit: "abc",
		}),
		moveBacklogTaskToInProgress: async (repoPath, taskId) => {
			const projectId = repoPath.replace("/repos/", "");
			const projectBoard = boards[projectId];
			const moved = projectBoard ? moveBacklogTaskToInProgressOnBoard(projectBoard, taskId) : null;
			if (moved) {
				boards[projectId] = moved;
			}
			return moved !== null;
		},
		notifyWorkspaceStateUpdated: (scope) => {
			notified.push(scope.workspaceId);
		},
	});
	const startTaskSession = async (scope: CrossProjectAutoStartScope, request: RuntimeTaskSessionStartRequest) => {
		// Yield, so two runs would interleave here if they were not serialized.
		await new Promise((resolve) => setTimeout(resolve, 5));
		if (request.taskId === failStartFor) {
			return { ok: false, summary: null, error: "No runnable agent command is configured." };
		}
		started.push({ projectId: scope.workspaceId, request });
		return { ok: true, summary: running(request.taskId) };
	};
	return {
		boards,
		started,
		notified,
		failStart: (taskId: string) => {
			failStartFor = taskId;
		},
		finish: (projectId: string, taskId: string) => starter.startDependents({ projectId, taskId, startTaskSession }),
	};
}

const WEB = "skedai-web";
const DB = "skedai-db";
const API = "skedai-api";

describe("createCrossProjectAutoStarter", () => {
	it("starts a waiting card on another board with a session, then moves it to In Progress", async () => {
		const harness = createHarness({
			[DB]: board({ trash: [card("db1")] }),
			[WEB]: board({ backlog: [card("web1", [{ taskId: "db1", projectId: DB }])] }),
		});
		const response = await harness.finish(DB, "db1");
		expect(response).toEqual({
			ok: true,
			startedTasks: [{ projectId: WEB, taskId: "web1", title: "Title of web1" }],
			failedTasks: [],
		});
		expect(harness.started).toEqual([
			{
				projectId: WEB,
				request: expect.objectContaining({ taskId: "web1", prompt: "Prompt for web1", baseRef: "main" }),
			},
		]);
		expect(getTaskColumnId(harness.boards[WEB] as RuntimeBoardData, "web1")).toBe("in_progress");
		expect(harness.notified).toEqual([WEB]);
	});

	it("leaves a card that something else still blocks, on its own board or a third one", async () => {
		const harness = createHarness({
			[DB]: board({ trash: [card("db1")] }),
			[API]: board({ review: [card("api1")] }),
			[WEB]: board({
				backlog: [
					card("sameBoardOpen", [{ taskId: "db1", projectId: DB }, { taskId: "web9" }]),
					card("thirdBoardOpen", [
						{ taskId: "db1", projectId: DB },
						{ taskId: "api1", projectId: API },
					]),
				],
				in_progress: [card("web9")],
			}),
		});
		const response = await harness.finish(DB, "db1");
		expect(response.startedTasks).toEqual([]);
		expect(harness.started).toEqual([]);
	});

	it("starts nothing when the finished card is not Done after all (the move was lost)", async () => {
		const harness = createHarness({
			[DB]: board({ review: [card("db1")] }),
			[WEB]: board({ backlog: [card("web1", [{ taskId: "db1", projectId: DB }])] }),
		});
		expect((await harness.finish(DB, "db1")).startedTasks).toEqual([]);
	});

	it("never starts a card on the finished card's own board, or one whose session already runs", async () => {
		const harness = createHarness(
			{
				[DB]: board({ trash: [card("db1")], backlog: [card("db2", [{ taskId: "db1", projectId: DB }])] }),
				[WEB]: board({ backlog: [card("web1", [{ taskId: "db1", projectId: DB }])] }),
			},
			{ [WEB]: [running("web1")] },
		);
		expect((await harness.finish(DB, "db1")).startedTasks).toEqual([]);
	});

	it("starts a card once when its two cross-project prerequisites finish at the same time", async () => {
		const harness = createHarness({
			[DB]: board({ trash: [card("db1")] }),
			[API]: board({ trash: [card("api1")] }),
			[WEB]: board({
				backlog: [
					card("web1", [
						{ taskId: "db1", projectId: DB },
						{ taskId: "api1", projectId: API },
					]),
				],
			}),
		});
		const [first, second] = await Promise.all([harness.finish(DB, "db1"), harness.finish(API, "api1")]);
		expect([...first.startedTasks, ...second.startedTasks].map((task) => task.taskId)).toEqual(["web1"]);
		expect(harness.started).toHaveLength(1);
	});

	it("reports a card it could not start and leaves it in Backlog", async () => {
		const harness = createHarness({
			[DB]: board({ trash: [card("db1")] }),
			[WEB]: board({ backlog: [card("web1", [{ taskId: "db1", projectId: DB }])] }),
		});
		harness.failStart("web1");
		const response = await harness.finish(DB, "db1");
		expect(response).toMatchObject({
			ok: false,
			startedTasks: [],
			failedTasks: [{ projectId: WEB, taskId: "web1", error: "No runnable agent command is configured." }],
		});
		expect(getTaskColumnId(harness.boards[WEB] as RuntimeBoardData, "web1")).toBe("backlog");
	});
});
