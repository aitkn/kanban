import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskLinkToRemove } from "@/components/dependencies/use-task-reference-navigation";
import { useTaskLinkRemoval } from "@/hooks/use-task-link-removal";
import { addTaskDependency } from "@/state/board-state";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

const unlinkCrossProjectDependentMock = vi.hoisted(() => vi.fn());
const notifyErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (workspaceId: string | null) => ({
		runtime: {
			unlinkCrossProjectDependent: {
				mutate: (input: object) => unlinkCrossProjectDependentMock({ workspaceId, ...input }),
			},
		},
	}),
}));

vi.mock("@/components/app-toaster", () => ({
	notifyError: notifyErrorMock,
}));

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function board(cards: Partial<Record<BoardColumnId, BoardCard[]>>): BoardData {
	const columns: Array<{ id: BoardColumnId; title: string }> = [
		{ id: "backlog", title: "Backlog" },
		{ id: "in_progress", title: "In Progress" },
		{ id: "review", title: "Review" },
		{ id: "trash", title: "Done" },
	];
	return { columns: columns.map((column) => ({ ...column, cards: cards[column.id] ?? [] })), dependencies: [] };
}

function dependsOnOf(data: BoardData, taskId: string) {
	return data.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId)?.dependsOn;
}

describe("sked fork: useTaskLinkRemoval", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: { board: BoardData; remove: (link: TaskLinkToRemove) => void } | null = null;

	function Harness({ initialBoard }: { initialBoard: BoardData }): null {
		const [current, setBoard] = useState(initialBoard);
		const remove = useTaskLinkRemoval({ currentProjectId: "web", setBoard });
		latest = { board: current, remove };
		return null;
	}

	async function renderWith(initialBoard: BoardData) {
		await act(async () => {
			root.render(<Harness initialBoard={initialBoard} />);
		});
		if (!latest) {
			throw new Error("not rendered");
		}
		return latest;
	}

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		unlinkCrossProjectDependentMock.mockReset();
		notifyErrorMock.mockReset();
		latest = null;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("removes a same-board link entirely: the live link and the dependsOn entry", async () => {
		const linked = addTaskDependency(board({ backlog: [card("wait1"), card("pre1")] }), "wait1", "pre1");
		expect(linked.added).toBe(true);
		expect(linked.board.dependencies).toHaveLength(1);
		expect(dependsOnOf(linked.board, "wait1")).toEqual([{ taskId: "pre1" }]);

		const { remove } = await renderWith(linked.board);
		await act(async () => {
			remove({ kind: "this_board", waitingTaskId: "wait1", prerequisite: { taskId: "pre1" } });
		});

		expect(latest?.board.dependencies).toEqual([]);
		expect(dependsOnOf(latest?.board as BoardData, "wait1")).toEqual([]);
		expect(unlinkCrossProjectDependentMock).not.toHaveBeenCalled();
	});

	it("removes a dependsOn entry whose live link is already gone (a done prerequisite)", async () => {
		const { remove } = await renderWith(
			board({ in_progress: [card("wait1", { dependsOn: [{ taskId: "pre1" }] })], trash: [card("pre1")] }),
		);
		await act(async () => {
			remove({ kind: "this_board", waitingTaskId: "wait1", prerequisite: { taskId: "pre1" } });
		});

		expect(dependsOnOf(latest?.board as BoardData, "wait1")).toEqual([]);
	});

	it("removes a cross-project prerequisite held on this board, and only that one", async () => {
		const { remove } = await renderWith(
			board({
				backlog: [
					card("wait1", {
						dependsOn: [
							{ taskId: "pre1", projectId: "db" },
							{ taskId: "pre1", projectId: "api" },
						],
					}),
				],
			}),
		);
		await act(async () => {
			remove({ kind: "this_board", waitingTaskId: "wait1", prerequisite: { taskId: "pre1", projectId: "db" } });
		});

		expect(dependsOnOf(latest?.board as BoardData, "wait1")).toEqual([{ taskId: "pre1", projectId: "api" }]);
		expect(unlinkCrossProjectDependentMock).not.toHaveBeenCalled();
	});

	it("asks the runtime to unlink a dependent on another board, and reports a failure", async () => {
		const initial = board({ backlog: [card("pre1")] });
		const { remove } = await renderWith(initial);
		unlinkCrossProjectDependentMock.mockResolvedValueOnce({ ok: true });
		unlinkCrossProjectDependentMock.mockResolvedValueOnce({ ok: false, error: 'Task "wait1" no longer exists.' });

		const link: TaskLinkToRemove = {
			kind: "other_board",
			taskId: "pre1",
			dependentProjectId: "db",
			dependentTaskId: "wait1",
		};
		await act(async () => {
			remove(link);
		});
		expect(notifyErrorMock).not.toHaveBeenCalled();
		await act(async () => {
			remove(link);
		});

		expect(unlinkCrossProjectDependentMock.mock.calls).toEqual([
			[{ workspaceId: "web", taskId: "pre1", dependentProjectId: "db", dependentTaskId: "wait1" }],
			[{ workspaceId: "web", taskId: "pre1", dependentProjectId: "db", dependentTaskId: "wait1" }],
		]);
		expect(notifyErrorMock).toHaveBeenCalledWith('Task "wait1" no longer exists.');
		// This board holds nothing of that link, so it is left as it was.
		expect(latest?.board).toBe(initial);
	});
});
