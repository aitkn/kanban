import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskClineSettings,
	RuntimeTaskDependsOnRef,
	RuntimeTaskImage,
} from "./api-contract";
import { createUniqueTaskId } from "./task-id";
import { resolveTaskTitle } from "./task-title";

export interface RuntimeCreateTaskInput {
	taskId?: string;
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	images?: RuntimeTaskImage[];
	agentId?: RuntimeAgentId;
	clineSettings?: RuntimeTaskClineSettings;
	baseRef: string;
}

export interface RuntimeUpdateTaskInput {
	title?: string;
	prompt: string;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	images?: RuntimeTaskImage[];
	agentId?: RuntimeAgentId | null;
	clineSettings?: RuntimeTaskClineSettings | null;
	baseRef: string;
}

function normalizeTaskAutoReviewMode(value: RuntimeTaskAutoReviewMode | null | undefined): RuntimeTaskAutoReviewMode {
	if (value === "pr") {
		return value;
	}
	return "commit";
}

// Copy image metadata so board tasks do not retain caller-owned array or object references.
function cloneTaskImages(images?: RuntimeTaskImage[]): RuntimeTaskImage[] | undefined {
	return images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined;
}

function cloneTaskClineSettings(settings?: RuntimeTaskClineSettings | null): RuntimeTaskClineSettings | undefined {
	if (settings === undefined || settings === null) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

export interface RuntimeCreateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard;
}

export interface RuntimeMoveTaskResult {
	moved: boolean;
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	fromColumnId: RuntimeBoardColumnId | null;
}

export interface RuntimeUpdateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	updated: boolean;
}

export interface RuntimeAddTaskDependencyResult {
	board: RuntimeBoardData;
	added: boolean;
	reason?: "missing_task" | "same_task" | "duplicate" | "trash_task" | "non_backlog";
	dependency?: RuntimeBoardDependency;
}

export interface RuntimeRemoveTaskDependencyResult {
	board: RuntimeBoardData;
	removed: boolean;
}

export interface RuntimeTrashTaskResult extends RuntimeMoveTaskResult {
	readyTaskIds: string[];
}

export interface RuntimeDeleteTasksResult {
	board: RuntimeBoardData;
	deleted: boolean;
	deletedTaskIds: string[];
}

function collectExistingTaskIds(board: RuntimeBoardData): Set<string> {
	const existingIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			existingIds.add(card.id);
		}
	}
	return existingIds;
}

