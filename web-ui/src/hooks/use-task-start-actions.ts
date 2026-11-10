import { listOpenPrerequisites, type PrerequisiteContext } from "@runtime-task-prerequisites";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useState } from "react";

import { findCardSelection } from "@/state/board-state";
import type { BoardData } from "@/types";

interface UseTaskStartActionsInput {
	board: BoardData;
	handleCreateTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	prerequisites: PrerequisiteContext;
}

export interface UseTaskStartActionsResult {
	handleCreateAndStartTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateAndStartTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	handleCreateStartAndOpenTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleStartTaskFromBoard: (taskId: string) => void;
	handleStartAllBacklogTasksFromBoard: () => void;
}

/** sked fork: "Start all" starts only the backlog cards that nothing blocks (`listOpenPrerequisites`). */
export function getStartableBacklogTaskIds(board: BoardData, prerequisites: PrerequisiteContext): string[] {
	const backlogCards = board.columns.find((column) => column.id === "backlog")?.cards ?? [];
	return backlogCards
		.filter((card) => listOpenPrerequisites(board, card.id, prerequisites).length === 0)
		.map((card) => card.id);
}

export function useTaskStartActions({
	board,
	handleCreateTask,
	handleCreateTasks,
	handleStartTask,
	handleStartAllBacklogTasks,
	setSelectedTaskId,
	prerequisites,
}: UseTaskStartActionsInput): UseTaskStartActionsResult {
	const [pendingTaskStartAfterCreateIds, setPendingTaskStartAfterCreateIds] = useState<string[] | null>(null);

	const startBacklogTasks = useCallback(
		(taskIds: string[]) => {
			const backlogTaskIds = [...new Set(taskIds.filter((taskId) => taskId.trim().length > 0))].filter((taskId) => {
				const selection = findCardSelection(board, taskId);
				return selection?.column.id === "backlog";
			});

			if (backlogTaskIds.length === 0) {
				return;
			}

			if (backlogTaskIds.length === 1) {
				const firstTaskId = backlogTaskIds[0];
				if (!firstTaskId) {
					return;
				}
				handleStartTask(firstTaskId);
				return;
			}
			handleStartAllBacklogTasks(backlogTaskIds);
		},
		[board, handleStartAllBacklogTasks, handleStartTask],
	);

	const handleStartTaskFromBoard = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "backlog") {
				handleStartTask(taskId);
				return;
			}
			startBacklogTasks([taskId]);
		},
		[board, handleStartTask, startBacklogTasks],
	);

	const handleStartAllBacklogTasksFromBoard = useCallback(() => {
		const backlogTaskIds = getStartableBacklogTaskIds(board, prerequisites);

		if (backlogTaskIds.length === 0) {
			return;
		}
		startBacklogTasks(backlogTaskIds);
	}, [board, prerequisites, startBacklogTasks]);

	const handleCreateAndStartTask = useCallback(
		(options?: { keepDialogOpen?: boolean }): string | null => {
			const taskId = handleCreateTask(options);
			if (!taskId) {
				return null;
			}
			setPendingTaskStartAfterCreateIds([taskId]);
			return taskId;
		},
		[handleCreateTask],
	);

	const handleCreateAndStartTasks = useCallback(
		(prompts: string[], options?: { keepDialogOpen?: boolean }): string[] => {
			const taskIds = handleCreateTasks(prompts, options);
			if (taskIds.length === 0) {
				return [];
			}
			setPendingTaskStartAfterCreateIds(taskIds);
			return taskIds;
		},
		[handleCreateTasks],
	);

	const handleCreateStartAndOpenTask = useCallback(
		(options?: { keepDialogOpen?: boolean }): string | null => {
			const taskId = handleCreateTask(options);
			if (!taskId) {
				return null;
			}
			setPendingTaskStartAfterCreateIds([taskId]);
			if (!options?.keepDialogOpen) {
				setSelectedTaskId(taskId);
			}
			return taskId;
		},
		[handleCreateTask, setSelectedTaskId],
	);

	useEffect(() => {
		if (!pendingTaskStartAfterCreateIds || pendingTaskStartAfterCreateIds.length === 0) {
			return;
		}
		const allInBacklog = pendingTaskStartAfterCreateIds.every((taskId) => {
			const selection = findCardSelection(board, taskId);
			return selection?.column.id === "backlog";
		});
		if (!allInBacklog) {
			return;
		}
		startBacklogTasks(pendingTaskStartAfterCreateIds);
		setPendingTaskStartAfterCreateIds(null);
	}, [board, pendingTaskStartAfterCreateIds, startBacklogTasks]);

	return {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleCreateStartAndOpenTask,
		handleStartTaskFromBoard,
		handleStartAllBacklogTasksFromBoard,
	};
}
