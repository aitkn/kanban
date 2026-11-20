import { Link2 } from "lucide-react";

import { type TaskLinkChipModel, TaskLinkChipRow } from "@/components/dependencies/task-link-chips";
import type { TaskReferences } from "@/components/dependencies/use-task-reference-navigation";
import type { TaskDependsOnRef } from "@/types";

function removeAction(
	taskId: string,
	ref: TaskDependsOnRef,
	label: string,
	taskReferences: TaskReferences,
): TaskLinkChipModel["remove"] {
	const { removeLink } = taskReferences;
	if (!removeLink) {
		return null;
	}
	return {
		ariaLabel: `Remove link: ${taskId} depends on ${label}`,
		onRemove: () => removeLink({ kind: "this_board", waitingTaskId: taskId, prerequisite: ref }),
	};
}

function toChipModel(taskId: string, ref: TaskDependsOnRef, taskReferences: TaskReferences): TaskLinkChipModel | null {
	if (ref.projectId === undefined) {
		const reference = taskReferences.resolveTask(ref.taskId);
		return {
			key: ref.taskId,
			label: ref.taskId,
			columnId: reference?.columnId ?? null,
			tooltip: reference ? `${reference.columnTitle}: ${reference.card.title}` : "card deleted",
			ariaLabel: reference
				? `Open prerequisite ${ref.taskId} (${reference.columnTitle})`
				: `Prerequisite ${ref.taskId}, card deleted`,
			onOpen: () => taskReferences.openTask(ref.taskId),
			remove: removeAction(taskId, ref, ref.taskId, taskReferences),
		};
	}
	// Cross-project chips need the app shell to resolve and switch projects.
	const crossProject = taskReferences.crossProject;
	if (!crossProject) {
		return null;
	}
	const { projectId } = ref;
	const reference = crossProject.resolveProjectTask(projectId, ref.taskId);
	const { task, label } = reference;
	return {
		key: `${projectId}#${ref.taskId}`,
		label,
		columnId: task?.columnId ?? null,
		tooltip: task ? `${reference.projectName ?? projectId} · ${task.columnTitle}: ${task.title}` : "card deleted",
		ariaLabel: task
			? `Open prerequisite ${label} in project ${reference.projectName ?? projectId} (${task.columnTitle})`
			: `Prerequisite ${label}, card deleted`,
		onOpen: () => crossProject.openProjectTask(projectId, ref.taskId),
		remove: removeAction(taskId, ref, label, taskReferences),
	};
}

/**
 * sked fork: the cards this card was linked to, kept after the live link is gone, on this
 * board (`c64f9`) or another project's (`db#c64f9`). Renders nothing without `taskReferences`,
 * since chips could not resolve or open anything.
 */
export function DependsOnChips({
	taskId,
	dependsOn,
	taskReferences,
}: {
	taskId: string;
	dependsOn: TaskDependsOnRef[] | undefined;
	taskReferences: TaskReferences | undefined;
}): React.ReactElement | null {
	if (!taskReferences || !dependsOn || dependsOn.length === 0) {
		return null;
	}
	const chips = dependsOn.flatMap((ref) => toChipModel(taskId, ref, taskReferences) ?? []);
	return <TaskLinkChipRow icon={Link2} title="Depends on" chips={chips} />;
}