function collectTaskIds(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function createDependencyId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

function createDependencyPairKey(backlogTaskId: string, linkedTaskId: string): string {
	return `${backlogTaskId}::${linkedTaskId}`;
}

function hasDependencyPair(board: RuntimeBoardData, backlogTaskId: string, linkedTaskId: string): boolean {
	const pairKey = createDependencyPairKey(backlogTaskId, linkedTaskId);
	for (const dependency of board.dependencies) {
		const existing = resolveDependencyEndpoints(board, dependency.fromTaskId, dependency.toTaskId);
		if ("reason" in existing) {
			continue;
		}
		if (createDependencyPairKey(existing.backlogTaskId, existing.linkedTaskId) === pairKey) {
			return true;
		}
	}
	return false;
}

function findTaskLocation(
	board: RuntimeBoardData,
	taskId: string,
): {
	columnIndex: number;
	taskIndex: number;
	columnId: RuntimeBoardColumnId;
	task: RuntimeBoardCard;
} | null {
	for (const [columnIndex, column] of board.columns.entries()) {
		const taskIndex = column.cards.findIndex((card) => card.id === taskId);
		if (taskIndex === -1) {
			continue;
		}
		const task = column.cards[taskIndex];
		if (!task) {
			continue;
		}
		return {
			columnIndex,
			taskIndex,
			columnId: column.id,
			task,
		};
	}
	return null;
}

function isSameProjectRef(ref: RuntimeTaskDependsOnRef, taskId: string): boolean {
	return ref.taskId === taskId && ref.projectId === undefined;
}

function updateCardDependsOn(
	board: RuntimeBoardData,
	taskId: string,
	update: (dependsOn: RuntimeTaskDependsOnRef[]) => RuntimeTaskDependsOnRef[] | null,
): RuntimeBoardData {
	const found = findTaskLocation(board, taskId);
	if (!found) {
		return board;
	}
	const dependsOn = update(found.task.dependsOn ?? []);
	if (!dependsOn) {
		return board;
	}
	const cards = [...(board.columns[found.columnIndex]?.cards ?? [])];
	cards[found.taskIndex] = { ...found.task, dependsOn };
	return {
		...board,
		columns: board.columns.map((column, index) => (index === found.columnIndex ? { ...column, cards } : column)),
	};
}

/**
 * sked fork: remember on the waiting card that it was linked to a same-project prerequisite.
 * Unlike `board.dependencies`, this record survives either card changing column.
 */
export function recordTaskPrerequisite(
	board: RuntimeBoardData,
	waitingTaskId: string,
	prerequisiteTaskId: string,
): RuntimeBoardData {
	return updateCardDependsOn(board, waitingTaskId, (dependsOn) =>
		dependsOn.some((ref) => isSameProjectRef(ref, prerequisiteTaskId))
			? null
			: [...dependsOn, { taskId: prerequisiteTaskId }],
	);
}

function hasRecordedPrerequisite(board: RuntimeBoardData, waitingTaskId: string, prerequisiteTaskId: string): boolean {
	const found = findTaskLocation(board, waitingTaskId);
	return (found?.task.dependsOn ?? []).some((ref) => isSameProjectRef(ref, prerequisiteTaskId));
}

/**
 * sked fork: record live links that neither card has recorded yet. Links created before `dependsOn`
 * existed were never recorded, and linking the pair again is refused as a duplicate, so the board is
 * backfilled when it is read. A link recorded on either card is skipped: `updateTaskDependencies`
 * flips a link when its waiting card leaves backlog while the prerequisite is still there, and the
 * flipped link must not be recorded the other way round. Returns the same board when nothing changed.
 */
export function recordLinkedPrerequisites(board: RuntimeBoardData): RuntimeBoardData {
	return board.dependencies.reduce((current, dependency) => {
		if (
			hasRecordedPrerequisite(current, dependency.fromTaskId, dependency.toTaskId) ||
			hasRecordedPrerequisite(current, dependency.toTaskId, dependency.fromTaskId)
		) {
			return current;
		}
		return recordTaskPrerequisite(current, dependency.fromTaskId, dependency.toTaskId);
	}, board);
}

/** sked fork: drop a same-project prerequisite from the waiting card's `dependsOn` (an explicit unlink). */
export function forgetTaskPrerequisite(
	board: RuntimeBoardData,
	waitingTaskId: string,
	prerequisiteTaskId: string,
): RuntimeBoardData {
	return updateCardDependsOn(board, waitingTaskId, (dependsOn) =>
		dependsOn.some((ref) => isSameProjectRef(ref, prerequisiteTaskId))
			? dependsOn.filter((ref) => !isSameProjectRef(ref, prerequisiteTaskId))
			: null,
	);
}

/** sked fork: a prerequisite on another project's board. */
export interface CrossProjectTaskRef {
	taskId: string;
	projectId: string;
}

export type RuntimeCrossProjectLinkResult =
	| { added: true; board: RuntimeBoardData }
	| { added: false; reason: "missing_task" | "trash_task" | "duplicate" };

export type RuntimeCrossProjectUnlinkResult =
	| { removed: true; board: RuntimeBoardData }
	| { removed: false; reason: "missing_task" | "not_linked" };

function isCrossProjectRef(ref: RuntimeTaskDependsOnRef, target: CrossProjectTaskRef): boolean {
	return ref.taskId === target.taskId && ref.projectId === target.projectId;
}

/**
 * sked fork: record that `waitingTaskId` depends on a task on another project's board. The ref is
 * display-only: it never enters `board.dependencies`, so it starts nothing. The caller checks that
 * the other project and its task exist; boards cannot see each other.
 */
export function addCrossProjectPrerequisite(
	board: RuntimeBoardData,
	waitingTaskId: string,
	prerequisite: CrossProjectTaskRef,
): RuntimeCrossProjectLinkResult {
	const found = findTaskLocation(board, waitingTaskId);
	if (!found) {
		return { added: false, reason: "missing_task" };
	}
	if (found.columnId === "trash") {
		return { added: false, reason: "trash_task" };
	}
	if ((found.task.dependsOn ?? []).some((ref) => isCrossProjectRef(ref, prerequisite))) {
		return { added: false, reason: "duplicate" };
	}
	return {
		added: true,
		board: updateCardDependsOn(board, waitingTaskId, (dependsOn) => [
			...dependsOn,
			{ taskId: prerequisite.taskId, projectId: prerequisite.projectId },
		]),
	};
}

/** sked fork: drop a cross-project prerequisite from the waiting card's `dependsOn`. */
export function removeCrossProjectPrerequisite(
	board: RuntimeBoardData,
	waitingTaskId: string,
	prerequisite: CrossProjectTaskRef,
): RuntimeCrossProjectUnlinkResult {
	const found = findTaskLocation(board, waitingTaskId);
	if (!found) {
		return { removed: false, reason: "missing_task" };
	}
	if (!(found.task.dependsOn ?? []).some((ref) => isCrossProjectRef(ref, prerequisite))) {
		return { removed: false, reason: "not_linked" };
	}
	return {
		removed: true,
		board: updateCardDependsOn(board, waitingTaskId, (dependsOn) =>
			dependsOn.filter((ref) => !isCrossProjectRef(ref, prerequisite)),
		),
	};
}

function resolveDependencyEndpoints(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
):
	| {
			backlogTaskId: string;
			linkedTaskId: string;
	  }
	| { reason: RuntimeAddTaskDependencyResult["reason"] } {
	const firstColumnId = getTaskColumnId(board, firstTaskId);
	const secondColumnId = getTaskColumnId(board, secondTaskId);
	if (!firstColumnId || !secondColumnId) {
		return { reason: "missing_task" };
	}
	if (firstColumnId === "trash" || secondColumnId === "trash") {
		return { reason: "trash_task" };
	}
	const firstIsBacklog = firstColumnId === "backlog";
	const secondIsBacklog = secondColumnId === "backlog";
	if (firstIsBacklog && secondIsBacklog) {
		return {
			backlogTaskId: firstTaskId,
			linkedTaskId: secondTaskId,
		};
	}
	if (!firstIsBacklog && !secondIsBacklog) {
		return { reason: "non_backlog" };
	}
	return firstIsBacklog
		? { backlogTaskId: firstTaskId, linkedTaskId: secondTaskId }
		: { backlogTaskId: secondTaskId, linkedTaskId: firstTaskId };
}

// Backlog cards waiting on `taskId` whose wait is satisfied by `taskId` finishing.
// Only a review -> done move counts as finishing; other moves into trash just drop the link.
function getBacklogTaskIdsUnblockedByTaskTrashed(
	board: RuntimeBoardData,
	taskId: string,
	fromColumnId: RuntimeBoardColumnId | null,
): string[] {
	if (!taskId || board.dependencies.length === 0 || fromColumnId !== "review") {
		return [];
	}
	const unblockedTaskIds = new Set<string>();
	for (const dependency of board.dependencies) {
		if (dependency.toTaskId !== taskId) {
			continue;
		}
		if (getTaskColumnId(board, dependency.fromTaskId) !== "backlog") {
			continue;
		}
		unblockedTaskIds.add(dependency.fromTaskId);
	}
	return [...unblockedTaskIds];
}

/**
 * sked fork: number of unfinished prerequisites a backlog card still waits on.
 * Links are pruned as soon as a prerequisite reaches done, so every link that
 * remains with this card on the waiting side is a prerequisite still pending.
 */
export function countPendingPrerequisites(board: RuntimeBoardData, taskId: string): number {
	return board.dependencies.filter((dependency) => dependency.fromTaskId === taskId).length;
}

export function updateTaskDependencies(board: RuntimeBoardData): RuntimeBoardData {
	if (board.dependencies.length === 0) {
		return board;
	}
	const taskIds = collectTaskIds(board);
	const dependencies: RuntimeBoardDependency[] = [];
	const existingPairs = new Set<string>();
	for (const dependency of board.dependencies) {
		const firstTaskId = dependency.fromTaskId.trim();
		const secondTaskId = dependency.toTaskId.trim();
		if (!firstTaskId || !secondTaskId || firstTaskId === secondTaskId) {
			continue;
		}
		if (!taskIds.has(firstTaskId) || !taskIds.has(secondTaskId)) {
			continue;
		}
		const resolved = resolveDependencyEndpoints(board, firstTaskId, secondTaskId);
		if ("reason" in resolved) {
			continue;
		}
		const pairKey = createDependencyPairKey(resolved.backlogTaskId, resolved.linkedTaskId);
		if (existingPairs.has(pairKey)) {
			continue;
		}
		existingPairs.add(pairKey);
		dependencies.push({
			id: dependency.id,
			fromTaskId: resolved.backlogTaskId,
			toTaskId: resolved.linkedTaskId,
			createdAt: dependency.createdAt,
		});
	}
	if (
		dependencies.length === board.dependencies.length &&
		dependencies.every((dependency, index) => {
			const current = board.dependencies[index];
			return (
				current &&
				current.id === dependency.id &&
				current.fromTaskId === dependency.fromTaskId &&
				current.toTaskId === dependency.toTaskId &&
				current.createdAt === dependency.createdAt
			);
		})
	) {
		return board;
	}
	return {
		...board,
		dependencies,
	};
}

export function addTaskToColumn(
	board: RuntimeBoardData,
	columnId: RuntimeBoardColumnId,
	input: RuntimeCreateTaskInput,
	randomUuid: () => string,
	now: number = Date.now(),
): RuntimeCreateTaskResult {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task baseRef is required.");
	}
	const existingIds = collectExistingTaskIds(board);
	const explicitTaskId = input.taskId?.trim();
	if (explicitTaskId && existingIds.has(explicitTaskId)) {
		throw new Error(`Task "${explicitTaskId}" already exists.`);
	}
	const task: RuntimeBoardCard = {
		id: explicitTaskId || createUniqueTaskId(existingIds, randomUuid),
		title: resolveTaskTitle(input.title, prompt),
		prompt,
		startInPlanMode: Boolean(input.startInPlanMode),
		autoReviewEnabled: Boolean(input.autoReviewEnabled),
		autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
		images: cloneTaskImages(input.images),
		...(input.agentId ? { agentId: input.agentId } : {}),
		...(input.clineSettings !== undefined ? { clineSettings: cloneTaskClineSettings(input.clineSettings) } : {}),
		baseRef,
		createdAt: now,
		updatedAt: now,
	};

	const targetColumnIndex = board.columns.findIndex((column) => column.id === columnId);
	if (targetColumnIndex === -1) {
		throw new Error(`Column ${columnId} not found.`);
	}

	const columns = board.columns.map((column, index) => {
		if (index !== targetColumnIndex) {
			return column;
		}
		return {
			...column,
			cards: [task, ...column.cards],
		};
	});

	return {
		board: {
			...board,
			columns,
		},
		task,
	};
}

