import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkspaceStateResponse, RuntimeWorkspaceStateSaveRequest } from "@/runtime/types";
import { useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import { WorkspaceStateConflictError } from "@/runtime/workspace-state-query";
import type { BoardData } from "@/types";

const recordConfirmedBoardMock = vi.hoisted(() => vi.fn());

vi.mock("@/stores/board-persistence-confirmations", () => ({
	recordConfirmedBoard: recordConfirmedBoardMock,
}));

function boardTitled(title: string): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title,
						prompt: title,
						startInPlanMode: false,
						autoReviewEnabled: false,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

type Persist = (input: {
	workspaceId: string;
	payload: RuntimeWorkspaceStateSaveRequest;
}) => Promise<RuntimeWorkspaceStateResponse>;

function Harness({
	persist,
	refetch,
	onRevisionChange,
	exposeSetBoard,
}: {
	persist: Persist;
	refetch: () => Promise<unknown>;
	onRevisionChange: (revision: number) => void;
	exposeSetBoard: (setBoard: (board: BoardData) => void) => void;
}): null {
	const [board, setBoard] = useState<BoardData>(() => boardTitled("original"));
	const [revision, setRevision] = useState<number | null>(5);
	useEffect(() => {
		exposeSetBoard(setBoard);
	}, [exposeSetBoard]);
	useWorkspacePersistence({
		board,
		sessions: {},
		currentProjectId: "project-1",
		workspaceRevision: revision,
		hydrationNonce: 0,
		canPersistWorkspaceState: true,
		isDocumentVisible: true,
		isWorkspaceStateRefreshing: false,
		persistWorkspaceState: persist,
		refetchWorkspaceState: refetch,
		onWorkspaceRevisionChange: (next) => {
			onRevisionChange(next);
			setRevision(next);
		},
	});
	return null;
}

describe("useWorkspacePersistence", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.useFakeTimers();
		recordConfirmedBoardMock.mockReset();
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
	});

	it("after a revision conflict refetches instead of re-saving the stale board under the new revision", async () => {
		const persist = vi.fn<Persist>(async () => {
			throw new WorkspaceStateConflictError(6);
		});
		const refetch = vi.fn(async () => undefined);
		const onRevisionChange = vi.fn();
		let setBoard: ((board: BoardData) => void) | null = null;

		await act(async () => {
			root.render(
				<Harness
					persist={persist}
					refetch={refetch}
					onRevisionChange={onRevisionChange}
					exposeSetBoard={(next) => {
						setBoard = next;
					}}
				/>,
			);
		});
		await act(async () => {
			setBoard?.(boardTitled("edited locally"));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});

		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist.mock.calls[0]?.[0].payload.expectedRevision).toBe(5);
		expect(refetch).toHaveBeenCalledTimes(1);
		expect(onRevisionChange).not.toHaveBeenCalledWith(6);
		expect(recordConfirmedBoardMock).not.toHaveBeenCalled();
	});

	it("records the board a successful save wrote as confirmed", async () => {
		const persist = vi.fn<Persist>(async (input) => ({ revision: 6, board: input.payload.board }) as never);
		const onRevisionChange = vi.fn();
		let setBoard: ((board: BoardData) => void) | null = null;
		const edited = boardTitled("edited locally");

		await act(async () => {
			root.render(
				<Harness
					persist={persist}
					refetch={async () => undefined}
					onRevisionChange={onRevisionChange}
					exposeSetBoard={(next) => {
						setBoard = next;
					}}
				/>,
			);
		});
		await act(async () => {
			setBoard?.(edited);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});

		expect(recordConfirmedBoardMock).toHaveBeenCalledWith(edited, "saved");
		expect(onRevisionChange).toHaveBeenCalledWith(6);
	});
});
