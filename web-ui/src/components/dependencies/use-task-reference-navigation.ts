import { useCallback, useMemo } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { BoardCard, BoardColumn, BoardColumnId } from "@/types";

export interface ResolvedTaskReference {
	card: BoardCard;
	columnId: BoardColumnId;
	columnTitle: string;
}

/** sked fork: how a card's prerequisite chips resolve and open the cards they name. */
export interface TaskReferences {
	/** The referenced card and its current column, or null when it no longer exists. */
	resolveTask: (taskId: string) => ResolvedTaskReference | null;
	/** Does what clicking the referenced card does; tells the user when it cannot be opened. */
	openTask: (taskId: string) => void;
}

/**
 * sked fork: builds `TaskReferences` from the columns a view renders and the
 * same handlers its cards use, so opening a referenced card matches clicking that card:
 * a backlog card opens its editor, an in-progress or review card opens its detail view.
 * Done cards are not clickable and deleted cards are gone, so both explain why instead.
 */
export function useTaskReferenceNavigation({
	columns,
	onCardSelect,
	onEditTask,
}: {
	columns: BoardColumn[];
	onCardSelect: (taskId: string) => void;
	onEditTask?: (card: BoardCard) => void;
}): TaskReferences {
	const referenceByTaskId = useMemo(() => {
		const references = new Map<string, ResolvedTaskReference>();
		for (const column of columns) {
			for (const card of column.cards) {
				references.set(card.id, { card, columnId: column.id, columnTitle: column.title });
			}
		}
		return references;
	}, [columns]);

	const resolveTask = useCallback(
		(taskId: string): ResolvedTaskReference | null => referenceByTaskId.get(taskId) ?? null,
		[referenceByTaskId],
	);

	const openTask = useCallback(
		(taskId: string) => {
			const reference = referenceByTaskId.get(taskId);
			if (!reference) {
				showAppToast({ intent: "warning", message: "card no longer exists", timeout: 3000 });
				return;
			}
			if (reference.columnId === "trash") {
				showAppToast({
					intent: "none",
					message: `Card ${taskId} is done. Restore it from ${reference.columnTitle} to open it.`,
					timeout: 3000,
				});
				return;
			}
			if (reference.columnId === "backlog" && onEditTask) {
				onEditTask(reference.card);
				return;
			}
			onCardSelect(taskId);
		},
		[onCardSelect, onEditTask, referenceByTaskId],
	);

	return useMemo(() => ({ resolveTask, openTask }), [openTask, resolveTask]);
}
