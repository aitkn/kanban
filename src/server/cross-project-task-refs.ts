// sked fork: the current column and title of every task that another project's board
// references in a card's `dependsOn`, so the web UI can colour cross-project chips without
// holding the other project's board. Delivered on each project summary as `referencedTasks`.

import type { RuntimeBoardData, RuntimeProjectReferencedTask, RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveLiveTaskColumnId } from "../core/task-prerequisites";

export interface ProjectBoardForTaskRefs {
	workspaceId: string;
	/** Null when the board could not be read; its own references then resolve nothing. */
	board: RuntimeBoardData | null;
	/** Live session summaries by task id, when the project has a running terminal manager. */
	sessionsByTaskId?: ReadonlyMap<string, RuntimeTaskSessionSummary>;
}

/**
 * For each project, the tasks on its board that a card on ANOTHER project's board names in
 * `dependsOn`. A referenced task missing from the result was deleted, or its project was
 * removed from Kanban (it is then not in `projects` at all). Every project gets an entry.
 */
export function collectReferencedTasksByProjectId(
	projects: readonly ProjectBoardForTaskRefs[],
): Map<string, RuntimeProjectReferencedTask[]> {
	const referencedTaskIdsByProjectId = new Map<string, Set<string>>();
	for (const { workspaceId, board } of projects) {
		for (const column of board?.columns ?? []) {
			for (const card of column.cards) {
				for (const ref of card.dependsOn ?? []) {
					if (ref.projectId === undefined || ref.projectId === workspaceId) {
						continue;
					}
					const taskIds = referencedTaskIdsByProjectId.get(ref.projectId) ?? new Set<string>();
					taskIds.add(ref.taskId);
					referencedTaskIdsByProjectId.set(ref.projectId, taskIds);
				}
			}
		}
	}

	const result = new Map<string, RuntimeProjectReferencedTask[]>();
	for (const { workspaceId, board, sessionsByTaskId } of projects) {
		const wanted = referencedTaskIdsByProjectId.get(workspaceId);
		const referencedTasks: RuntimeProjectReferencedTask[] = [];
		if (wanted && board) {
			for (const column of board.columns) {
				for (const card of column.cards) {
					if (!wanted.has(card.id)) {
						continue;
					}
					referencedTasks.push({
						taskId: card.id,
						// The board schema already resolved an empty title to one derived from the prompt.
						title: card.title,
						columnId: resolveLiveTaskColumnId(column.id, sessionsByTaskId?.get(card.id)),
					});
				}
			}
		}
		result.set(workspaceId, referencedTasks);
	}
	return result;
}
