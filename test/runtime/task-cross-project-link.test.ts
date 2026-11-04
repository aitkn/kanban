import { describe, expect, it } from "vitest";
import { parseLinkedProjectSelector, parseTaskUnlinkTarget } from "../../src/commands/task-cross-project-link";
import type { RuntimeBoardData } from "../../src/core/api-contract";
import {
	addCrossProjectPrerequisite,
	addTaskToColumn,
	countPendingPrerequisites,
	moveTaskToColumn,
	removeCrossProjectPrerequisite,
	trashTaskAndGetReadyLinkedTaskIds,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	const empty: RuntimeBoardData = {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
	const waiting = addTaskToColumn(empty, "backlog", { prompt: "Waiting", baseRef: "main" }, () => "wwwww111");
	return addTaskToColumn(waiting.board, "trash", { prompt: "Done", baseRef: "main" }, () => "ddddd111").board;
}

function dependsOnOf(board: RuntimeBoardData, taskId: string) {
	return board.columns.flatMap((column) => column.cards).find((card) => card.id === taskId)?.dependsOn;
}

const DB_TASK = { taskId: "c64f9", projectId: "skedai-db" };

describe("sked fork: cross-project prerequisites", () => {
	it("records the ref on the waiting card without creating a board link", () => {
		const result = addCrossProjectPrerequisite(createBoard(), "wwwww", DB_TASK);
		if (!result.added) {
			throw new Error(`expected the ref to be added, got ${result.reason}`);
		}
		expect(dependsOnOf(result.board, "wwwww")).toEqual([DB_TASK]);
		expect(result.board.dependencies).toEqual([]);
		expect(countPendingPrerequisites(result.board, "wwwww")).toBe(0);
	});

	it("keeps the ref when the waiting card moves and never reports it ready to start", () => {
		const linked = addCrossProjectPrerequisite(createBoard(), "wwwww", DB_TASK);
		if (!linked.added) {
			throw new Error("expected the ref to be added");
		}
		const moved = moveTaskToColumn(linked.board, "wwwww", "review");
		const trashed = trashTaskAndGetReadyLinkedTaskIds(moved.board, "wwwww");
		expect(trashed.readyTaskIds).toEqual([]);
		expect(dependsOnOf(trashed.board, "wwwww")).toEqual([DB_TASK]);
	});

	it("allows the same task ID in two other projects", () => {
		let board = createBoard();
		for (const ref of [DB_TASK, { taskId: "c64f9", projectId: "skedai-web" }]) {
			const result = addCrossProjectPrerequisite(board, "wwwww", ref);
			if (!result.added) {
				throw new Error(`expected ${ref.projectId} to be added`);
			}
			board = result.board;
		}
		expect(dependsOnOf(board, "wwwww")).toEqual([DB_TASK, { taskId: "c64f9", projectId: "skedai-web" }]);
	});

	it("refuses a missing waiting card, a done waiting card and a duplicate", () => {
		const board = createBoard();
		expect(addCrossProjectPrerequisite(board, "nope", DB_TASK)).toEqual({ added: false, reason: "missing_task" });
		expect(addCrossProjectPrerequisite(board, "ddddd", DB_TASK)).toEqual({ added: false, reason: "trash_task" });
		const once = addCrossProjectPrerequisite(board, "wwwww", DB_TASK);
		if (!once.added) {
			throw new Error("expected the ref to be added");
		}
		expect(addCrossProjectPrerequisite(once.board, "wwwww", { ...DB_TASK })).toEqual({
			added: false,
			reason: "duplicate",
		});
	});

	it("removes only the matching cross-project ref", () => {
		const board = createBoard();
		const card = board.columns[0]?.cards[0];
		if (!card) {
			throw new Error("missing card");
		}
		card.dependsOn = [{ taskId: "c64f9" }, DB_TASK, { taskId: "c64f9", projectId: "skedai-web" }];
		const removed = removeCrossProjectPrerequisite(board, "wwwww", DB_TASK);
		if (!removed.removed) {
			throw new Error(`expected the ref to be removed, got ${removed.reason}`);
		}
		expect(dependsOnOf(removed.board, "wwwww")).toEqual([
			{ taskId: "c64f9" },
			{ taskId: "c64f9", projectId: "skedai-web" },
		]);
		expect(removeCrossProjectPrerequisite(removed.board, "wwwww", DB_TASK)).toEqual({
			removed: false,
			reason: "not_linked",
		});
		expect(removeCrossProjectPrerequisite(board, "nope", DB_TASK)).toEqual({
			removed: false,
			reason: "missing_task",
		});
	});
});

describe("sked fork: task link/unlink option parsing", () => {
	it("reads the linked project from a path or an ID, not both", () => {
		expect(parseLinkedProjectSelector({})).toBeNull();
		expect(parseLinkedProjectSelector({ linkedProjectPath: "../db" })).toEqual({ kind: "path", path: "../db" });
		expect(parseLinkedProjectSelector({ linkedProjectId: "skedai-db" })).toEqual({
			kind: "id",
			workspaceId: "skedai-db",
		});
		expect(() => parseLinkedProjectSelector({ linkedProjectPath: "../db", linkedProjectId: "skedai-db" })).toThrow(
			"only one of",
		);
	});

	it("refuses an option passed empty instead of treating it as absent", () => {
		expect(() => parseLinkedProjectSelector({ linkedProjectId: "" })).toThrow("--linked-project-id cannot be empty.");
		expect(() => parseLinkedProjectSelector({ linkedProjectPath: "  " })).toThrow(
			"--linked-project-path cannot be empty.",
		);
		expect(() => parseTaskUnlinkTarget({ taskId: "a", linkedTaskId: "b", linkedProjectId: "" })).toThrow(
			"--linked-project-id cannot be empty.",
		);
		expect(() => parseTaskUnlinkTarget({ dependencyId: "" })).toThrow("--dependency-id cannot be empty.");
	});

	it("unlinks a same-board link by dependency ID alone", () => {
		expect(parseTaskUnlinkTarget({ dependencyId: "dep-1" })).toEqual({ kind: "dependency", dependencyId: "dep-1" });
		expect(() => parseTaskUnlinkTarget({ dependencyId: "dep-1", taskId: "a" })).toThrow("--dependency-id");
		expect(() => parseTaskUnlinkTarget({ dependencyId: "dep-1", linkedProjectId: "skedai-db" })).toThrow(
			"--dependency-id",
		);
	});

	it("unlinks a cross-project ref by both task IDs and the other project", () => {
		expect(parseTaskUnlinkTarget({ taskId: "a", linkedTaskId: "b", linkedProjectId: "skedai-db" })).toEqual({
			kind: "cross_project",
			taskId: "a",
			linkedTaskId: "b",
			linkedProject: { kind: "id", workspaceId: "skedai-db" },
		});
		expect(parseTaskUnlinkTarget({ taskId: "a", linkedTaskId: "b", linkedProjectPath: "../db" })).toMatchObject({
			linkedProject: { kind: "path", path: "../db" },
		});
	});

	it("unlinks a same-board prerequisite by both task IDs", () => {
		expect(parseTaskUnlinkTarget({ taskId: "a", linkedTaskId: "b" })).toEqual({
			kind: "same_project",
			taskId: "a",
			linkedTaskId: "b",
		});
	});

	it("refuses an incomplete unlink", () => {
		for (const options of [
			{},
			{ taskId: "a" },
			{ taskId: "a", linkedProjectId: "skedai-db" },
			{ linkedTaskId: "b", linkedProjectId: "skedai-db" },
		]) {
			expect(() => parseTaskUnlinkTarget(options)).toThrow("task unlink takes either");
		}
	});
});
