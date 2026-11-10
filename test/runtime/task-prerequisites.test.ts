// sked fork: the one rule for whether a card may start, and the join it drives.
import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskDependsOnRef,
	RuntimeTaskSessionSummary,
} from "../../src/core/api-contract";
import {
	addTaskDependency,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
} from "../../src/core/task-board-mutations";
import {
	createCrossProjectTaskLookup,
	findBacklogTasksWaitingOnCrossProjectTask,
	isPrerequisiteFinishingMove,
	isTaskBlockedByPrerequisites,
	listOpenPrerequisites,
	NO_CROSS_PROJECT_TASKS,
	type PrerequisiteContext,
} from "../../src/core/task-prerequisites";
import { collectReferencedTasksByProjectId } from "../../src/server/cross-project-task-refs";

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

function session(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "claude",
		workspacePath: "/tmp/x",
		pid: null,
		startedAt: 2,
		updatedAt: 2,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

const SAME_BOARD_ONLY: PrerequisiteContext = { lookupCrossProjectTask: NO_CROSS_PROJECT_TASKS };
const DB_REF = { taskId: "dbtask", projectId: "skedai-db" };

/** A lookup that knows one card on the db board, in `columnId`. */
function dbTaskIn(columnId: RuntimeBoardColumnId): PrerequisiteContext {
	return {
		lookupCrossProjectTask: createCrossProjectTaskLookup([
			{ id: "skedai-db", referencedTasks: [{ taskId: "dbtask", title: "DB task", columnId }] },
		]),
	};
}

describe("listOpenPrerequisites", () => {
	it("lists a same-board prerequisite that is still open, with its column and title", () => {
		const linked = addTaskDependency(board({ backlog: [card("wait"), card("pre")] }), "wait", "pre");
		const moved = moveTaskToColumn(linked.board, "pre", "in_progress").board;
		expect(listOpenPrerequisites(moved, "wait", SAME_BOARD_ONLY)).toEqual([
			{ taskId: "pre", columnId: "in_progress", title: "Title of pre" },
		]);
		expect(isTaskBlockedByPrerequisites(moved, "wait", SAME_BOARD_ONLY)).toBe(true);
	});

	it("still sees a same-board prerequisite whose live link was pruned", () => {
		// The link went when "pre" reached Done; "pre" was then restored to Review, so it blocks again.
		const restored = board({ backlog: [card("wait", [{ taskId: "pre" }])], review: [card("pre")] });
		expect(restored.dependencies).toEqual([]);
		expect(listOpenPrerequisites(restored, "wait", SAME_BOARD_ONLY)).toEqual([
			{ taskId: "pre", columnId: "review", title: "Title of pre" },
		]);
	});

	it("does not count a same-board prerequisite that is done or was deleted", () => {
		const done = board({ backlog: [card("wait", [{ taskId: "pre" }, { taskId: "gone" }])], trash: [card("pre")] });
		expect(listOpenPrerequisites(done, "wait", SAME_BOARD_ONLY)).toEqual([]);
	});

	it("blocks on a cross-project prerequisite while it is open and not once it is done", () => {
		const waiting = board({ backlog: [card("wait", [DB_REF])] });
		expect(listOpenPrerequisites(waiting, "wait", dbTaskIn("review"))).toEqual([
			{ taskId: "dbtask", projectId: "skedai-db", columnId: "review", title: "DB task" },
		]);
		expect(isTaskBlockedByPrerequisites(waiting, "wait", dbTaskIn("trash"))).toBe(false);
	});

	it("does not block on a cross-project card that was deleted, or whose project was removed", () => {
		const waiting = board({ backlog: [card("wait", [DB_REF, { taskId: "x", projectId: "skedai-removed" }])] });
		// The db project exists but no longer has the card; the removed project is not listed at all.
		const lookup = createCrossProjectTaskLookup([{ id: "skedai-db", referencedTasks: [] }]);
		expect(listOpenPrerequisites(waiting, "wait", { lookupCrossProjectTask: lookup })).toEqual([]);
	});

	it("judges a cross-project card by its live column when its board lags its session", () => {
		// On disk the db card is still In Progress; its session says the turn ended (Review), or was
		// interrupted (shown as Done). The waiting board resolves the ref the way chips do.
		const waitingBoard = board({ backlog: [card("wait", [DB_REF])] });
		const dbBoard = board({ in_progress: [card("dbtask")] });
		const contextFor = (state: RuntimeTaskSessionSummary["state"]): PrerequisiteContext => {
			const referenced = collectReferencedTasksByProjectId([
				{ workspaceId: "skedai-web", board: waitingBoard },
				{
					workspaceId: "skedai-db",
					board: dbBoard,
					sessionsByTaskId: new Map([["dbtask", session("dbtask", state)]]),
				},
			]);
			return {
				lookupCrossProjectTask: createCrossProjectTaskLookup(
					[...referenced].map(([id, referencedTasks]) => ({ id, referencedTasks })),
				),
			};
		};
		expect(listOpenPrerequisites(waitingBoard, "wait", contextFor("awaiting_review"))).toEqual([
			{ taskId: "dbtask", projectId: "skedai-db", columnId: "review", title: "Title of dbtask" },
		]);
		expect(isTaskBlockedByPrerequisites(waitingBoard, "wait", contextFor("interrupted"))).toBe(false);
	});

	it("applies live sessions to same-board prerequisites when given them", () => {
		const waiting = board({ backlog: [card("wait", [{ taskId: "pre" }])], in_progress: [card("pre")] });
		const sessions = { pre: session("pre", "interrupted") };
		expect(isTaskBlockedByPrerequisites(waiting, "wait", SAME_BOARD_ONLY)).toBe(true);
		expect(isTaskBlockedByPrerequisites(waiting, "wait", { ...SAME_BOARD_ONLY, sessions })).toBe(false);
	});

	it("lists same-board prerequisites first and each cross-project ref once", () => {
		const waiting = board({
			backlog: [card("wait", [DB_REF, { taskId: "pre" }, DB_REF])],
			review: [card("pre")],
		});
		expect(listOpenPrerequisites(waiting, "wait", dbTaskIn("in_progress")).map((open) => open.taskId)).toEqual([
			"pre",
			"dbtask",
		]);
	});
});

describe("isPrerequisiteFinishingMove", () => {
	it("counts only a move from Review", () => {
		expect(isPrerequisiteFinishingMove("review")).toBe(true);
		for (const columnId of ["backlog", "in_progress", "trash", null] as const) {
			expect(isPrerequisiteFinishingMove(columnId)).toBe(false);
		}
	});
});

describe("findBacklogTasksWaitingOnCrossProjectTask", () => {
	it("finds backlog cards naming the task in that project only", () => {
		const web = board({
			backlog: [card("a", [DB_REF]), card("b", [{ taskId: "dbtask", projectId: "skedai-other" }]), card("c")],
			in_progress: [card("d", [DB_REF])],
		});
		expect(findBacklogTasksWaitingOnCrossProjectTask(web, "skedai-db", "dbtask")).toEqual(["a"]);
	});
});

describe("trashTaskAndGetReadyLinkedTaskIds with cross-project refs", () => {
	function waitingOnSameBoardAndDb(): RuntimeBoardData {
		const linked = addTaskDependency(board({ backlog: [card("wait", [DB_REF]), card("pre")] }), "wait", "pre");
		return moveTaskToColumn(linked.board, "pre", "review").board;
	}

	it("holds back the waiting card while its cross-project prerequisite is open", () => {
		const trashed = trashTaskAndGetReadyLinkedTaskIds(waitingOnSameBoardAndDb(), "pre", dbTaskIn("in_progress"));
		expect(trashed.moved).toBe(true);
		expect(trashed.readyTaskIds).toEqual([]);
	});

	it("starts the waiting card once its cross-project prerequisite is done too", () => {
		const trashed = trashTaskAndGetReadyLinkedTaskIds(waitingOnSameBoardAndDb(), "pre", dbTaskIn("trash"));
		expect(trashed.readyTaskIds).toEqual(["wait"]);
	});

	it("starts a card waiting through `dependsOn` alone when that prerequisite finishes", () => {
		const restored = board({ backlog: [card("wait", [{ taskId: "pre" }])], review: [card("pre")] });
		expect(trashTaskAndGetReadyLinkedTaskIds(restored, "pre", SAME_BOARD_ONLY).readyTaskIds).toEqual(["wait"]);
		// Moved to Done from In Progress it does not finish: the card stays for a manual start.
		const running = moveTaskToColumn(restored, "pre", "in_progress").board;
		expect(trashTaskAndGetReadyLinkedTaskIds(running, "pre", SAME_BOARD_ONLY).readyTaskIds).toEqual([]);
	});
});
