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
 * share `sked`, which ends at no separator, so nothing is removed. A prefix takes at least two
 * projects: a lone project keeps its full ID, so its name does not change when a second is added.
 */
export function getSharedProjectIdPrefix(workspaceIds: readonly string[]): string {
	if (workspaceIds.length < 2) {
		return "";
	}
	const prefix = longestCommonPrefix(workspaceIds);
	for (let index = prefix.length - 1; index >= 0; index -= 1) {
		if (SEPARATORS.has(prefix[index] ?? "")) {
			return prefix.slice(0, index + 1);
		}
	}
	return "";
}

function countBy(values: Iterable<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) {
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return counts;
}

/**
 * The short name each project is displayed with; no two projects get the same one. A name the
 * user set wins, otherwise the workspace ID minus the shared prefix. Either falls back to the
 * project's full workspace ID when it is empty, shared with another project's name, or another
 * project's workspace ID. That last case arises when a project is added whose ID equals a short
 * name set earlier: IDs cannot change, so the set name gives way.
 */
export function resolveProjectShortNames(projects: readonly ProjectShortNameSource[]): Map<string, string> {
	const workspaceIds = new Set(projects.map((project) => project.workspaceId));
	const prefix = getSharedProjectIdPrefix([...workspaceIds]);
	const isAnotherProjectsId = (name: string, workspaceId: string) => name !== workspaceId && workspaceIds.has(name);

	const explicitCounts = countBy(projects.flatMap((project) => (project.shortName ? [project.shortName] : [])));
	const derivedByWorkspaceId = new Map(
		projects.flatMap((project) =>
			project.shortName ? [] : [[project.workspaceId, project.workspaceId.slice(prefix.length)] as const],
		),
	);
	const derivedCounts = countBy(derivedByWorkspaceId.values());

	const resolved = new Map<string, string>();
	for (const project of projects) {
		const { workspaceId, shortName } = project;
		const candidate = shortName ?? derivedByWorkspaceId.get(workspaceId) ?? "";
		const unique = shortName
			? explicitCounts.get(shortName) === 1
			: derivedCounts.get(candidate) === 1 && !explicitCounts.has(candidate);
		const usable = candidate.length > 0 && unique && !isAnotherProjectsId(candidate, workspaceId);
		resolved.set(workspaceId, usable ? candidate : workspaceId);
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
