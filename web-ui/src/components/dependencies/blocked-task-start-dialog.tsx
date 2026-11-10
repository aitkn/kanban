import { formatProjectTaskRef } from "@runtime-project-short-name";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { getBoardColumnTitle } from "@/data/board-data";
import type { BlockedTaskStartRequest } from "@/hooks/use-blocked-task-start-gate";
import type { RuntimeProjectSummary } from "@/runtime/types";

/**
 * sked fork: asks before starting a card by hand while some of its prerequisites are not done. Lists
 * each one as its chip names it (`c64f9` on this board, `db#c64f9` on another) with its column.
 */
export function BlockedTaskStartDialog({
	request,
	projects,
	onCancel,
	onConfirm,
}: {
	request: BlockedTaskStartRequest | null;
	projects: readonly RuntimeProjectSummary[];
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	const shortNames = new Map(projects.map((project) => [project.id, project.shortName ?? project.id]));
	const openPrerequisites = request?.openPrerequisites ?? [];
	const count = openPrerequisites.length;

	return (
		<AlertDialog
			open={request !== null}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Start a blocked task?</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					{request
						? `"${request.task.title}" waits on ${count === 1 ? "a task that is" : `${count} tasks that are`} not done yet.`
						: ""}
				</AlertDialogDescription>
				<ul aria-label="Open prerequisites" className="m-0 flex list-none flex-col gap-1 p-0">
					{openPrerequisites.map((prerequisite) => {
						const ref = formatProjectTaskRef(prerequisite, shortNames);
						return (
							<li key={ref} className="flex items-baseline gap-2">
								<span className="shrink-0 font-mono text-xs text-text-primary">{ref}</span>
								<span className="shrink-0 text-text-tertiary">
									{getBoardColumnTitle(prerequisite.columnId)}
								</span>
								<span className="min-w-0 truncate">{prerequisite.title}</span>
							</li>
						);
					})}
				</ul>
				<p>It starts on its own when the last of them moves from Review to Done.</p>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={onCancel}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="primary" onClick={onConfirm}>
						Start anyway
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
