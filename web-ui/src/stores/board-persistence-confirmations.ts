import type { BoardData } from "@/types";

// sked fork: side effects of a board move wait until the server has the move (sked_ai#4951,
// cline/kanban#674). The web UI saves whole boards on a 120 ms debounce, and a newer streamed
// state, or a revision conflict, can replace the local board before that save goes out. Move to
// Done used to stop the session and delete the worktree immediately, so a lost move left a card
// in Review with no session and no worktree. This store records the last board the server is
// known to hold: one a save just wrote, or one just reloaded from it.

export const TASK_DONE_CONFIRMATION_TIMEOUT_MS = 60_000;

export type ConfirmedBoardSource = "saved" | "reloaded";

interface TaskDoneWaiter {
	taskId: string;
	resolve: (confirmed: boolean) => void;
	timeoutId: ReturnType<typeof setTimeout>;
}

let lastConfirmedBoard: BoardData | null = null;
const taskDoneWaiters = new Set<TaskDoneWaiter>();

// Done means in the Done column, or no longer on the board at all.
export function isTaskDoneOnBoard(board: BoardData, taskId: string): boolean {
	for (const column of board.columns) {
		if (column.cards.some((card) => card.id === taskId)) {
			return column.id === "trash";
		}
	}
	return true;
}

export function recordConfirmedBoard(board: BoardData, source: ConfirmedBoardSource): void {
	lastConfirmedBoard = board;
	for (const waiter of [...taskDoneWaiters]) {
		const done = isTaskDoneOnBoard(board, waiter.taskId);
		// A save without the move may be an older one still in flight, so keep waiting. A reload
		// without it has replaced the local board, so the move is gone.
		if (done || source === "reloaded") {
			taskDoneWaiters.delete(waiter);
			clearTimeout(waiter.timeoutId);
			waiter.resolve(done);
		}
	}
}

export function waitForTaskDoneOnServer(
	taskId: string,
	timeoutMs: number = TASK_DONE_CONFIRMATION_TIMEOUT_MS,
): Promise<boolean> {
	if (lastConfirmedBoard && isTaskDoneOnBoard(lastConfirmedBoard, taskId)) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const waiter: TaskDoneWaiter = {
			taskId,
			resolve,
			timeoutId: setTimeout(() => {
				taskDoneWaiters.delete(waiter);
				resolve(false);
			}, timeoutMs),
		};
		taskDoneWaiters.add(waiter);
	});
}

export function resetBoardPersistenceConfirmations(): void {
	for (const waiter of taskDoneWaiters) {
		clearTimeout(waiter.timeoutId);
		waiter.resolve(false);
	}
	taskDoneWaiters.clear();
	lastConfirmedBoard = null;
}
