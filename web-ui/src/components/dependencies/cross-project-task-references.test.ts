import { describe, expect, it } from "vitest";

import {
	resolveCrossProjectDependents,
	resolveCrossProjectTaskReference,
} from "@/components/dependencies/cross-project-task-references";
import type { RuntimeProjectSummary } from "@/runtime/types";

function project(overrides: Partial<RuntimeProjectSummary> & { id: string }): RuntimeProjectSummary {
	return {
		path: `/repos/${overrides.id}`,
		name: overrides.id,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
		...overrides,
	};
}

const projects = [
	project({
		id: "skedai-db",
		shortName: "db",
		referencedTasks: [{ taskId: "c64f9", title: "Add the column", columnId: "review" }],
	}),
	// A summary from a runtime that predates short names and referenced tasks.
	project({ id: "legacy" }),
];

describe("resolveCrossProjectTaskReference (sked fork)", () => {
	it("resolves a referenced task to its column, title and short-name label", () => {
		expect(resolveCrossProjectTaskReference(projects, "skedai-db", "c64f9")).toEqual({
			projectId: "skedai-db",
			taskId: "c64f9",
			label: "db#c64f9",
			projectName: "skedai-db",
			task: { title: "Add the column", columnId: "review", columnTitle: "Review" },
		});
	});

	it("reports a card the server did not find as deleted", () => {
		expect(resolveCrossProjectTaskReference(projects, "skedai-db", "gone1")).toMatchObject({
			label: "db#gone1",
			projectName: "skedai-db",
			task: null,
		});
	});

	it("reports a ref into a removed project as deleted, labelled with the project ID", () => {
		expect(resolveCrossProjectTaskReference(projects, "removed", "x1234")).toEqual({
			projectId: "removed",
			taskId: "x1234",
			label: "removed#x1234",
			projectName: null,
			task: null,
		});
	});

	it("falls back to the project ID without a short name, and to deleted without referenced tasks", () => {
		expect(resolveCrossProjectTaskReference(projects, "legacy", "a1b2c")).toMatchObject({
			label: "legacy#a1b2c",
			task: null,
		});
	});
});

describe("resolveCrossProjectDependents (sked fork)", () => {
	const withDependents = [
		project({
			id: "skedai-web",
			shortName: "web",
			dependentTasks: [
				{
					taskId: "pre1",
					dependentProjectId: "skedai-db",
					dependentTaskId: "dbW1",
					title: "Db waits",
					columnId: "backlog",
				},
				{
					taskId: "other",
					dependentProjectId: "skedai-db",
					dependentTaskId: "dbW2",
					title: "Not this",
					columnId: "review",
				},
				{
					taskId: "pre1",
					dependentProjectId: "legacy",
					dependentTaskId: "lgW1",
					title: "Legacy waits",
					columnId: "trash",
				},
			],
		}),
		...projects,
	];

	it("lists the other boards' cards waiting on a task of the current project, labelled and coloured", () => {
		expect(resolveCrossProjectDependents(withDependents, "skedai-web", "pre1")).toEqual([
			{
				projectId: "skedai-db",
				taskId: "dbW1",
				label: "db#dbW1",
				projectName: "skedai-db",
				task: { title: "Db waits", columnId: "backlog", columnTitle: "Backlog" },
			},
			{
				projectId: "legacy",
				taskId: "lgW1",
				label: "legacy#lgW1",
				projectName: "legacy",
				task: { title: "Legacy waits", columnId: "trash", columnTitle: "Done" },
			},
		]);
	});

	it("resolves a dependent nobody references from the dependentTasks naming it, so its chip can open it", () => {
		expect(resolveCrossProjectTaskReference(withDependents, "skedai-db", "dbW1")).toEqual({
			projectId: "skedai-db",
			taskId: "dbW1",
			label: "db#dbW1",
			projectName: "skedai-db",
			task: { title: "Db waits", columnId: "backlog", columnTitle: "Backlog" },
		});
		expect(resolveCrossProjectTaskReference(withDependents, "skedai-db", "unknown").task).toBeNull();
	});

	it("lists nothing for another project's summary, a task nobody waits on, or a runtime without dependents", () => {
		expect(resolveCrossProjectDependents(withDependents, "skedai-db", "pre1")).toEqual([]);
		expect(resolveCrossProjectDependents(withDependents, "skedai-web", "nobody")).toEqual([]);
		expect(resolveCrossProjectDependents(withDependents, null, "pre1")).toEqual([]);
		expect(resolveCrossProjectDependents(projects, "legacy", "pre1")).toEqual([]);
	});
});
