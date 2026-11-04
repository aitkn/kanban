import { Link2 } from "lucide-react";
import type { MouseEvent } from "react";

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

function stopEvent(event: MouseEvent<HTMLElement>): void {
	event.preventDefault();
	event.stopPropagation();
}

/**
 * sked fork: the cards this card was linked to, kept after the live link is gone.
 * Renders nothing without `taskReferences`, since chips could not resolve or open anything.
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
	// Cross-project refs (projectId set) are reserved for a later change; only same-project refs resolve here.
	const sameProjectRefs = dependsOn.filter((ref) => ref.projectId === undefined);
	if (sameProjectRefs.length === 0) {
		return null;
	}

	return (
		<div role="group" aria-label="Depends on" className="mt-1.5 flex flex-wrap items-center gap-1">
			<Link2 size={12} className="shrink-0 text-text-tertiary" aria-hidden />
			{sameProjectRefs.map((ref) => {
				const reference = taskReferences.resolveTask(ref.taskId);
				const tooltip = reference ? `${reference.columnTitle}: ${reference.card.title}` : "card deleted";
				return (
					<Tooltip key={ref.taskId} side="bottom" content={tooltip}>
						<button
							type="button"
							data-reference-state={reference?.columnId ?? "deleted"}
							aria-label={
								reference
									? `Open prerequisite ${ref.taskId} (${reference.columnTitle})`
									: `Prerequisite ${ref.taskId}, card deleted`
							}
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								taskReferences.openTask(ref.taskId);
							}}
							className={cn(
								"cursor-pointer rounded-sm border px-1 font-mono text-[11px] leading-4 hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
								reference ? CHIP_CLASS_BY_COLUMN[reference.columnId] : DELETED_CHIP_CLASS,
							)}
						>
							{ref.taskId}
						</button>
					</Tooltip>
				);
			})}
		</div>
	);
}
