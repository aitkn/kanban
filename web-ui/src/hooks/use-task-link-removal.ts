import type { Dispatch, SetStateAction } from "react";
import { useCallback } from "react";

import { notifyError } from "@/components/app-toaster";
import type { TaskLinkToRemove } from "@/components/dependencies/use-task-reference-navigation";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { removeTaskLinkFromBoard } from "@/state/board-state";
import type { BoardData } from "@/types";

/**
 * sked fork: removes a whole link from a chip's "x", as `kanban task unlink --task-id <waiting>
 * --linked-task-id <prerequisite>` does. A link whose `dependsOn` entry is on this board is
 * removed from the board here and saved like any other board edit. A link held by a card on
 * another project's board is removed by the runtime, which edits that board and pushes the
 * change to every open browser.
 */
export function useTaskLinkRemoval({
	currentProjectId,
	setBoard,
}: {
	currentProjectId: string | null;
	setBoard: Dispatch<SetStateAction<BoardData>>;
}): (link: TaskLinkToRemove) => void {
	return useCallback(
		(link: TaskLinkToRemove) => {
			if (link.kind === "this_board") {
				setBoard((currentBoard) => removeTaskLinkFromBoard(currentBoard, link.waitingTaskId, link.prerequisite));
				return;
			}
			if (!currentProjectId) {
				return;
			}
			void getRuntimeTrpcClient(currentProjectId)
				.runtime.unlinkCrossProjectDependent.mutate({
					taskId: link.taskId,
					dependentProjectId: link.dependentProjectId,
					dependentTaskId: link.dependentTaskId,
				})
				.then((response) => {
					if (!response.ok) {
						notifyError(response.error ?? "Could not remove the link.");
					}
				})
				.catch((error: unknown) => {
					notifyError(`Could not remove the link: ${error instanceof Error ? error.message : String(error)}`);
				});
		},
		[currentProjectId, setBoard],
	);
}