export function getTaskColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const found = findTaskLocation(board, normalizedTaskId);
	return found ? found.columnId : null;
}

export function addTaskDependency(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
): RuntimeAddTaskDependencyResult {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId) {
		return { board, added: false, reason: "missing_task" };
	}
	if (normalizedFirstTaskId === normalizedSecondTaskId) {
		return { board, added: false, reason: "same_task" };
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return { board, added: false, reason: resolved.reason };
	}
	if (hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId)) {
		return { board, added: false, reason: "duplicate" };
	}
	const dependency: RuntimeBoardDependency = {
		id: createDependencyId(),
		fromTaskId: resolved.backlogTaskId,
		toTaskId: resolved.linkedTaskId,
		createdAt: Date.now(),
	};
	return {
		// sked fork: also record the prerequisite on the waiting card, see recordTaskPrerequisite.
		board: recordTaskPrerequisite(
			{
				...board,
				dependencies: [...board.dependencies, dependency],
			},
			dependency.fromTaskId,
			dependency.toTaskId,
		),
		added: true,
		dependency,
	};
}

export function canAddTaskDependency(board: RuntimeBoardData, firstTaskId: string, secondTaskId: string): boolean {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId || normalizedFirstTaskId === normalizedSecondTaskId) {
		return false;
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return false;
	}
	return !hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId);
}

