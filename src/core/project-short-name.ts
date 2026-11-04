// sked fork: short project names, used to display a prerequisite on another project's board
// as `<shortName>#<taskId>`. Shared by the runtime, the CLI and the web UI.

export const PROJECT_SHORT_NAME_MAX_LENGTH = 32;

const PROJECT_SHORT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const SEPARATORS = new Set(["-", "_"]);

export interface ProjectShortNameSource {
	workspaceId: string;
	/** Set by the user; absent means "use the derived default". */
	shortName?: string;
}

export interface ProjectTaskRef {
	taskId: string;
	/** Absent for a task on the same board. */
	projectId?: string;
}

/** Returns an error message, or null when `shortName` is a valid short name. */
export function validateProjectShortName(shortName: string): string | null {
	if (shortName.length === 0) {
		return "A short name cannot be empty.";
	}
	if (shortName.length > PROJECT_SHORT_NAME_MAX_LENGTH) {
		return `A short name can be at most ${PROJECT_SHORT_NAME_MAX_LENGTH} characters.`;
	}
	if (!PROJECT_SHORT_NAME_PATTERN.test(shortName)) {
		return "A short name may contain only lowercase letters, digits, '-' and '_', and must start with a letter or digit.";
	}
	return null;
}

function longestCommonPrefix(values: readonly string[]): string {
	const [first, ...rest] = values;
	if (first === undefined) {
		return "";
	}
	let length = first.length;
	for (const value of rest) {
		let index = 0;
		while (index < length && index < value.length && value[index] === first[index]) {
			index += 1;
		}
		length = index;
	}
	return first.slice(0, length);
}

/**
 * The longest prefix shared by every ID that ends with a separator, so it is removed only at a
 * word boundary: `skedai-web` and `skedai-db` share `skedai-`, while `sked-ai` and `skedai-web`
 * share `sked`, which ends at no separator, so nothing is removed.
 */
export function getSharedProjectIdPrefix(workspaceIds: readonly string[]): string {
	const prefix = longestCommonPrefix(workspaceIds);
	for (let index = prefix.length - 1; index >= 0; index -= 1) {
		if (SEPARATORS.has(prefix[index] ?? "")) {
			return prefix.slice(0, index + 1);
		}
	}
	return "";
}

/**
 * The short name each project is displayed with. A name the user set wins. Otherwise the
 * workspace ID minus the shared prefix; when that is empty, or taken by another project, the
 * full workspace ID. Two projects carrying the same set name (a hand-edited index) both fall
 * back to their workspace IDs.
 */
export function resolveProjectShortNames(projects: readonly ProjectShortNameSource[]): Map<string, string> {
	const prefix = getSharedProjectIdPrefix(projects.map((project) => project.workspaceId));
	const countByExplicitName = new Map<string, number>();
	for (const project of projects) {
		if (project.shortName) {
			countByExplicitName.set(project.shortName, (countByExplicitName.get(project.shortName) ?? 0) + 1);
		}
	}
	const derivedByWorkspaceId = new Map<string, string>();
	const countByDerivedName = new Map<string, number>();
	for (const project of projects) {
		if (project.shortName) {
			continue;
		}
		const derived = project.workspaceId.slice(prefix.length);
		derivedByWorkspaceId.set(project.workspaceId, derived);
		countByDerivedName.set(derived, (countByDerivedName.get(derived) ?? 0) + 1);
	}

	const resolved = new Map<string, string>();
	for (const project of projects) {
		if (project.shortName) {
			const unique = countByExplicitName.get(project.shortName) === 1;
			resolved.set(project.workspaceId, unique ? project.shortName : project.workspaceId);
			continue;
		}
		const derived = derivedByWorkspaceId.get(project.workspaceId) ?? "";
		const usable = derived.length > 0 && countByDerivedName.get(derived) === 1 && !countByExplicitName.has(derived);
		resolved.set(project.workspaceId, usable ? derived : project.workspaceId);
	}
	return resolved;
}

/**
 * `<taskId>` for a task on the same board, `<shortName>#<taskId>` for a task on another
 * project's board. A project missing from `shortNames` (removed from Kanban) shows its ID.
 */
export function formatProjectTaskRef(ref: ProjectTaskRef, shortNames: ReadonlyMap<string, string>): string {
	if (ref.projectId === undefined) {
		return ref.taskId;
	}
	return `${shortNames.get(ref.projectId) ?? ref.projectId}#${ref.taskId}`;
}
