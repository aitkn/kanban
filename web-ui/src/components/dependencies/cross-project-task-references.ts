import { formatProjectTaskRef } from "@runtime-project-short-name";

import { getBoardColumnTitle } from "@/data/board-data";
import type { RuntimeProjectSummary } from "@/runtime/types";
import type { BoardColumnId } from "@/types";

/** sked fork: a prerequisite on another project's board, as its chip shows it. */
export interface CrossProjectTaskReference {
	projectId: string;
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
	/** Switches to that project and opens the card there; tells the user when it cannot. */
	openProjectTask: (projectId: string, taskId: string) => void;
}

/**
 * sked fork: resolves a cross-project ref from the project summaries in the runtime state
 * stream, whose `referencedTasks` the server refreshes whenever any project's board changes.
 */
export function resolveCrossProjectTaskReference(
	projects: readonly RuntimeProjectSummary[],
	projectId: string,
	taskId: string,
): CrossProjectTaskReference {
	const shortNames = new Map(projects.map((project) => [project.id, project.shortName ?? project.id]));
	const label = formatProjectTaskRef({ projectId, taskId }, shortNames);
	const project = projects.find((candidate) => candidate.id === projectId);
	const referencedTask = project?.referencedTasks?.find((task) => task.taskId === taskId);
	return {
		projectId,
		label,
		projectName: project?.name ?? null,
		task: referencedTask
			? {
					title: referencedTask.title,
					columnId: referencedTask.columnId,
					columnTitle: getBoardColumnTitle(referencedTask.columnId),
				}
			: null,
	};
}
