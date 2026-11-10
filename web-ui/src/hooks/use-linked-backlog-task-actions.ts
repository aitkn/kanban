import { isPrerequisiteFinishingMove, type PrerequisiteContext } from "@runtime-task-prerequisites";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import type { RuntimeCrossProjectAutoStartResponse } from "@/runtime/types";
import {
	addTaskDependency,
	findCardSelection,
	moveTaskToColumn,
	removeTaskDependency,
	trashTaskAndGetReadyLinkedTaskIds,
} from "@/state/board-state";
import { waitForTaskDoneOnServer } from "@/stores/board-persistence-confirmations";
import { trackTaskDependencyCreated, trackTasksAutoStartedFromDependency } from "@/telemetry/events";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { getNextDetailTaskIdAfterTrashMove } from "@/utils/detail-view-task-order";

async function waitForMoveToDoneSaved(task: BoardCard): Promise<boolean> {
	if (await waitForTaskDoneOnServer(task.id)) {
		return true;
	}
	showAppToast(
		{
			intent: "warning",
			icon: "warning-sign",
			message: `"${task.title}" was not moved to Done: the board changed before the move was saved. Its session and worktree were left alone. Move it again.`,
			timeout: 10000,
		},
		`move-to-done-not-saved-${task.id}`,
	);
	return false;
}

function quoteTitles(tasks: readonly { title: string }[]): string {
	return tasks.map((task) => `"${task.title}"`).join(", ");
}

/** sked fork: the runtime started cards on other boards, which nobody here can see; say so. */
function reportCrossProjectAutoStart(task: BoardCard, response: RuntimeCrossProjectAutoStartResponse | null): void {
	if (!response) {
		showAppToast({
			intent: "warning",
			icon: "warning-sign",
			message: `Could not check other projects for cards waiting on "${task.title}". Start them from their project.`,
			timeout: 10000,
		});
		return;
	}
	if (response.startedTasks.length > 0) {
		showAppToast({
			intent: "success",
			message: `Started on another project, now that nothing blocks it: ${quoteTitles(response.startedTasks)}.`,
			timeout: 7000,
		});
	}
	if (response.failedTasks.length > 0) {
		showAppToast({
			intent: "warning",
			icon: "warning-sign",
			message: `Could not start ${quoteTitles(response.failedTasks)} on another project: ${response.failedTasks
				.map((task) => task.error)
				.join("; ")}. Start it from that project.`,
			timeout: 10000,
		});
	}
}

interface RequestMoveTaskToTrashOptions {
	optimisticMoveApplied?: boolean;
	skipWorkingChangeWarning?: boolean;
}

