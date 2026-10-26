import { useEffect, useRef } from "react";

import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import { disposeParkedPersistentTerminals } from "@/terminal/persistent-terminal-manager";
import type { BoardData } from "@/types";

function collectTerminalTaskIds(board: BoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		if (column.id !== "in_progress" && column.id !== "review") {
			continue;
		}
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

// sked fork: closes the parked terminals of cards that left in_progress/review (done, trash, deleted)
// and of a project the tab switched away from, instead of leaving them connected until evicted.
export function usePersistentTerminalCleanup(workspaceId: string | null, board: BoardData): void {
	const previousRef = useRef<{ workspaceId: string | null; taskIds: Set<string> }>({
		workspaceId: null,
		taskIds: new Set(),
	});

	useEffect(() => {
		const previous = previousRef.current;
		const taskIds = collectTerminalTaskIds(board);
		previousRef.current = { workspaceId, taskIds };
		if (previous.workspaceId === null) {
			return;
		}
		if (previous.workspaceId !== workspaceId) {
			disposeParkedPersistentTerminals(previous.workspaceId);
			return;
		}
		const leftTaskIds = [...previous.taskIds].filter((taskId) => !taskIds.has(taskId));
		if (leftTaskIds.length > 0) {
			disposeParkedPersistentTerminals(
				previous.workspaceId,
				leftTaskIds.flatMap((taskId) => [taskId, getDetailTerminalTaskId(taskId)]),
			);
		}
	}, [board, workspaceId]);
}