export function removeTaskDependency(board: RuntimeBoardData, dependencyId: string): RuntimeRemoveTaskDependencyResult {
	const removedDependency = board.dependencies.find((dependency) => dependency.id === dependencyId);
	if (!removedDependency) {
		return { board, removed: false };
	}
	const dependencies = board.dependencies.filter((dependency) => dependency.id !== dependencyId);
	const { fromTaskId, toTaskId } = removedDependency;
	// sked fork: an explicit unlink also forgets the prerequisite on the waiting card. The link may have
	// been flipped since it was recorded (see recordLinkedPrerequisites), so try the other card too.
	const boardWithoutLink = { ...board, dependencies };
	return {
		board: hasRecordedPrerequisite(boardWithoutLink, fromTaskId, toTaskId)
			? forgetTaskPrerequisite(boardWithoutLink, fromTaskId, toTaskId)
			: forgetTaskPrerequisite(boardWithoutLink, toTaskId, fromTaskId),
		removed: true,
	};
}

export type RuntimeRemoveTaskPrerequisiteResult =
	| { removed: true; board: RuntimeBoardData }
	| { removed: false; reason: "missing_task" | "not_linked" };

/**
 * sked fork: unlink by the two task IDs, so a `dependsOn` entry can be removed after its live link is
 * gone (the prerequisite finished, or the waiting card started). Removes `prerequisiteTaskId` from the
 * waiting card's `dependsOn` and any live link through which it waits on it, including that link
 * flipped (see `recordLinkedPrerequisites`). A link in which the other card waits on this one, recorded
 * on the other card, is a different link and is kept. Called with the two IDs of a flipped link the
 * way `task list` now shows it (the card that started second), it removes that link and, as
 * `removeTaskDependency` does, the entry the other card recorded for it.
 */
