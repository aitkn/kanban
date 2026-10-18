import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	isTaskDoneOnBoard,
	recordConfirmedBoard,
	resetBoardPersistenceConfirmations,
	waitForTaskDoneOnServer,
} from "@/stores/board-persistence-confirmations";
import type { BoardColumnId, BoardData } from "@/types";

function boardWith(taskId: string | null, columnId: BoardColumnId = "review"): BoardData {
	const card = {
		id: taskId ?? "",
		title: "Task",
		prompt: "Task",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
	const ids: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
	return {
		columns: ids.map((id) => ({ id, title: id, cards: taskId !== null && id === columnId ? [card] : [] })),
		dependencies: [],
	};
}

describe("board persistence confirmations", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetBoardPersistenceConfirmations();
	});

	afterEach(() => {
		resetBoardPersistenceConfirmations();
		vi.useRealTimers();
	});

	it("treats a task in Done, or absent from the board, as done", () => {
		expect(isTaskDoneOnBoard(boardWith("t1", "trash"), "t1")).toBe(true);
		expect(isTaskDoneOnBoard(boardWith(null), "t1")).toBe(true);
		expect(isTaskDoneOnBoard(boardWith("t1", "review"), "t1")).toBe(false);
	});

	it("resolves true once a save carrying the move succeeds", async () => {
		recordConfirmedBoard(boardWith("t1", "review"), "reloaded");
		const waiting = waitForTaskDoneOnServer("t1");
		recordConfirmedBoard(boardWith("t1", "review"), "saved"); // an older save still in flight
		recordConfirmedBoard(boardWith("t1", "trash"), "saved");
		await expect(waiting).resolves.toBe(true);
	});

	it("resolves false when a reload replaces the board without the move", async () => {
		recordConfirmedBoard(boardWith("t1", "review"), "reloaded");
		const waiting = waitForTaskDoneOnServer("t1");
		recordConfirmedBoard(boardWith("t1", "review"), "reloaded");
		await expect(waiting).resolves.toBe(false);
	});

	it("resolves true when a reload shows the server already has the move", async () => {
		recordConfirmedBoard(boardWith("t1", "review"), "reloaded");
		const waiting = waitForTaskDoneOnServer("t1");
		recordConfirmedBoard(boardWith("t1", "trash"), "reloaded");
		await expect(waiting).resolves.toBe(true);
	});

	it("resolves at once when the last confirmed board already has the task done", async () => {
		recordConfirmedBoard(boardWith("t1", "trash"), "saved");
		await expect(waitForTaskDoneOnServer("t1")).resolves.toBe(true);
	});

	it("resolves false when nothing confirms the move in time", async () => {
		recordConfirmedBoard(boardWith("t1", "review"), "reloaded");
		const waiting = waitForTaskDoneOnServer("t1", 1000);
		vi.advanceTimersByTime(1000);
		await expect(waiting).resolves.toBe(false);
	});
});
