import { useCallback, useEffect, useMemo, useState } from "react";

import {
	type CrossProjectTaskReferences,
	resolveCrossProjectTaskReference,
} from "@/components/dependencies/cross-project-task-references";
import {
	buildTaskReferenceIndex,
	openResolvedTaskReference,
	showDeletedTaskReferenceToast,
	showDoneTaskReferenceToast,
	type TaskReferenceOpenHandlers,
} from "@/components/dependencies/use-task-reference-navigation";
import {
	buildDetailTaskUrl,
	buildProjectPathname,
	parseDetailTaskIdFromSearch,
	parseProjectIdFromPathname,
} from "@/hooks/app-utils";
import type { RuntimeProjectSummary } from "@/runtime/types";
import type { BoardCard, BoardData } from "@/types";
import { useWindowEvent } from "@/utils/react-use";

/**
 * A card to open once its project is the current one and that project's board has loaded.
 * `link` came from a chip and opens the card the way clicking it does; `history` came from
 * Back/Forward and restores the detail selection the URL names.
 */
interface PendingProjectTaskOpen {
	projectId: string;
	taskId: string;
	source: "link" | "history";
}

interface UseCrossProjectTaskNavigationInput {
	projects: readonly RuntimeProjectSummary[];
	currentProjectId: string | null;
	board: BoardData;
	/** True while `board` is not yet the board of `currentProjectId` (switching, awaiting snapshot, hydrating). */
	isBoardLoading: boolean;
	isProjectSwitching: boolean;
	handleSelectProject: (projectId: string) => void;
	setSelectedTaskId: (taskId: string | null) => void;
	onCardSelect: (taskId: string) => void;
	onEditTask?: (card: BoardCard) => void;
}

/** Puts `?task=<id>` in the current entry so selecting it does not push a second history entry. */
function replaceUrlDetailTask(taskId: string): void {
	const url = new URL(window.location.href);
	window.history.replaceState(
		window.history.state,
		"",
		buildDetailTaskUrl({ pathname: url.pathname, search: url.search, hash: url.hash, taskId }),
	);
}

/**
 * sked fork: opens a card on another project's board. Switching projects closes the detail view
 * (`use-detail-task-navigation.ts`) and replaces the URL, so the card to open is kept here and
 * opened after the switch, once the new board has loaded. The jump pushes one history entry,
 * and Back to a card on another project goes through the same pending open.
 */
export function useCrossProjectTaskNavigation({
	projects,
	currentProjectId,
	board,
	isBoardLoading,
	isProjectSwitching,
	handleSelectProject,
	setSelectedTaskId,
	onCardSelect,
	onEditTask,
}: UseCrossProjectTaskNavigationInput): CrossProjectTaskReferences {
	const [pendingOpen, setPendingOpen] = useState<PendingProjectTaskOpen | null>(null);

	const resolveProjectTask = useCallback(
		(projectId: string, taskId: string) => resolveCrossProjectTaskReference(projects, projectId, taskId),
		[projects],
	);

	const openProjectTask = useCallback(
		(projectId: string, taskId: string) => {
			// A second click while a jump is in flight would push a second history entry.
			if (pendingOpen) {
				return;
			}
			const reference = resolveCrossProjectTaskReference(projects, projectId, taskId);
			if (!reference.task) {
				showDeletedTaskReferenceToast();
				return;
			}
			if (reference.task.columnId === "trash") {
				showDoneTaskReferenceToast(reference.label, reference.task.columnTitle);
				return;
			}
			// Project switches replace the URL; this entry is what Back returns from.
			window.history.pushState({}, "", buildProjectPathname(projectId));
			// Close this project's detail view now. Left open, it renders for a moment under the new
			// project id and its terminal connects with the wrong workspace. The entry pushed above
			// already holds the URL for Back, so closing does not touch it.
			setSelectedTaskId(null);
			setPendingOpen({ projectId, taskId, source: "link" });
			handleSelectProject(projectId);
		},
		[handleSelectProject, pendingOpen, projects, setSelectedTaskId],
	);

	const handlePopState = useCallback(() => {
		const projectId = parseProjectIdFromPathname(window.location.pathname);
		const taskId = parseDetailTaskIdFromSearch(window.location.search);
		setPendingOpen(
			projectId && taskId && projectId !== currentProjectId ? { projectId, taskId, source: "history" } : null,
		);
	}, [currentProjectId]);
	useWindowEvent("popstate", handlePopState);

	useEffect(() => {
		if (!pendingOpen) {
			return;
		}
		if (currentProjectId !== pendingOpen.projectId) {
			// The switch was abandoned (the project went away, or the user picked another one).
			if (!isProjectSwitching && !isBoardLoading) {
				setPendingOpen(null);
				// A project that could not be opened leaves the URL on it, and the project URL
				// effect only runs when the current project changes, which it did not.
				if (currentProjectId && window.location.pathname === buildProjectPathname(pendingOpen.projectId)) {
					window.history.replaceState(window.history.state, "", buildProjectPathname(currentProjectId));
				}
			}
			return;
		}
		if (isBoardLoading) {
			return;
		}
		setPendingOpen(null);
		const reference = buildTaskReferenceIndex(board.columns).get(pendingOpen.taskId) ?? null;
		if (pendingOpen.source === "history") {
			if (reference && reference.columnId !== "trash") {
				replaceUrlDetailTask(pendingOpen.taskId);
				setSelectedTaskId(pendingOpen.taskId);
			}
			return;
		}
		const handlers: TaskReferenceOpenHandlers = {
			onCardSelect: (taskId) => {
				replaceUrlDetailTask(taskId);
				onCardSelect(taskId);
			},
			onEditTask,
		};
		openResolvedTaskReference(pendingOpen.taskId, reference, handlers);
	}, [
		board,
		currentProjectId,
		isBoardLoading,
		isProjectSwitching,
		onCardSelect,
		onEditTask,
		pendingOpen,
		setSelectedTaskId,
	]);

	return useMemo(() => ({ resolveProjectTask, openProjectTask }), [openProjectTask, resolveProjectTask]);
}