export function removeTaskPrerequisite(
	board: RuntimeBoardData,
	waitingTaskId: string,
	prerequisiteTaskId: string,
): RuntimeRemoveTaskPrerequisiteResult {
	if (!findTaskLocation(board, waitingTaskId)) {
		return { removed: false, reason: "missing_task" };
	}
	const recorded = hasRecordedPrerequisite(board, waitingTaskId, prerequisiteTaskId);
	const flippedLinkIsOurs = recorded && !hasRecordedPrerequisite(board, prerequisiteTaskId, waitingTaskId);
	const dependencies = board.dependencies.filter(
		(dependency) =>
			!(
				(dependency.fromTaskId === waitingTaskId && dependency.toTaskId === prerequisiteTaskId) ||
				(flippedLinkIsOurs && dependency.fromTaskId === prerequisiteTaskId && dependency.toTaskId === waitingTaskId)
			),
	);
	const removedLiveLink = dependencies.length !== board.dependencies.length;
	if (!recorded && !removedLiveLink) {
		return { removed: false, reason: "not_linked" };
	}
	const removedLinkFlippedFromOtherCard =
		removedLiveLink && !recorded && hasRecordedPrerequisite(board, prerequisiteTaskId, waitingTaskId);
	const withoutOwnEntry = forgetTaskPrerequisite({ ...board, dependencies }, waitingTaskId, prerequisiteTaskId);
	return {
		removed: true,
		board: removedLinkFlippedFromOtherCard
			? forgetTaskPrerequisite(withoutOwnEntry, prerequisiteTaskId, waitingTaskId)
			: withoutOwnEntry,
	};
}

export function getReadyLinkedTaskIdsForTaskInTrash(board: RuntimeBoardData, taskId: string): string[] {
	return trashTaskAndGetReadyLinkedTaskIds(board, taskId).readyTaskIds;
}

/**
 * sked fork: linked cards join (ALL prerequisites) instead of starting after the first (ANY).
 * Moves `taskId` to trash and returns the backlog cards that should auto-start.
 * A waiting card starts only when this move finished its LAST pending prerequisite
 * (join semantics): it must have been unblocked by this review -> done move and have
 * no links left once the move has pruned the finished prerequisite.
 */
