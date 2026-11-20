import { useCallback, useMemo } from "react";

import { showAppToast } from "@/components/app-toaster";
import type { CrossProjectTaskReferences } from "@/components/dependencies/cross-project-task-references";
import type { BoardCard, BoardColumn, BoardColumnId, TaskDependsOnRef } from "@/types";

export interface ResolvedTaskReference {
	card: BoardCard;
	columnId: BoardColumnId;
	columnTitle: string;
}

/**
 * sked fork: one link, named the way a chip's "x" removes it: the whole link, as
 * `kanban task unlink --task-id <waiting> --linked-task-id <prerequisite>` does.
 * - `this_board`: the waiting card is on this board, so the `dependsOn` entry is too; the
 *   prerequisite is on this board or (with `projectId`) another project's.
 * - `other_board`: a card on another project's board waits on `taskId` on this board, so the
 *   entry is on that board.
 */
export type TaskLinkToRemove =
	| { kind: "this_board"; waitingTaskId: string; prerequisite: TaskDependsOnRef }
	| { kind: "other_board"; taskId: string; dependentProjectId: string; dependentTaskId: string };

/** sked fork: how a card's link chips resolve and open the cards they name. */
export interface TaskReferences {
	/** The referenced card and its current column, or null when it no longer exists. */
	resolveTask: (taskId: string) => ResolvedTaskReference | null;
	/** The cards on this board whose `dependsOn` names `taskId`, in board order. */
	resolveDependents: (taskId: string) => ResolvedTaskReference[];
	/** Does what clicking the referenced card does; tells the user when it cannot be opened. */
	openTask: (taskId: string) => void;
	/** Removes a link; without it, chips show no "x". */
	removeLink?: (link: TaskLinkToRemove) => void;
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

/** sked fork: for each card, the cards on the same board whose `dependsOn` names it. */
export function buildTaskDependentsIndex(columns: readonly BoardColumn[]): Map<string, ResolvedTaskReference[]> {
	const dependents = new Map<string, ResolvedTaskReference[]>();
	for (const column of columns) {
		for (const card of column.cards) {
			for (const ref of card.dependsOn ?? []) {
				if (ref.projectId !== undefined) {
					continue;
				}
				const waiting = dependents.get(ref.taskId) ?? [];
				waiting.push({ card, columnId: column.id, columnTitle: column.title });
				dependents.set(ref.taskId, waiting);
			}
		}
	}
	return dependents;
}

const NO_DEPENDENTS: ResolvedTaskReference[] = [];

/**
 * sked fork: builds `TaskReferences` from the columns a view renders and the same handlers
 * its cards use, plus the app's cross-project references and link removal when the view is
 * given them.
 */
export function useTaskReferenceNavigation({
	columns,
	onCardSelect,
	onEditTask,
	crossProject,
	onRemoveLink,
}: {
	columns: BoardColumn[];
	onCardSelect: (taskId: string) => void;
	onEditTask?: (card: BoardCard) => void;
	crossProject?: CrossProjectTaskReferences;
	onRemoveLink?: (link: TaskLinkToRemove) => void;
}): TaskReferences {
	const referenceByTaskId = useMemo(() => buildTaskReferenceIndex(columns), [columns]);
	const dependentsByTaskId = useMemo(() => buildTaskDependentsIndex(columns), [columns]);

	const resolveTask = useCallback(
		(taskId: string): ResolvedTaskReference | null => referenceByTaskId.get(taskId) ?? null,
		[referenceByTaskId],
	);

	const resolveDependents = useCallback(
		(taskId: string): ResolvedTaskReference[] => dependentsByTaskId.get(taskId) ?? NO_DEPENDENTS,
		[dependentsByTaskId],
	);

	const openTask = useCallback(
		(taskId: string) => {
			openResolvedTaskReference(taskId, referenceByTaskId.get(taskId) ?? null, { onCardSelect, onEditTask });
		},
		[onCardSelect, onEditTask, referenceByTaskId],
	);

	return useMemo(
		() => ({
			resolveTask,
			resolveDependents,
			openTask,
			...(onRemoveLink ? { removeLink: onRemoveLink } : {}),
			...(crossProject ? { crossProject } : {}),
		}),
		[crossProject, onRemoveLink, openTask, resolveDependents, resolveTask],
	);
}
