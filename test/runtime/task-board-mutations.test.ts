import { describe, expect, it } from "vitest";

import type { RuntimeBoardColumnId, RuntimeBoardData } from "../../src/core/api-contract";
import {
	addTaskDependency,
	addTaskToColumn,
	countPendingPrerequisites,
	deleteTasksFromBoard,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("per-task agent/model/provider overrides", () => {
	it("persists agentId on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Smart task", baseRef: "main", agentId: "claude" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("claude");
	});

	it("persists task-level Cline settings on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Dumb task",
				baseRef: "main",
				agentId: "cline",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("cline");
		expect(created.task.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});

	it("leaves override fields undefined when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Default task", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBeUndefined();
		expect(created.task.clineSettings).toBeUndefined();
	});

	it("updates agentId from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.agentId).toBeUndefined();

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.agentId).toBe("codex");
	});

	it("updates clineModelId", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", clineSettings: { modelId: "old-model" } },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			clineSettings: { modelId: "new-model" },
		});

		expect(updated.task?.clineSettings?.modelId).toBe("new-model");
	});

	it("preserves existing overrides when update input omits them (undefined)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "low",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
			// agentId and clineSettings are undefined, so existing overrides should persist
		});

		expect(updated.task?.agentId).toBe("claude");
		expect(updated.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "low",
		});
	});

	it("clears overrides when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "codex",
				clineSettings: {
					providerId: "openai",
					modelId: "gpt-4",
					reasoningEffort: "medium",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: null,
			clineSettings: null,
		});

		expect(updated.task?.agentId).toBeUndefined();
		expect(updated.task?.clineSettings).toBeUndefined();
	});

	it("preserves overrides across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Movable task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");

		expect(moved.moved).toBe(true);
		expect(moved.task?.agentId).toBe("claude");
		expect(moved.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});
});

function columnOf(board: RuntimeBoardData, taskId: string): string | undefined {
	return board.columns.find((column) => column.cards.some((card) => card.id === taskId))?.id;
}

// Builds a board with each task id placed in the given column.
function boardWithTasks(placements: Array<[taskId: string, column: RuntimeBoardColumnId]>): RuntimeBoardData {
	let board = createBoard();
	for (const [taskId, column] of placements) {
		board = addTaskToColumn(board, column, { taskId, prompt: `Task ${taskId}`, baseRef: "main" }, () => taskId).board;
	}
	return board;
}

function link(board: RuntimeBoardData, waitingTaskId: string, prerequisiteTaskId: string): RuntimeBoardData {
	const linked = addTaskDependency(board, waitingTaskId, prerequisiteTaskId);
	if (!linked.added) {
		throw new Error(`Expected link ${waitingTaskId} -> ${prerequisiteTaskId}, got ${linked.reason}.`);
	}
	return linked.board;
}

