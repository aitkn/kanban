import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	MAX_PROGRAMMATIC_CARD_MOVE_BLOCKED_RETRIES,
	PROGRAMMATIC_CARD_MOVE_STALE_MS,
	useProgrammaticCardMoves,
} from "@/hooks/use-programmatic-card-moves";

type ProgrammaticCardMoves = ReturnType<typeof useProgrammaticCardMoves>;

function Harness({ onMoves }: { onMoves: (moves: ProgrammaticCardMoves) => void }): null {
	const moves = useProgrammaticCardMoves();
	useEffect(() => {
		onMoves(moves);
	});
	return null;
}

describe("useProgrammaticCardMoves", () => {
	let container: HTMLDivElement;
	let root: Root;
	let moves: ProgrammaticCardMoves | null;
	let previousActEnvironment: boolean | undefined;

	const current = (): ProgrammaticCardMoves => {
		if (!moves) {
			throw new Error("Expected the hook to have rendered.");
		}
		return moves;
	};

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		moves = null;
		await act(async () => {
			root.render(
				<Harness
					onMoves={(next) => {
						moves = next;
					}}
				/>,
			);
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		vi.useRealTimers();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("blocks a second move while one is in flight, then clears a move stuck past the stale limit", async () => {
		const requestMove = vi.fn(() => true);
		await act(async () => {
			current().handleProgrammaticCardMoveReady(requestMove);
		});

		let first: string | undefined;
		await act(async () => {
			first = current().tryProgrammaticCardMove("task-1", "backlog", "in_progress");
		});
		expect(first).toBe("started");
		expect(current().tryProgrammaticCardMove("task-2", "backlog", "in_progress")).toBe("blocked");

		await act(async () => {
			vi.advanceTimersByTime(PROGRAMMATIC_CARD_MOVE_STALE_MS);
		});

		let second: string | undefined;
		await act(async () => {
			second = current().tryProgrammaticCardMove("task-2", "backlog", "in_progress");
		});
		expect(second).toBe("started");
		expect(requestMove).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task-2" }));
	});

	it("clears the in-flight move when the board that animates it goes away", async () => {
		await act(async () => {
			current().handleProgrammaticCardMoveReady(() => true);
		});
		await act(async () => {
			current().tryProgrammaticCardMove("task-1", "backlog", "in_progress");
		});
		const waitForAvailability = vi.fn();
		await act(async () => {
			void current().waitForProgrammaticCardMoveAvailability().then(waitForAvailability);
		});
		expect(waitForAvailability).not.toHaveBeenCalled();

		await act(async () => {
			current().handleProgrammaticCardMoveReady(null);
		});
		expect(waitForAvailability).toHaveBeenCalledTimes(1);

		await act(async () => {
			current().handleProgrammaticCardMoveReady(() => true);
		});
		expect(current().tryProgrammaticCardMove("task-2", "backlog", "in_progress")).toBe("started");
	});

	it("moves a review card to Done without animation when the animation stays blocked", async () => {
		const requestMoveTaskToTrash = vi.fn(async () => {});
		const requestMove = vi.fn(() => true);
		await act(async () => {
			current().handleProgrammaticCardMoveReady(requestMove);
			current().setRequestMoveTaskToTrashHandler(requestMoveTaskToTrash);
		});
		await act(async () => {
			current().tryProgrammaticCardMove("task-1", "backlog", "in_progress");
		});

		let trashDone = false;
		await act(async () => {
			void current()
				.requestMoveTaskToTrashWithAnimation("task-2", "review")
				.then(() => {
					trashDone = true;
				});
		});
		// Each blocked attempt waits up to 5s for the move in flight; the in-flight move turns stale
		// after the first wait, so the retry animates. Keep it blocked by never letting it go stale.
		vi.mocked(performance.now).mockImplementation(() => 0);
		for (let attempt = 0; attempt <= MAX_PROGRAMMATIC_CARD_MOVE_BLOCKED_RETRIES; attempt += 1) {
			await act(async () => {
				vi.advanceTimersByTime(5000);
			});
		}

		expect(trashDone).toBe(true);
		expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-2", "review", undefined);
		expect(requestMove).toHaveBeenCalledTimes(1);
	});
});