export function trashTaskAndGetReadyLinkedTaskIds(
	board: RuntimeBoardData,
	taskId: string,
	now: number = Date.now(),
): RuntimeTrashTaskResult {
	const fromColumnId = getTaskColumnId(board, taskId);
	const unblockedTaskIds = getBacklogTaskIdsUnblockedByTaskTrashed(board, taskId, fromColumnId);
	const movedToTrash = moveTaskToColumn(board, taskId, "trash", now);
	if (!movedToTrash.moved) {
		return { ...movedToTrash, readyTaskIds: [] };
	}
	const readyTaskIds = unblockedTaskIds.filter(
		(unblockedTaskId) => countPendingPrerequisites(movedToTrash.board, unblockedTaskId) === 0,
	);
	return {
		...movedToTrash,
		readyTaskIds,
	};
}

export function deleteTasksFromBoard(board: RuntimeBoardData, taskIds: Iterable<string>): RuntimeDeleteTasksResult {
	const normalizedTaskIds = new Set(
		Array.from(taskIds, (taskId) => taskId.trim()).filter((taskId) => taskId.length > 0),
	);
	if (normalizedTaskIds.size === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIds: string[] = [];
	const columns = board.columns.map((column) => {
		const remainingCards = column.cards.filter((card) => {
			if (!normalizedTaskIds.has(card.id)) {
				return true;
			}
			deletedTaskIds.push(card.id);
			return false;
		});
		return remainingCards.length === column.cards.length ? column : { ...column, cards: remainingCards };
	});

	if (deletedTaskIds.length === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIdSet = new Set(deletedTaskIds);
	const dependencies = board.dependencies.filter(
		(dependency) => !deletedTaskIdSet.has(dependency.fromTaskId) && !deletedTaskIdSet.has(dependency.toTaskId),
	);

	return {
		board: {
			...board,
			columns,
			dependencies,
		},
		deleted: true,
		deletedTaskIds,
	};
}

export function moveTaskToColumn(
	board: RuntimeBoardData,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId,
	now: number = Date.now(),
): RuntimeMoveTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}

	const found = findTaskLocation(board, normalizedTaskId);
	if (!found) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}
	if (found.columnId === targetColumnId) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const targetColumnIndex = board.columns.findIndex((column) => column.id === targetColumnId);
	if (targetColumnIndex === -1) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceColumn = board.columns[found.columnIndex];
	const targetColumn = board.columns[targetColumnIndex];
	if (!sourceColumn || !targetColumn) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceCards = [...sourceColumn.cards];
	const [task] = sourceCards.splice(found.taskIndex, 1);
	if (!task) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const movedTask: RuntimeBoardCard = {
		...task,
		updatedAt: now,
	};
	const targetCards =
		targetColumnId === "trash" ? [movedTask, ...targetColumn.cards] : [...targetColumn.cards, movedTask];

	const columns = board.columns.map((column, index) => {
		if (index === found.columnIndex) {
			return {
				...column,
				cards: sourceCards,
			};
		}
		if (index === targetColumnIndex) {
			return {
				...column,
				cards: targetCards,
			};
		}
		return column;
	});

	return {
		moved: true,
		board: updateTaskDependencies({
			...board,
			columns,
		}),
		task: movedTask,
		fromColumnId: found.columnId,
	};
}

export function updateTask(
	board: RuntimeBoardData,
	taskId: string,
	input: RuntimeUpdateTaskInput,
	now: number = Date.now(),
): RuntimeUpdateTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const prompt = input.prompt.trim();
	if (!prompt) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	let updatedTask: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== normalizedTaskId) {
				return card;
			}
			columnUpdated = true;
			updatedTask = {
				...card,
				title: resolveTaskTitle(input.title, prompt),
				prompt,
				startInPlanMode: Boolean(input.startInPlanMode),
				autoReviewEnabled: Boolean(input.autoReviewEnabled),
				autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
				images: input.images === undefined ? card.images : cloneTaskImages(input.images),
				agentId: input.agentId === undefined ? card.agentId : (input.agentId ?? undefined),
				clineSettings:
					input.clineSettings === undefined
						? cloneTaskClineSettings(card.clineSettings)
						: input.clineSettings === null
							? undefined
							: cloneTaskClineSettings(input.clineSettings),
				baseRef,
				updatedAt: now,
			};
			return updatedTask;
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updatedTask) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	return {
		board: {
			...board,
			columns,
		},
		task: updatedTask,
		updated: true,
	};
}
