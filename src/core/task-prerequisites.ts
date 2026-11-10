// sked fork: the one rule for whether a card may start. A card is blocked while any prerequisite it
// names, on this board or on another project's board, still exists and is not Done. Every start path
// (the web UI's Start button and drag, `kanban task start`, and every auto-start) asks this module.

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectReferencedTask,
	RuntimeTaskSessionSummary,
} from "./api-contract";

/** A prerequisite that still blocks its card. A Done one never does, so it has no `trash` column. */
export interface OpenPrerequisite {
	taskId: string;
	/** Set when the prerequisite is on another project's board. */
	projectId?: string;
	columnId: Exclude<RuntimeBoardColumnId, "trash">;
	title: string;
}

/** A card on another project's board, as of the latest read of that board. */
export interface CrossProjectTaskStatus {
	columnId: RuntimeBoardColumnId;
	title: string;
}

/**
 * Looks up a card on another project's board. Returns null when the card was deleted or its project
 * was removed from Kanban; such a prerequisite does not block, the same as a deleted same-board one.
 */
export type CrossProjectTaskLookup = (projectId: string, taskId: string) => CrossProjectTaskStatus | null;

export interface PrerequisiteContext {
	lookupCrossProjectTask: CrossProjectTaskLookup;
	/**
	 * This board's live sessions. Pass them when the board was read from disk, which lags its sessions
	 * while nobody has the project open (see `resolveLiveTaskColumnId`).
	 */
	sessions?: Readonly<Record<string, RuntimeTaskSessionSummary>>;
}

/** For a board with no cross-project refs to resolve, such as one built in a test. */
export const NO_CROSS_PROJECT_TASKS: CrossProjectTaskLookup = () => null;

/**
 * The column a card shows once its board catches up with its session. A board only moves a card for
 * a session change while that project is open in a browser, so a project nobody is looking at keeps
 * the old column on disk. These are the moves the web UI makes on its own (`use-board-interactions.ts`);
 * the project task counts apply the same awaiting-review and interrupted rules.
 */
export function resolveLiveTaskColumnId(
	columnId: RuntimeBoardColumnId,
	session: RuntimeTaskSessionSummary | undefined,
): RuntimeBoardColumnId {
	if (!session) {
		return columnId;
	}
	if (session.state === "awaiting_review" && columnId === "in_progress") {
		return "review";
	}
	if (session.state === "running" && columnId === "review") {
		return "in_progress";
	}
	if (session.state === "interrupted" && (columnId === "in_progress" || columnId === "review")) {
		return "trash";
	}
	return columnId;
}

/**
 * Only a prerequisite that moves from Review to Done finishes it and can start the cards waiting on it.
 * Moved to Done from any other column (or deleted), it just stops blocking them. The same rule applies
 * to same-board links and to cross-project refs.
 */
export function isPrerequisiteFinishingMove(fromColumnId: RuntimeBoardColumnId | null): boolean {
	return fromColumnId === "review";
}

/** Resolves cross-project refs from project summaries, whose `referencedTasks` carry live columns. */
export function createCrossProjectTaskLookup(
	projects: readonly { id: string; referencedTasks?: readonly RuntimeProjectReferencedTask[] }[],
): CrossProjectTaskLookup {
	const tasksByProjectId = new Map<string, Map<string, CrossProjectTaskStatus>>();
	for (const project of projects) {
		tasksByProjectId.set(
			project.id,
			new Map(
				(project.referencedTasks ?? []).map((task) => [
					task.taskId,
					{ columnId: task.columnId, title: task.title },
				]),
			),
		);
	}
	return (projectId, taskId) => tasksByProjectId.get(projectId)?.get(taskId) ?? null;
}

function findCard(
	board: RuntimeBoardData,
	taskId: string,
): { columnId: RuntimeBoardColumnId; card: RuntimeBoardCard } | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { columnId: column.id, card };
		}
	}
	return null;
}

/** Same-board prerequisites: live links on the waiting side plus `dependsOn` entries, whose links may be gone. */
function collectSameBoardPrerequisiteIds(board: RuntimeBoardData, taskId: string): string[] {
	const ids = new Set<string>();
	for (const dependency of board.dependencies) {
		if (dependency.fromTaskId === taskId) {
			ids.add(dependency.toTaskId);
		}
	}
	for (const ref of findCard(board, taskId)?.card.dependsOn ?? []) {
		if (ref.projectId === undefined) {
			ids.add(ref.taskId);
		}
	}
	ids.delete(taskId);
	return [...ids];
}

function toOpenPrerequisite(
	ref: { taskId: string; projectId?: string },
	status: CrossProjectTaskStatus | null,
): OpenPrerequisite | null {
	if (!status || status.columnId === "trash") {
		return null;
	}
	return {
		taskId: ref.taskId,
		...(ref.projectId !== undefined ? { projectId: ref.projectId } : {}),
		columnId: status.columnId,
		title: status.title,
	};
}

/**
 * Every prerequisite of `taskId` that still exists and is not Done: same-board ones first, in link
 * order, then cross-project ones in `dependsOn` order. Empty when the card may start.
 */
export function listOpenPrerequisites(
	board: RuntimeBoardData,
	taskId: string,
	context: PrerequisiteContext,
): OpenPrerequisite[] {
	const open: OpenPrerequisite[] = [];
	for (const prerequisiteId of collectSameBoardPrerequisiteIds(board, taskId)) {
		const found = findCard(board, prerequisiteId);
		const status = found
			? {
					columnId: resolveLiveTaskColumnId(found.columnId, context.sessions?.[prerequisiteId]),
					title: found.card.title,
				}
			: null;
		const prerequisite = toOpenPrerequisite({ taskId: prerequisiteId }, status);
		if (prerequisite) {
			open.push(prerequisite);
		}
	}
	const seenCrossProjectRefs = new Set<string>();
	for (const ref of findCard(board, taskId)?.card.dependsOn ?? []) {
		if (ref.projectId === undefined) {
			continue;
		}
		const key = `${ref.projectId}#${ref.taskId}`;
		if (seenCrossProjectRefs.has(key)) {
			continue;
		}
		seenCrossProjectRefs.add(key);
		const prerequisite = toOpenPrerequisite(ref, context.lookupCrossProjectTask(ref.projectId, ref.taskId));
		if (prerequisite) {
			open.push(prerequisite);
		}
	}
	return open;
}

export function isTaskBlockedByPrerequisites(
	board: RuntimeBoardData,
	taskId: string,
	context: PrerequisiteContext,
): boolean {
	return listOpenPrerequisites(board, taskId, context).length > 0;
}

/** Backlog cards on `board` that name the cross-project task `projectId`/`taskId` in their `dependsOn`. */
export function findBacklogTasksWaitingOnCrossProjectTask(
	board: RuntimeBoardData,
	projectId: string,
	taskId: string,
): string[] {
	const backlog = board.columns.find((column) => column.id === "backlog");
	return (backlog?.cards ?? [])
		.filter((card) => (card.dependsOn ?? []).some((ref) => ref.projectId === projectId && ref.taskId === taskId))
		.map((card) => card.id);
}