export function useLinkedBacklogTaskActions({
	board,
	setBoard,
	setSelectedTaskId,
	stopTaskSession,
	cleanupTaskWorkspace,
	maybeRequestNotificationPermissionForTaskStart,
	kickoffTaskInProgress,
	startBacklogTaskWithAnimation,
	waitForBacklogStartAnimationAvailability,
	prerequisites,
	startCrossProjectDependents,
}: {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	stopTaskSession: (taskId: string) => Promise<void>;
	cleanupTaskWorkspace: (taskId: string) => Promise<unknown>;
	maybeRequestNotificationPermissionForTaskStart: () => void;
	kickoffTaskInProgress: (
		task: BoardCard,
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: { optimisticMove?: boolean },
	) => Promise<boolean>;
	startBacklogTaskWithAnimation?: (task: BoardCard) => Promise<boolean>;
	waitForBacklogStartAnimationAvailability?: () => Promise<void>;
	/** sked fork: resolves cross-project refs, so a waiting card starts only once nothing blocks it. */
	prerequisites: PrerequisiteContext;
	/** sked fork: starts the cards on other projects' boards that waited on a card that just finished. */
	startCrossProjectDependents: (taskId: string) => Promise<RuntimeCrossProjectAutoStartResponse | null>;
}): {
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	handleDeleteDependency: (dependencyId: string) => void;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: BoardColumnId,
		options?: RequestMoveTaskToTrashOptions,
	) => Promise<void>;
} {
	const boardRef = useRef(board);
	const prerequisitesRef = useRef(prerequisites);

	useEffect(() => {
		boardRef.current = board;
	}, [board]);

	useEffect(() => {
		prerequisitesRef.current = prerequisites;
	}, [prerequisites]);

	const handleCreateDependency = useCallback(
		(fromTaskId: string, toTaskId: string) => {
			const result = addTaskDependency(boardRef.current, fromTaskId, toTaskId);
			if (!result.added) {
				const message =
					result.reason === "same_task"
						? "A task cannot be linked to itself."
						: result.reason === "duplicate"
							? "Link already exists."
							: result.reason === "trash_task"
								? "Links cannot include done tasks."
								: result.reason === "non_backlog"
									? "Links must include at least one Backlog task."
									: "Could not create link.";
				showAppToast({
					intent: "warning",
					icon: "warning-sign",
					message,
					timeout: 3000,
				});
				return;
			}

			setBoard((currentBoard) => {
				const latestResult = addTaskDependency(currentBoard, fromTaskId, toTaskId);
				return latestResult.added ? latestResult.board : currentBoard;
			});
			trackTaskDependencyCreated();
		},
		[setBoard],
	);

	const handleDeleteDependency = useCallback(
		(dependencyId: string) => {
			setBoard((currentBoard) => {
				const removed = removeTaskDependency(currentBoard, dependencyId);
				return removed.removed ? removed.board : currentBoard;
			});
		},
		[setBoard],
	);

	const performMoveTaskToTrash = useCallback(
		async (task: BoardCard, currentBoard?: BoardData): Promise<void> => {
			const boardBeforeTrash = currentBoard ?? boardRef.current;
			const trashed = trashTaskAndGetReadyLinkedTaskIds(boardBeforeTrash, task.id, prerequisitesRef.current);
			if (!trashed.moved) {
				if (!(await waitForMoveToDoneSaved(task))) {
					return;
				}
				await stopTaskSession(task.id);
				await cleanupTaskWorkspace(task.id);
				return;
			}
			// sked fork: linked cards start only after their last prerequisite is done, so a trash request
			// issued before React re-renders must already see this one, or the card never starts.
			boardRef.current = trashed.board;

			setBoard((currentBoardState) => {
				const latestTrashResult = trashTaskAndGetReadyLinkedTaskIds(
					currentBoardState,
					task.id,
					prerequisitesRef.current,
				);
				return latestTrashResult.moved ? latestTrashResult.board : currentBoardState;
			});
			setSelectedTaskId((currentSelectedTaskId) =>
				currentSelectedTaskId === task.id
					? getNextDetailTaskIdAfterTrashMove(boardBeforeTrash, task.id)
					: currentSelectedTaskId,
			);

			// sked fork: stop, clean up and auto-start nothing until the server has the move
			// (sked_ai#4951). The CLI's `task trash` saves first for the same reason.
			if (!(await waitForMoveToDoneSaved(task))) {
				return;
			}

			// sked fork: same rule as the same-board start below (`isPrerequisiteFinishingMove`). Runs
			// alongside it, so another repo's worktree setup does not hold up this card's cleanup.
			const crossProjectAutoStart = isPrerequisiteFinishingMove(trashed.fromColumnId)
				? startCrossProjectDependents(task.id).then((response) => reportCrossProjectAutoStart(task, response))
				: Promise.resolve();

			const readyTasks = trashed.readyTaskIds
				.map((readyTaskId) => findCardSelection(trashed.board, readyTaskId)?.card ?? null)
				.filter((readyTask): readyTask is BoardCard => readyTask !== null);

			if (readyTasks.length > 0) {
				maybeRequestNotificationPermissionForTaskStart();
				let startedTaskCount = 0;
				if (startBacklogTaskWithAnimation) {
					const startedTaskPromises: Promise<boolean>[] = [];
					for (const [index, readyTask] of readyTasks.entries()) {
						startedTaskPromises.push(startBacklogTaskWithAnimation(readyTask));
						if (index < readyTasks.length - 1) {
							await waitForBacklogStartAnimationAvailability?.();
						}
					}
					const startedTasks = await Promise.all(startedTaskPromises);
					startedTaskCount = startedTasks.filter(Boolean).length;
				} else {
					setBoard((currentBoardState) => {
						let nextBoardState = currentBoardState;
						for (const readyTask of readyTasks) {
							const moved = moveTaskToColumn(nextBoardState, readyTask.id, "in_progress", {
								insertAtTop: true,
							});
							if (moved.moved) {
								nextBoardState = moved.board;
							}
						}
						return nextBoardState;
					});
					for (const readyTask of readyTasks) {
						const started = await kickoffTaskInProgress(readyTask, readyTask.id, "backlog", {
							optimisticMove: true,
						});
						if (started) {
							startedTaskCount += 1;
						}
					}
				}
				if (startedTaskCount > 0) {
					trackTasksAutoStartedFromDependency(startedTaskCount);
				}
			}

			await Promise.all([stopTaskSession(task.id), stopTaskSession(getDetailTerminalTaskId(task.id))]);
			await cleanupTaskWorkspace(task.id);
			await crossProjectAutoStart;
		},
		[
			cleanupTaskWorkspace,
			kickoffTaskInProgress,
			maybeRequestNotificationPermissionForTaskStart,
			setBoard,
			setSelectedTaskId,
			startBacklogTaskWithAnimation,
			startCrossProjectDependents,
			stopTaskSession,
			waitForBacklogStartAnimationAvailability,
		],
	);

	const requestMoveTaskToTrash = useCallback(
		async (taskId: string, _fromColumnId: BoardColumnId, options?: RequestMoveTaskToTrashOptions): Promise<void> => {
			const boardSnapshot = boardRef.current;
			const selection = findCardSelection(boardSnapshot, taskId);
			if (!selection) {
				return;
			}

			const moveSelectionIfOptimisticMoveIsConfirmed = () => {
				if (!options?.optimisticMoveApplied) {
					return;
				}
				setSelectedTaskId((currentSelectedTaskId) =>
					currentSelectedTaskId === taskId
						? getNextDetailTaskIdAfterTrashMove(boardSnapshot, taskId)
						: currentSelectedTaskId,
				);
			};

			if (options?.skipWorkingChangeWarning) {
				moveSelectionIfOptimisticMoveIsConfirmed();
				await performMoveTaskToTrash(selection.card, boardSnapshot);
				return;
			}

			moveSelectionIfOptimisticMoveIsConfirmed();
			await performMoveTaskToTrash(selection.card, boardSnapshot);
		},
		[performMoveTaskToTrash, setSelectedTaskId],
	);

	return {
		handleCreateDependency,
		handleDeleteDependency,
		confirmMoveTaskToTrash: async (task: BoardCard, currentBoard?: BoardData) => {
			await performMoveTaskToTrash(task, currentBoard);
		},
		requestMoveTaskToTrash,
	};
}
