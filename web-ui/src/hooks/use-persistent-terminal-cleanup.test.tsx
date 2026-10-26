import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePersistentTerminalCleanup } from "@/hooks/use-persistent-terminal-cleanup";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

const disposeParkedPersistentTerminalsMock = vi.hoisted(() => vi.fn());

vi.mock("@/terminal/persistent-terminal-manager", () => ({
	disposeParkedPersistentTerminals: disposeParkedPersistentTerminalsMock,
}));

function createBoard(cardIdsByColumn: Partial<Record<BoardColumnId, string[]>>): BoardData {
	const columnIds: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
	return {
		columns: columnIds.map((id) => ({
			id,
			title: id,
			cards: (cardIdsByColumn[id] ?? []).map((cardId) => ({ id: cardId }) as BoardCard),
		})),
		dependencies: [],
	};
}

function HookHarness({ workspaceId, board }: { workspaceId: string | null; board: BoardData }) {
	usePersistentTerminalCleanup(workspaceId, board);
	return null;
}

describe("usePersistentTerminalCleanup", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		disposeParkedPersistentTerminalsMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function render(workspaceId: string | null, board: BoardData): Promise<void> {
		await act(async () => {
			root.render(<HookHarness workspaceId={workspaceId} board={board} />);
		});
	}

	it("disposes the agent and shell terminals of a card that moved to done", async () => {
		await render("project-1", createBoard({ in_progress: ["task-a", "task-b"] }));
		expect(disposeParkedPersistentTerminalsMock).not.toHaveBeenCalled();

		await render("project-1", createBoard({ in_progress: ["task-b"], trash: ["task-a"] }));

		expect(disposeParkedPersistentTerminalsMock).toHaveBeenCalledTimes(1);
		expect(disposeParkedPersistentTerminalsMock).toHaveBeenCalledWith("project-1", [
			"task-a",
			"__detail_terminal__:task-a",
		]);
	});

	it("disposes the terminals of a deleted card", async () => {
		await render("project-1", createBoard({ review: ["task-a"] }));

		await render("project-1", createBoard({}));

		expect(disposeParkedPersistentTerminalsMock).toHaveBeenCalledWith("project-1", [
			"task-a",
			"__detail_terminal__:task-a",
		]);
	});

	it("keeps terminals of cards moving between in progress and review", async () => {
		await render("project-1", createBoard({ in_progress: ["task-a"] }));

		await render("project-1", createBoard({ review: ["task-a"], backlog: ["task-new"] }));

		expect(disposeParkedPersistentTerminalsMock).not.toHaveBeenCalled();
	});

	it("disposes the previous project's parked terminals when the project changes", async () => {
		await render("project-1", createBoard({ in_progress: ["task-a"] }));

		await render("project-2", createBoard({ in_progress: ["task-a"] }));

		expect(disposeParkedPersistentTerminalsMock).toHaveBeenCalledTimes(1);
		expect(disposeParkedPersistentTerminalsMock).toHaveBeenCalledWith("project-1");
	});
});
