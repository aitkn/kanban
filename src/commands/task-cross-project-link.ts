// sked fork: `kanban task link|unlink` for a prerequisite on another project's board. The ref lives
// only in the waiting card's `dependsOn`: it is display-only and never auto-starts anything.

import type { RuntimeTaskDependsOnRef } from "../core/api-contract";
import { formatProjectTaskRef, resolveProjectShortNames } from "../core/project-short-name";
import {
	addCrossProjectPrerequisite,
	type CrossProjectTaskRef,
	getTaskColumnId,
	type RuntimeCrossProjectLinkResult,
	type RuntimeCrossProjectUnlinkResult,
	removeCrossProjectPrerequisite,
} from "../core/task-board-mutations";
import { resolveProjectInputPath } from "../projects/project-path";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	mutateWorkspaceState,
	type RuntimeWorkspaceContext,
	type RuntimeWorkspaceIndexEntry,
} from "../state/workspace-state";

/** The other project, named by its path or by its workspace ID (as `task list` prints it). */
export type LinkedProjectSelector = { kind: "path"; path: string } | { kind: "id"; workspaceId: string };

export type TaskUnlinkTarget =
	| { kind: "dependency"; dependencyId: string }
	| { kind: "same_project"; taskId: string; linkedTaskId: string }
	| { kind: "cross_project"; taskId: string; linkedTaskId: string; linkedProject: LinkedProjectSelector };

export interface LinkedProjectOptions {
	linkedProjectPath?: string;
	linkedProjectId?: string;
}

export interface TaskUnlinkOptions extends LinkedProjectOptions {
	dependencyId?: string;
	taskId?: string;
	linkedTaskId?: string;
}

type JsonRecord = Record<string, unknown>;

interface CrossProjectCommandInput {
	cwd: string;
	projectPath?: string;
	taskId: string;
	linkedTaskId: string;
	linkedProject: LinkedProjectSelector;
	/** Called after the board was saved, to tell a running Kanban to reload it. */
	onSaved?: (workspaceId: string) => Promise<void>;
}

const UNLINK_USAGE =
	"task unlink takes either --dependency-id <id>, or --task-id <id> --linked-task-id <id> (adding --linked-project-path <path> or --linked-project-id <id> for a task on another project's board).";

function trimmed(value: string | undefined): string | undefined {
	const result = value?.trim();
	return result ? result : undefined;
}

/** Returns null when neither option was passed (a same-board link). */
export function parseLinkedProjectSelector(options: LinkedProjectOptions): LinkedProjectSelector | null {
	const path = trimmed(options.linkedProjectPath);
	const workspaceId = trimmed(options.linkedProjectId);
	if (path && workspaceId) {
		throw new Error("Pass only one of --linked-project-path or --linked-project-id.");
	}
	if (path) {
		return { kind: "path", path };
	}
	if (workspaceId) {
		return { kind: "id", workspaceId };
	}
	return null;
}

export function parseTaskUnlinkTarget(options: TaskUnlinkOptions): TaskUnlinkTarget {
	const dependencyId = trimmed(options.dependencyId);
	const taskId = trimmed(options.taskId);
	const linkedTaskId = trimmed(options.linkedTaskId);
	const linkedProject = parseLinkedProjectSelector(options);
	if (dependencyId) {
		if (taskId || linkedTaskId || linkedProject) {
			throw new Error(UNLINK_USAGE);
		}
		return { kind: "dependency", dependencyId };
	}
	if (!taskId || !linkedTaskId) {
		throw new Error(UNLINK_USAGE);
	}
	return linkedProject
		? { kind: "cross_project", taskId, linkedTaskId, linkedProject }
		: { kind: "same_project", taskId, linkedTaskId };
}

async function resolveCurrentProject(cwd: string, projectPath: string | undefined): Promise<RuntimeWorkspaceContext> {
	const path = trimmed(projectPath);
	return await loadWorkspaceContext(path ? resolveProjectInputPath(path, cwd) : cwd, {
		autoCreateIfMissing: false,
	});
}

async function resolveRegisteredProject(
	selector: LinkedProjectSelector,
	cwd: string,
	entries: RuntimeWorkspaceIndexEntry[],
): Promise<{ workspaceId: string; repoPath: string }> {
	if (selector.kind === "id") {
		const entry = entries.find((candidate) => candidate.workspaceId === selector.workspaceId);
		if (!entry) {
			throw new Error(`Linked project "${selector.workspaceId}" is not added to Kanban.`);
		}
		return entry;
	}
	try {
		const context = await loadWorkspaceContext(resolveProjectInputPath(selector.path, cwd), {
			autoCreateIfMissing: false,
		});
		return { workspaceId: context.workspaceId, repoPath: context.repoPath };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Linked project ${selector.path}: ${message}`);
	}
}

/**
 * Resolves the other project for an unlink. A workspace ID is taken as given, so a ref to a
 * project that was since removed from Kanban can still be removed.
 */
async function resolveUnlinkProject(
	selector: LinkedProjectSelector,
	cwd: string,
	entries: RuntimeWorkspaceIndexEntry[],
): Promise<{ workspaceId: string; repoPath: string | null }> {
	if (selector.kind === "id") {
		const entry = entries.find((candidate) => candidate.workspaceId === selector.workspaceId);
		return { workspaceId: selector.workspaceId, repoPath: entry?.repoPath ?? null };
	}
	return await resolveRegisteredProject(selector, cwd, entries);
}

function getLinkFailureMessage(
	reason: Extract<RuntimeCrossProjectLinkResult, { added: false }>["reason"],
	input: CrossProjectCommandInput,
	linkedProjectId: string,
): string {
	if (reason === "missing_task") {
		return `Task "${input.taskId}" was not found on this project's board.`;
	}
	if (reason === "trash_task") {
		return `Task "${input.taskId}" is done; a done task cannot wait on another.`;
	}
	return `Task "${input.taskId}" already depends on "${input.linkedTaskId}" in project "${linkedProjectId}".`;
}

