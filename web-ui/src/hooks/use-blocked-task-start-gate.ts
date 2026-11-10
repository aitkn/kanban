import { listOpenPrerequisites, type OpenPrerequisite, type PrerequisiteContext } from "@runtime-task-prerequisites";
import { useCallback, useState } from "react";

import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData } from "@/types";

/** sked fork: a manual start that is waiting for "Start anyway" because the card is blocked. */
export interface BlockedTaskStartRequest {
	task: BoardCard;
	openPrerequisites: OpenPrerequisite[];
}

export interface BlockedTaskStartGate {
	/** The blocked start awaiting confirmation, or null. */
	pending: BlockedTaskStartRequest | null;
	isBlocked: (taskId: string) => boolean;
	/**
	 * Starts a backlog card by hand: right away when nothing blocks it, otherwise once the user
	 * confirms. Auto-start does not come through here; it only ever starts unblocked cards.
	 */
	requestStart: (taskId: string) => void;
	confirm: () => void;
	cancel: () => void;
}

/**
 * sked fork: holds back a manual start (the Start button, a drag into In Progress) of a card whose
 * prerequisites are not all done, until the user picks "Start anyway". The rule itself is
 * `listOpenPrerequisites`, shared with the CLI and the runtime.
 */
export function useBlockedTaskStartGate({
	board,
	prerequisites,
	startTask,
}: {
	board: BoardData;
	prerequisites: PrerequisiteContext;
	/** Starts a backlog card without asking. */
	startTask: (task: BoardCard) => void;
}): BlockedTaskStartGate {
	const [pending, setPending] = useState<BlockedTaskStartRequest | null>(null);

	const isBlocked = useCallback(
		(taskId: string) => listOpenPrerequisites(board, taskId, prerequisites).length > 0,
		[board, prerequisites],
	);

	const requestStart = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "backlog") {
				return;
			}
			const openPrerequisites = listOpenPrerequisites(board, taskId, prerequisites);
			if (openPrerequisites.length === 0) {
				startTask(selection.card);
				return;
			}
			setPending({ task: selection.card, openPrerequisites });
		},
		[board, prerequisites, startTask],
	);

	const confirm = useCallback(() => {
		if (!pending) {
			return;
		}
		setPending(null);
		// The board may have changed while the dialog was open; start the card only if it still waits.
		const selection = findCardSelection(board, pending.task.id);
		if (selection?.column.id === "backlog") {
			startTask(selection.card);
		}
	}, [board, pending, startTask]);

	const cancel = useCallback(() => {
		setPending(null);
	}, []);

	return { pending, isBlocked, requestStart, confirm, cancel };
}
