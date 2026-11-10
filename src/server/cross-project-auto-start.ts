// sked fork: when a card moves from Review to Done, start the backlog cards on OTHER projects' boards
// that name it in `dependsOn` and are now blocked by nothing. It runs in the runtime because the
// waiting project may not be open in any browser; same-board auto-start stays with the caller that
// moved the card (`kanban task done`, the web UI), which already holds that board.

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeCrossProjectAutoStartedTask,
	RuntimeCrossProjectAutoStartResponse,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionSummary,
	RuntimeWorktreeEnsureResponse,
} from "../core/api-contract";
import { getTaskColumnId, moveTaskToColumn } from "../core/task-board-mutations";
import {
	createCrossProjectTaskLookup,
	findBacklogTasksWaitingOnCrossProjectTask,
	listOpenPrerequisites,
} from "../core/task-prerequisites";
import { collectReferencedTasksByProjectId } from "./cross-project-task-refs";
import type { ProjectBoardSnapshot } from "./workspace-registry";

export interface CrossProjectAutoStartScope {
	workspaceId: string;
	workspacePath: string;
}

export interface CrossProjectAutoStartDependencies {
	loadProjectBoards: () => Promise<ProjectBoardSnapshot[]>;
	ensureTaskWorktree: (input: {
		cwd: string;
		taskId: string;
		baseRef: string;
	}) => Promise<RuntimeWorktreeEnsureResponse>;
	/** Moves the card from Backlog to In Progress on disk. Returns false when it is no longer in Backlog. */
	moveBacklogTaskToInProgress: (repoPath: string, taskId: string) => Promise<boolean>;
	/** Tells open browsers that this project's board and the project list changed. */
	notifyWorkspaceStateUpdated: (scope: CrossProjectAutoStartScope) => void;
}

export interface StartCrossProjectDependentsInput {
	/** The project whose card just moved from Review to Done. */
	projectId: string;
	taskId: string;
	/** Starts an agent session; the request's runtime API supplies it. */
	startTaskSession: (
		scope: CrossProjectAutoStartScope,
		request: RuntimeTaskSessionStartRequest,
	) => Promise<RuntimeTaskSessionStartResponse>;
}

export interface CrossProjectAutoStarter {
	startDependents: (input: StartCrossProjectDependentsInput) => Promise<RuntimeCrossProjectAutoStartResponse>;
}

interface ReadyTask {
	scope: CrossProjectAutoStartScope;
	task: RuntimeBoardCard;
}

function isSessionActive(session: RuntimeTaskSessionSummary | undefined): boolean {
	return session?.state === "running" || session?.state === "awaiting_review";
}

function findCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return card;
		}
	}
	return null;
}

/** The waiting cards that this finished card leaves blocked by nothing, read from fresh boards. */
function findReadyDependents(
	snapshots: readonly ProjectBoardSnapshot[],
	projectId: string,
	taskId: string,
): ReadyTask[] {
	const referencedTasksByProjectId = collectReferencedTasksByProjectId(snapshots);
	const lookupCrossProjectTask = createCrossProjectTaskLookup(
		[...referencedTasksByProjectId].map(([id, referencedTasks]) => ({ id, referencedTasks })),
	);
	// The move may have been lost (a board conflict), or the card restored since: then nothing finished.
	if (lookupCrossProjectTask(projectId, taskId)?.columnId !== "trash") {
		return [];
	}
	const ready: ReadyTask[] = [];
	for (const snapshot of snapshots) {
		const { board } = snapshot;
		if (snapshot.workspaceId === projectId || !board) {
			continue;
		}
		const sessions = Object.fromEntries(snapshot.sessionsByTaskId);
		for (const waitingTaskId of findBacklogTasksWaitingOnCrossProjectTask(board, projectId, taskId)) {
			const task = findCard(board, waitingTaskId);
			if (
				!task ||
				isSessionActive(sessions[waitingTaskId]) ||
				listOpenPrerequisites(board, waitingTaskId, { lookupCrossProjectTask, sessions }).length > 0
			) {
				continue;
			}
			ready.push({ scope: { workspaceId: snapshot.workspaceId, workspacePath: snapshot.repoPath }, task });
		}
	}
	return ready;
}

function toStartedTask(ready: ReadyTask): RuntimeCrossProjectAutoStartedTask {
	return { projectId: ready.scope.workspaceId, taskId: ready.task.id, title: ready.task.title };
}

export function createCrossProjectAutoStarter(deps: CrossProjectAutoStartDependencies): CrossProjectAutoStarter {
	// One run at a time: two prerequisites of one card finishing together must not both start it. Each
	// run reads the boards after the previous run moved its cards, so the second sees the card started.
	let queue: Promise<unknown> = Promise.resolve();

	const startReadyTask = async (
		ready: ReadyTask,
		startTaskSession: StartCrossProjectDependentsInput["startTaskSession"],
	): Promise<string | null> => {
		const { scope, task } = ready;
		const ensured = await deps.ensureTaskWorktree({
			cwd: scope.workspacePath,
			taskId: task.id,
			baseRef: task.baseRef,
		});
		if (!ensured.ok) {
			return ensured.error ?? "Could not set up the task worktree.";
		}
		const started = await startTaskSession(scope, {
			taskId: task.id,
			prompt: task.prompt,
			taskTitle: task.title,
			images: task.images,
			startInPlanMode: task.startInPlanMode,
			baseRef: task.baseRef,
			agentId: task.agentId,
			clineSettings: task.clineSettings,
		});
		if (!started.ok) {
			return started.error ?? "Could not start the task session.";
		}
		await deps.moveBacklogTaskToInProgress(scope.workspacePath, task.id);
		deps.notifyWorkspaceStateUpdated(scope);
		return null;
	};

	const run = async (input: StartCrossProjectDependentsInput): Promise<RuntimeCrossProjectAutoStartResponse> => {
		const readyTasks = findReadyDependents(await deps.loadProjectBoards(), input.projectId, input.taskId);
		const response: RuntimeCrossProjectAutoStartResponse = { ok: true, startedTasks: [], failedTasks: [] };
		for (const ready of readyTasks) {
			const error = await startReadyTask(ready, input.startTaskSession).catch((cause: unknown) =>
				cause instanceof Error ? cause.message : String(cause),
			);
			if (error === null) {
				response.startedTasks.push(toStartedTask(ready));
			} else {
				response.failedTasks.push({ ...toStartedTask(ready), error });
			}
		}
		response.ok = response.failedTasks.length === 0;
		return response;
	};

	return {
		startDependents: (input) => {
			const result = queue.then(() => run(input));
			queue = result.catch(() => undefined);
			return result;
		},
	};
}

/** `moveBacklogTaskToInProgress` for a board on disk. */
export function moveBacklogTaskToInProgressOnBoard(board: RuntimeBoardData, taskId: string): RuntimeBoardData | null {
	if (getTaskColumnId(board, taskId) !== "backlog") {
		return null;
	}
	const moved = moveTaskToColumn(board, taskId, "in_progress");
	return moved.moved ? moved.board : null;
}
