import { formatProjectTaskRef } from "@runtime-project-short-name";

import { getBoardColumnTitle } from "@/data/board-data";
import type { RuntimeProjectSummary } from "@/runtime/types";
import type { BoardColumnId } from "@/types";

/** sked fork: a card on another project's board (a prerequisite or a dependent), as its chip shows it. */
export interface CrossProjectTaskReference {
	projectId: string;
	taskId: string;
	/** `<shortName>#<taskId>`; a removed project shows its ID. */
	label: string;
	/** Null when the project is no longer in Kanban. */
	projectName: string | null;
	/** Null when the card or its whole project no longer exists. */
	task: { title: string; columnId: BoardColumnId; columnTitle: string } | null;
}

/** sked fork: how chips resolve and open a card on another project's board. */
export interface CrossProjectTaskReferences {
	resolveProjectTask: (projectId: string, taskId: string) => CrossProjectTaskReference;
	/** The cards on other projects' boards whose `dependsOn` names `taskId` on the current board. */
	resolveProjectTaskDependents: (taskId: string) => CrossProjectTaskReference[];
	/** Switches to that project and opens the card there; tells the user when it cannot. */
	openProjectTask: (projectId: string, taskId: string) => void;
}

/**
 * The card's title and live column as the project summaries carry it: in its own project's
 * `referencedTasks` when another board waits on it, or in another project's `dependentTasks`
 * when it waits on a card there. Null when neither names it.
 */
function findCrossProjectTaskStatus(
	projects: readonly RuntimeProjectSummary[],
	projectId: string,
	taskId: string,
): { title: string; columnId: BoardColumnId } | null {
	const referenced = projects
		.find((project) => project.id === projectId)
		?.referencedTasks?.find((task) => task.taskId === taskId);
	if (referenced) {
		return referenced;
	}
	for (const project of projects) {
		const dependent = project.dependentTasks?.find(
			(task) => task.dependentProjectId === projectId && task.dependentTaskId === taskId,
		);
		if (dependent) {
			return dependent;
		}
	}
	return null;
}

/**
 * sked fork: resolves a card on another project's board from the project summaries in the
 * runtime state stream, whose `referencedTasks` and `dependentTasks` the server refreshes
 * whenever any project's board changes.
 */
export function resolveCrossProjectTaskReference(
	projects: readonly RuntimeProjectSummary[],
	projectId: string,
	taskId: string,
): CrossProjectTaskReference {
	const shortNames = new Map(projects.map((project) => [project.id, project.shortName ?? project.id]));
	const label = formatProjectTaskRef({ projectId, taskId }, shortNames);
	const project = projects.find((candidate) => candidate.id === projectId);
	const status = findCrossProjectTaskStatus(projects, projectId, taskId);
	return {
		projectId,
		taskId,
		label,
		projectName: project?.name ?? null,
		task: status
			? { title: status.title, columnId: status.columnId, columnTitle: getBoardColumnTitle(status.columnId) }
			: null,
	};
}

/**
 * sked fork: the cards on other projects' boards that wait on `taskId` on the current project's
 * board, from the current project's `dependentTasks`, which the server refreshes with every board
 * change. A dependent always exists (a deleted card takes its `dependsOn` with it).
 */
export function resolveCrossProjectDependents(
	projects: readonly RuntimeProjectSummary[],
	currentProjectId: string | null,
	taskId: string,
): CrossProjectTaskReference[] {
	const currentProject = projects.find((project) => project.id === currentProjectId);
	const dependents = (currentProject?.dependentTasks ?? []).filter((dependent) => dependent.taskId === taskId);
	if (dependents.length === 0) {
		return [];
	}
	const shortNames = new Map(projects.map((project) => [project.id, project.shortName ?? project.id]));
	return dependents.map((dependent) => ({
		projectId: dependent.dependentProjectId,
		taskId: dependent.dependentTaskId,
		label: formatProjectTaskRef(
			{ projectId: dependent.dependentProjectId, taskId: dependent.dependentTaskId },
			shortNames,
		),
		projectName: projects.find((project) => project.id === dependent.dependentProjectId)?.name ?? null,
		task: {
			title: dependent.title,
			columnId: dependent.columnId,
			columnTitle: getBoardColumnTitle(dependent.columnId),
		},
	}));
}
