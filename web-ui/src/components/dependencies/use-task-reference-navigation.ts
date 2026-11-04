import { useCallback, useMemo } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { CrossProjectTaskReferences } from "@/components/dependencies/cross-project-task-references";
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
	/** Cards on other projects' boards; without it, chips for those do not render. */
	crossProject?: CrossProjectTaskReferences;
}

export interface TaskReferenceOpenHandlers {
	onCardSelect: (taskId: string) => void;
	onEditTask?: (card: BoardCard) => void;
}

export function showDeletedTaskReferenceToast(): void {
	showAppToast({ intent: "warning", message: "card no longer exists", timeout: 3000 });
}

export function showDoneTaskReferenceToast(label: string, columnTitle: string): void {
	showAppToast({
		intent: "none",
		message: `Card ${label} is done. Restore it from ${columnTitle} to open it.`,
		timeout: 3000,
	});
}

/**
 * sked fork: opens a referenced card the way clicking that card does: a backlog card opens its
 * editor, an in-progress or review card opens its detail view. Done cards are not clickable and
 * deleted cards are gone, so both explain why instead. Shared by same-board chips and by a
 * cross-project chip once its project has loaded.
 */
export function openResolvedTaskReference(
	taskId: string,
	reference: ResolvedTaskReference | null,
	{ onCardSelect, onEditTask }: TaskReferenceOpenHandlers,
): void {
	if (!reference) {
		showDeletedTaskReferenceToast();
		return;
	}
	if (reference.columnId === "trash") {
		showDoneTaskReferenceToast(taskId, reference.columnTitle);
		return;
	}
	if (reference.columnId === "backlog" && onEditTask) {
		onEditTask(reference.card);
		return;
	}
	onCardSelect(taskId);
}

export function buildTaskReferenceIndex(columns: readonly BoardColumn[]): Map<string, ResolvedTaskReference> {
	const references = new Map<string, ResolvedTaskReference>();
	for (const column of columns) {
		for (const card of column.cards) {
			references.set(card.id, { card, columnId: column.id, columnTitle: column.title });
		}
	}
	return references;
}

/**
 * sked fork: builds `TaskReferences` from the columns a view renders and the same handlers
 * its cards use, plus the app's cross-project references when the view is given them.
 */
export function useTaskReferenceNavigation({
	columns,
	onCardSelect,
	onEditTask,
	crossProject,
}: {
	columns: BoardColumn[];
	onCardSelect: (taskId: string) => void;
	onEditTask?: (card: BoardCard) => void;
	crossProject?: CrossProjectTaskReferences;
}): TaskReferences {
	const referenceByTaskId = useMemo(() => buildTaskReferenceIndex(columns), [columns]);

	const resolveTask = useCallback(
		(taskId: string): ResolvedTaskReference | null => referenceByTaskId.get(taskId) ?? null,
		[referenceByTaskId],
	);

	const openTask = useCallback(
		(taskId: string) => {
			openResolvedTaskReference(taskId, referenceByTaskId.get(taskId) ?? null, { onCardSelect, onEditTask });
		},
		[onCardSelect, onEditTask, referenceByTaskId],
	);

	return useMemo(
		() => ({ resolveTask, openTask, ...(crossProject ? { crossProject } : {}) }),
		[crossProject, openTask, resolveTask],
	);
}
