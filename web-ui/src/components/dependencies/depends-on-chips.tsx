import { Link2 } from "lucide-react";

import { stopEvent } from "@/components/dependencies/stop-event";
import type { TaskReferences } from "@/components/dependencies/use-task-reference-navigation";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { BoardColumnId, TaskDependsOnRef } from "@/types";

// sked fork: a prerequisite's colour follows the column it is in right now.
const CHIP_CLASS_BY_COLUMN: Record<BoardColumnId, string> = {
	backlog: "border-status-red/40 bg-status-red/10 text-status-red",
	in_progress: "border-status-orange/40 bg-status-orange/10 text-status-orange",
	review: "border-status-gold/40 bg-status-gold/10 text-status-gold",
	trash: "border-status-green/40 bg-status-green/10 text-status-green",
};

const DELETED_CHIP_CLASS = "border-border bg-surface-1 text-text-tertiary line-through";

interface ChipModel {
	key: string;
	label: string;
	/** Null when the card (or its project) no longer exists. */
	columnId: BoardColumnId | null;
	tooltip: string;
	ariaLabel: string;
	onOpen: () => void;
}

function toChipModel(ref: TaskDependsOnRef, taskReferences: TaskReferences): ChipModel | null {
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
		};
	}
	// Cross-project chips need the app shell to resolve and switch projects.
	const crossProject = taskReferences.crossProject;
	if (!crossProject) {
		return null;
	}
	const { projectId, taskId } = ref;
	const reference = crossProject.resolveProjectTask(projectId, taskId);
	const { task, label } = reference;
	return {
		key: `${projectId}#${taskId}`,
		label,
		columnId: task?.columnId ?? null,
		tooltip: task ? `${reference.projectName ?? projectId} · ${task.columnTitle}: ${task.title}` : "card deleted",
		ariaLabel: task
			? `Open prerequisite ${label} in project ${reference.projectName ?? projectId} (${task.columnTitle})`
			: `Prerequisite ${label}, card deleted`,
		onOpen: () => crossProject.openProjectTask(projectId, taskId),
	};
}

/**
 * sked fork: the cards this card was linked to, kept after the live link is gone, on this
 * board (`c64f9`) or another project's (`db#c64f9`). Renders nothing without `taskReferences`,
 * since chips could not resolve or open anything.
 */
export function DependsOnChips({
	dependsOn,
	taskReferences,
}: {
	dependsOn: TaskDependsOnRef[] | undefined;
	taskReferences: TaskReferences | undefined;
}): React.ReactElement | null {
	if (!taskReferences || !dependsOn || dependsOn.length === 0) {
		return null;
	}
	const chips = dependsOn.flatMap((ref) => toChipModel(ref, taskReferences) ?? []);
	if (chips.length === 0) {
		return null;
	}

	return (
		<div role="group" aria-label="Depends on" className="mt-1.5 flex flex-wrap items-center gap-1">
			<Link2 size={12} className="shrink-0 text-text-tertiary" aria-hidden />
			{chips.map((chip) => (
				<Tooltip key={chip.key} side="bottom" content={chip.tooltip}>
					<button
						type="button"
						data-reference-state={chip.columnId ?? "deleted"}
						aria-label={chip.ariaLabel}
						onMouseDown={stopEvent}
						onClick={(event) => {
							stopEvent(event);
							chip.onOpen();
						}}
						className={cn(
							"cursor-pointer rounded-sm border px-1 font-mono text-[11px] leading-4 hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
							chip.columnId ? CHIP_CLASS_BY_COLUMN[chip.columnId] : DELETED_CHIP_CLASS,
						)}
					>
						{chip.label}
					</button>
				</Tooltip>
			))}
		</div>
	);
}
