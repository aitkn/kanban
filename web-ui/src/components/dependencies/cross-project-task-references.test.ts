import { describe, expect, it } from "vitest";

import { resolveCrossProjectTaskReference } from "@/components/dependencies/cross-project-task-references";
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
