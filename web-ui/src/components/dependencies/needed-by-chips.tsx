import { CornerDownRight } from "lucide-react";

import type { CrossProjectTaskReference } from "@/components/dependencies/cross-project-task-references";
import { type TaskLinkChipModel, TaskLinkChipRow } from "@/components/dependencies/task-link-chips";
import type { ResolvedTaskReference, TaskReferences } from "@/components/dependencies/use-task-reference-navigation";

function toSameBoardChip(
	taskId: string,
	dependent: ResolvedTaskReference,
	taskReferences: TaskReferences,
): TaskLinkChipModel {
	const dependentTaskId = dependent.card.id;
	const { removeLink } = taskReferences;
	return {
		key: dependentTaskId,
		label: dependentTaskId,
		columnId: dependent.columnId,
		tooltip: `${dependent.columnTitle}: ${dependent.card.title}`,
		ariaLabel: `Open ${dependentTaskId}, which needs this card (${dependent.columnTitle})`,
		onOpen: () => taskReferences.openTask(dependentTaskId),
		remove: removeLink
			? {
					ariaLabel: `Remove link: ${dependentTaskId} depends on ${taskId}`,
					onRemove: () =>
						removeLink({ kind: "this_board", waitingTaskId: dependentTaskId, prerequisite: { taskId } }),
				}
			: null,
	};
}

function toCrossProjectChip(
	taskId: string,
	dependent: CrossProjectTaskReference,
	taskReferences: TaskReferences,
	openProjectTask: (projectId: string, taskId: string) => void,
): TaskLinkChipModel {
	const { projectId, label, task } = dependent;
	const projectName = dependent.projectName ?? projectId;
	const { removeLink } = taskReferences;
	return {
		key: `${projectId}#${dependent.taskId}`,
		label,
		columnId: task?.columnId ?? null,
		tooltip: task ? `${projectName} · ${task.columnTitle}: ${task.title}` : "card deleted",
		ariaLabel: `Open ${label} in project ${projectName}, which needs this card${task ? ` (${task.columnTitle})` : ""}`,
		onOpen: () => openProjectTask(projectId, dependent.taskId),
		remove: removeLink
			? {
					ariaLabel: `Remove link: ${label} depends on ${taskId}`,
					onRemove: () =>
						removeLink({
							kind: "other_board",
							taskId,
							dependentProjectId: projectId,
							dependentTaskId: dependent.taskId,
						}),
				}
			: null,
	};
}

/**
 * sked fork: the mirror of `DependsOnChips`: the cards whose `dependsOn` names this card, on this
 * board (`c64f9`) or another project's (`db#c64f9`). They look and open the same way, under their
 * own icon and label so the direction is never ambiguous.
 */
export function NeededByChips({
	taskId,
	taskReferences,
}: {
	taskId: string;
	taskReferences: TaskReferences | undefined;
}): React.ReactElement | null {
	if (!taskReferences) {
		return null;
	}
	const crossProject = taskReferences.crossProject;
	const chips = [
		...taskReferences
			.resolveDependents(taskId)
			.map((dependent) => toSameBoardChip(taskId, dependent, taskReferences)),
		...(crossProject
			? crossProject
					.resolveProjectTaskDependents(taskId)
					.map((dependent) => toCrossProjectChip(taskId, dependent, taskReferences, crossProject.openProjectTask))
			: []),
	];
	return <TaskLinkChipRow icon={CornerDownRight} title="Needed by" chips={chips} />;
}
