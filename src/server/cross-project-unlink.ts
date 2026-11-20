// sked fork: remove a cross-project link from the PREREQUISITE's side. A "needed by" chip names a
// card on another project's board that waits on a task of this project, and the link lives only in
// that card's `dependsOn`, on a board the browser does not hold. So the runtime edits that board,
// the way `kanban task unlink --task-id <dependent> --linked-task-id <task> --linked-project-id
// <this project>` does, and tells open browsers it changed.

import type {
	RuntimeCrossProjectUnlinkDependentRequest,
	RuntimeCrossProjectUnlinkDependentResponse,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { removeCrossProjectPrerequisite } from "../core/task-board-mutations";
import type {
	RuntimeWorkspaceAtomicMutationResponse,
	RuntimeWorkspaceAtomicMutationResult,
	RuntimeWorkspaceIndexEntry,
} from "../state/workspace-state";

export interface CrossProjectUnlinkDependencies {
	listProjects: () => Promise<RuntimeWorkspaceIndexEntry[]>;
	mutateWorkspaceState: <T>(
		repoPath: string,
		mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceAtomicMutationResult<T>,
	) => Promise<RuntimeWorkspaceAtomicMutationResponse<T>>;
	/** Tells open browsers that this project's board and the project list changed. */
	notifyWorkspaceStateUpdated: (scope: { workspaceId: string; workspacePath: string }) => void;
}

export async function unlinkCrossProjectDependent(
	deps: CrossProjectUnlinkDependencies,
	projectId: string,
	input: RuntimeCrossProjectUnlinkDependentRequest,
): Promise<RuntimeCrossProjectUnlinkDependentResponse> {
	const dependentProject = (await deps.listProjects()).find(
		(project) => project.workspaceId === input.dependentProjectId,
	);
	if (!dependentProject) {
		return { ok: false, error: `Project "${input.dependentProjectId}" is not added to Kanban.` };
	}
	const mutation = await deps.mutateWorkspaceState(dependentProject.repoPath, (state) => {
		const result = removeCrossProjectPrerequisite(state.board, input.dependentTaskId, {
			projectId,
			taskId: input.taskId,
		});
		return result.removed
			? { board: result.board, value: null }
			: { board: state.board, value: result.reason, save: false };
	});
	if (mutation.value === "missing_task") {
		return { ok: false, error: `Task "${input.dependentTaskId}" no longer exists.` };
	}
	if (mutation.value === "not_linked") {
		return { ok: false, error: `Task "${input.dependentTaskId}" no longer depends on "${input.taskId}".` };
	}
	deps.notifyWorkspaceStateUpdated({
		workspaceId: dependentProject.workspaceId,
		workspacePath: dependentProject.repoPath,
	});
	return { ok: true };
}