describe("linked task auto-start waits for ALL prerequisites", () => {
	it("starts a single-prerequisite card when its prerequisite moves review -> done", () => {
		const board = link(
			boardWithTasks([
				["waiting", "backlog"],
				["prereq", "review"],
			]),
			"waiting",
			"prereq",
		);

		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, "prereq");

		expect(trashed.readyTaskIds).toEqual(["waiting"]);
		expect(trashed.board.dependencies).toEqual([]);
	});

	it("starts a card only after its last review prerequisite moves to done", () => {
		let board = boardWithTasks([
			["waiting", "backlog"],
			["first", "review"],
			["second", "review"],
		]);
		board = link(board, "waiting", "first");
		board = link(board, "waiting", "second");

		const afterFirst = trashTaskAndGetReadyLinkedTaskIds(board, "first");
		expect(afterFirst.readyTaskIds).toEqual([]);
		expect(afterFirst.board.dependencies).toEqual([
			expect.objectContaining({ fromTaskId: "waiting", toTaskId: "second" }),
		]);

		const afterSecond = trashTaskAndGetReadyLinkedTaskIds(afterFirst.board, "second");
		expect(afterSecond.readyTaskIds).toEqual(["waiting"]);
	});

	it("keeps waiting while a backlog prerequisite is unfinished", () => {
		let board = boardWithTasks([
			["waiting", "backlog"],
			["queued", "backlog"],
			["reviewed", "review"],
		]);
		board = link(board, "waiting", "queued");
		board = link(board, "waiting", "reviewed");

		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, "reviewed");

		expect(trashed.readyTaskIds).toEqual([]);
	});

	describe("prerequisite finished from a column other than review (case 1)", () => {
		it("does not start a single-link card when the prerequisite is trashed from in_progress", () => {
			const board = link(
				boardWithTasks([
					["waiting", "backlog"],
					["prereq", "in_progress"],
				]),
				"waiting",
				"prereq",
			);

			const trashed = trashTaskAndGetReadyLinkedTaskIds(board, "prereq");

			expect(trashed.readyTaskIds).toEqual([]);
			expect(trashed.board.dependencies).toEqual([]);
		});

		it("does not start the card when its last prerequisite is trashed from in_progress", () => {
			let board = boardWithTasks([
				["waiting", "backlog"],
				["reviewed", "review"],
				["running", "in_progress"],
			]);
			board = link(board, "waiting", "reviewed");
			board = link(board, "waiting", "running");

			const afterReviewed = trashTaskAndGetReadyLinkedTaskIds(board, "reviewed");
			expect(afterReviewed.readyTaskIds).toEqual([]);

			const afterRunning = trashTaskAndGetReadyLinkedTaskIds(afterReviewed.board, "running");
			expect(afterRunning.readyTaskIds).toEqual([]);
			expect(afterRunning.board.dependencies).toEqual([]);
		});

		it("starts the card when an in_progress prerequisite was dropped first and the last one finishes review", () => {
			let board = boardWithTasks([
				["waiting", "backlog"],
				["reviewed", "review"],
				["running", "in_progress"],
			]);
			board = link(board, "waiting", "reviewed");
			board = link(board, "waiting", "running");

			const afterRunning = trashTaskAndGetReadyLinkedTaskIds(board, "running");
			expect(afterRunning.readyTaskIds).toEqual([]);

			const afterReviewed = trashTaskAndGetReadyLinkedTaskIds(afterRunning.board, "reviewed");
			expect(afterReviewed.readyTaskIds).toEqual(["waiting"]);
		});
	});

	describe("prerequisite deleted (case 2)", () => {
		it("starts the card when the remaining prerequisite finishes review after the other was deleted", () => {
			let board = boardWithTasks([
				["waiting", "backlog"],
				["deleted", "review"],
				["reviewed", "review"],
			]);
			board = link(board, "waiting", "deleted");
			board = link(board, "waiting", "reviewed");

			const deleted = deleteTasksFromBoard(board, ["deleted"]);
			expect(deleted.board.dependencies).toEqual([
				expect.objectContaining({ fromTaskId: "waiting", toTaskId: "reviewed" }),
			]);

			const trashed = trashTaskAndGetReadyLinkedTaskIds(deleted.board, "reviewed");
			expect(trashed.readyTaskIds).toEqual(["waiting"]);
		});

		it("leaves the card in backlog when its last prerequisite is deleted", () => {
			let board = boardWithTasks([
				["waiting", "backlog"],
				["reviewed", "review"],
				["deleted", "review"],
			]);
			board = link(board, "waiting", "reviewed");
			board = link(board, "waiting", "deleted");

			const trashed = trashTaskAndGetReadyLinkedTaskIds(board, "reviewed");
			expect(trashed.readyTaskIds).toEqual([]);

			const deleted = deleteTasksFromBoard(trashed.board, ["deleted"]);
			expect(deleted.board.dependencies).toEqual([]);
			expect(columnOf(deleted.board, "waiting")).toBe("backlog");
		});
	});

	it("starts the card exactly once when every prerequisite is trashed in sequence (case 3, bulk done)", () => {
		let board = boardWithTasks([
			["waiting", "backlog"],
			["first", "review"],
			["second", "review"],
			["third", "review"],
		]);
		board = link(board, "waiting", "first");
		board = link(board, "waiting", "second");
		board = link(board, "waiting", "third");

		// Mirrors `task done --column review`: each task is trashed against the latest board.
		const readyPerStep: string[][] = [];
		for (const taskId of ["first", "second", "third"]) {
			const trashed = trashTaskAndGetReadyLinkedTaskIds(board, taskId);
			readyPerStep.push(trashed.readyTaskIds);
			board = trashed.board;
		}

		expect(readyPerStep).toEqual([[], [], ["waiting"]]);
	});

	it("starts the join card of a diamond only after both branches are done (case 4)", () => {
		// a -> {b, c} -> d: b and c wait on a; d waits on b and c.
		let board = boardWithTasks([
			["a", "review"],
			["b", "backlog"],
			["c", "backlog"],
			["d", "backlog"],
		]);
		board = link(board, "b", "a");
		board = link(board, "c", "a");
		board = link(board, "d", "b");
		board = link(board, "d", "c");

		const afterA = trashTaskAndGetReadyLinkedTaskIds(board, "a");
		expect([...afterA.readyTaskIds].sort()).toEqual(["b", "c"]);
		board = afterA.board;

		for (const taskId of afterA.readyTaskIds) {
			board = moveTaskToColumn(board, taskId, "in_progress").board;
		}
		board = moveTaskToColumn(board, "b", "review").board;
		board = moveTaskToColumn(board, "c", "review").board;
		expect(board.dependencies).toHaveLength(2);

		const afterB = trashTaskAndGetReadyLinkedTaskIds(board, "b");
		expect(afterB.readyTaskIds).toEqual([]);

		const afterC = trashTaskAndGetReadyLinkedTaskIds(afterB.board, "c");
		expect(afterC.readyTaskIds).toEqual(["d"]);
	});

	it("does not start or error when the waiting card was started manually first (case 5)", () => {
		let board = boardWithTasks([
			["waiting", "backlog"],
			["first", "review"],
			["second", "review"],
		]);
		board = link(board, "waiting", "first");
		board = link(board, "waiting", "second");

		const startedEarly = moveTaskToColumn(board, "waiting", "in_progress");
		expect(startedEarly.board.dependencies).toEqual([]);

		const afterFirst = trashTaskAndGetReadyLinkedTaskIds(startedEarly.board, "first");
		expect(afterFirst.moved).toBe(true);
		expect(afterFirst.readyTaskIds).toEqual([]);

		const afterSecond = trashTaskAndGetReadyLinkedTaskIds(afterFirst.board, "second");
		expect(afterSecond.moved).toBe(true);
		expect(afterSecond.readyTaskIds).toEqual([]);
	});

	it("starts several cards that each had the trashed card as their only prerequisite", () => {
		let board = boardWithTasks([
			["solo-1", "backlog"],
			["solo-2", "backlog"],
			["joined", "backlog"],
			["shared", "review"],
			["other", "review"],
		]);
		board = link(board, "solo-1", "shared");
		board = link(board, "solo-2", "shared");
		board = link(board, "joined", "shared");
		board = link(board, "joined", "other");

		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, "shared");

		expect([...trashed.readyTaskIds].sort()).toEqual(["solo-1", "solo-2"]);
	});
});

describe("countPendingPrerequisites", () => {
	it("counts the unfinished prerequisites a backlog card still waits on", () => {
		let board = boardWithTasks([
			["waiting", "backlog"],
			["first", "review"],
			["second", "in_progress"],
			["third", "backlog"],
		]);
		expect(countPendingPrerequisites(board, "waiting")).toBe(0);
		board = link(board, "waiting", "first");
		board = link(board, "waiting", "second");
		board = link(board, "waiting", "third");

		expect(countPendingPrerequisites(board, "waiting")).toBe(3);
		expect(countPendingPrerequisites(board, "third")).toBe(0);
		expect(countPendingPrerequisites(trashTaskAndGetReadyLinkedTaskIds(board, "first").board, "waiting")).toBe(2);
	});
});