function getUnlinkFailureMessage(
	reason: Extract<RuntimeCrossProjectUnlinkResult, { removed: false }>["reason"],
	input: CrossProjectCommandInput,
	linkedProjectId: string,
): string {
	if (reason === "missing_task") {
		return `Task "${input.taskId}" was not found on this project's board.`;
	}
	return `Task "${input.taskId}" does not depend on "${input.linkedTaskId}" in project "${linkedProjectId}".`;
}

function formatCrossProjectRef(
	ref: CrossProjectTaskRef,
	repoPath: string | null,
	entries: RuntimeWorkspaceIndexEntry[],
): JsonRecord {
	return {
		taskId: ref.taskId,
		projectId: ref.projectId,
		projectPath: repoPath,
		ref: formatProjectTaskRef(ref, resolveProjectShortNames(entries)),
	};
}

export async function linkCrossProjectTask(input: CrossProjectCommandInput): Promise<JsonRecord> {
	const current = await resolveCurrentProject(input.cwd, input.projectPath);
	const entries = await listWorkspaceIndexEntries();
	const linked = await resolveRegisteredProject(input.linkedProject, input.cwd, entries);
	if (linked.workspaceId === current.workspaceId) {
		throw new Error(
			"The linked project is this task's own project. Omit --linked-project-path/--linked-project-id to link two tasks on the same board.",
		);
	}
	const linkedColumn = getTaskColumnId(await loadWorkspaceBoardById(linked.workspaceId), input.linkedTaskId);
	if (!linkedColumn) {
		throw new Error(
			`Task "${input.linkedTaskId}" was not found in project "${linked.workspaceId}" (${linked.repoPath}).`,
		);
	}
	if (linkedColumn === "trash") {
		throw new Error(
			`Task "${input.linkedTaskId}" in project "${linked.workspaceId}" is done; links cannot include done tasks.`,
		);
	}

	const prerequisite: CrossProjectTaskRef = { taskId: input.linkedTaskId, projectId: linked.workspaceId };
	const mutation = await mutateWorkspaceState(current.repoPath, (state) => {
		const result = addCrossProjectPrerequisite(state.board, input.taskId, prerequisite);
		if (!result.added) {
			throw new Error(getLinkFailureMessage(result.reason, input, linked.workspaceId));
		}
		return { board: result.board, value: null };
	});
	if (mutation.saved) {
		await input.onSaved?.(current.workspaceId);
	}
	return {
		ok: true,
		workspacePath: current.repoPath,
		taskId: input.taskId,
		dependsOn: { ...formatCrossProjectRef(prerequisite, linked.repoPath, entries), column: linkedColumn },
	};
}

export async function unlinkCrossProjectTask(input: CrossProjectCommandInput): Promise<JsonRecord> {
	const current = await resolveCurrentProject(input.cwd, input.projectPath);
	const entries = await listWorkspaceIndexEntries();
	const linked = await resolveUnlinkProject(input.linkedProject, input.cwd, entries);
	const prerequisite: CrossProjectTaskRef = { taskId: input.linkedTaskId, projectId: linked.workspaceId };
	const mutation = await mutateWorkspaceState(current.repoPath, (state) => {
		const result = removeCrossProjectPrerequisite(state.board, input.taskId, prerequisite);
		if (!result.removed) {
			throw new Error(getUnlinkFailureMessage(result.reason, input, linked.workspaceId));
		}
		return { board: result.board, value: null };
	});
	if (mutation.saved) {
		await input.onSaved?.(current.workspaceId);
	}
	return {
		ok: true,
		workspacePath: current.repoPath,
		taskId: input.taskId,
		removedDependsOn: formatCrossProjectRef(prerequisite, linked.repoPath, entries),
	};
}

/** `task list` output for a card's `dependsOn`: each ref plus how it is displayed (`db#c64f9`). */
export function formatDependsOnRefs(
	dependsOn: readonly RuntimeTaskDependsOnRef[] | undefined,
	shortNames: ReadonlyMap<string, string>,
): JsonRecord[] {
	return (dependsOn ?? []).map((ref) => ({ ...ref, ref: formatProjectTaskRef(ref, shortNames) }));
}
