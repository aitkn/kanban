// sked fork: `kanban project list|short-name`. A project's short name is how a prerequisite on its
// board is shown from another project (`db#c64f9`). Reads and writes the project registry directly,
// so it works without a running Kanban.

import type { Command } from "commander";

import { resolveProjectShortNames } from "../core/project-short-name";
import { resolveProjectInputPath } from "../projects/project-path";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	type RuntimeWorkspaceIndexEntry,
	setWorkspaceShortName,
} from "../state/workspace-state";
import { notifyRuntimeWorkspaceById } from "./task";

type JsonRecord = Record<string, unknown>;

export interface ProjectShortNameOptions {
	projectPath?: string;
	projectId?: string;
	set?: string;
	clear?: boolean;
}

function formatProject(entry: RuntimeWorkspaceIndexEntry, shortNames: ReadonlyMap<string, string>): JsonRecord {
	return {
		id: entry.workspaceId,
		path: entry.repoPath,
		// What the user set, or null when the derived default is used.
		shortName: entry.shortName ?? null,
		// What references to this project's tasks show.
		displayShortName: shortNames.get(entry.workspaceId) ?? entry.workspaceId,
	};
}

export async function listProjects(): Promise<JsonRecord> {
	const entries = await listWorkspaceIndexEntries();
	const shortNames = resolveProjectShortNames(entries);
	return { ok: true, projects: entries.map((entry) => formatProject(entry, shortNames)) };
}

async function resolveProjectId(options: ProjectShortNameOptions, cwd: string): Promise<string> {
	const projectId = options.projectId?.trim();
	const projectPath = options.projectPath?.trim();
	if (projectId && projectPath) {
		throw new Error("Pass only one of --project-path or --project-id.");
	}
	if (projectId) {
		return projectId;
	}
	const context = await loadWorkspaceContext(projectPath ? resolveProjectInputPath(projectPath, cwd) : cwd, {
		autoCreateIfMissing: false,
	});
	return context.workspaceId;
}

export async function setProjectShortName(
	options: ProjectShortNameOptions,
	cwd: string,
	// sked fork: a running Kanban rebroadcasts the project summaries, so open boards relabel their chips.
	onSaved?: (workspaceId: string) => Promise<void>,
): Promise<JsonRecord> {
	const shortName = options.set?.trim();
	if ((shortName === undefined) === (options.clear !== true)) {
		throw new Error("Pass exactly one of --set <name> or --clear.");
	}
	const workspaceId = await resolveProjectId(options, cwd);
	await setWorkspaceShortName(workspaceId, shortName ?? null);
	await onSaved?.(workspaceId);
	const entries = await listWorkspaceIndexEntries();
	const entry = entries.find((candidate) => candidate.workspaceId === workspaceId);
	if (!entry) {
		throw new Error(`Project "${workspaceId}" was removed from Kanban while its short name was being set.`);
	}
	return { ok: true, project: formatProject(entry, resolveProjectShortNames(entries)) };
}

async function runProjectCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		process.stdout.write(`${JSON.stringify(await handler(), null, 2)}\n`);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
		);
		process.exitCode = 1;
	}
}

export function registerProjectCommand(program: Command): void {
	const project = program
		.command("project")
		.alias("projects")
		.description("Inspect Kanban projects and set the short names used for cross-project task references.");

	project
		.command("list")
		.description("List the projects added to Kanban, with their IDs and short names.")
		.action(async () => {
			await runProjectCommand(listProjects);
		});

	project
		.command("short-name")
		.description("Set or clear the short name a project's tasks are shown with from other projects (db#c64f9).")
		.option("--project-path <path>", "Project path. Defaults to the current directory's project.")
		.option("--project-id <id>", "Project ID, instead of --project-path.")
		.option("--set <name>", "Short name: lowercase letters, digits, '-' and '_'; unique across projects.")
		.option("--clear", "Remove the short name and go back to the default.")
		.addHelpText(
			"after",
			[
				"",
				"Default short name: the project ID without the prefix (ending in '-' or '_') that",
				"every project ID shares, when there are two or more projects; otherwise, or when",
				"the result would be empty or taken, the full ID. A set name equal to the ID of a",
				"project added later stops being used, and its project shows its full ID instead.",
				"",
			].join("\n"),
		)
		.action(async (options: ProjectShortNameOptions) => {
			await runProjectCommand(
				async () => await setProjectShortName(options, process.cwd(), notifyRuntimeWorkspaceById),
			);
		});
}
