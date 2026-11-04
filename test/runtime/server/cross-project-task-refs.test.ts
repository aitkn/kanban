import { describe, expect, it } from "vitest";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import {
	collectReferencedTasksByProjectId,
	resolveLiveTaskColumnId,
} from "../../../src/server/cross-project-task-refs";

function card(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: `Title of ${id}`,
		prompt: `Prompt for ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function board(cardsByColumn: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: cardsByColumn.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: cardsByColumn.in_progress ?? [] },
			{ id: "review", title: "Review", cards: cardsByColumn.review ?? [] },
			{ id: "trash", title: "Done", cards: cardsByColumn.trash ?? [] },
		],
		dependencies: [],
	};
}

function session(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "claude",
		workspacePath: null,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

// The web board waits on a card in each of db's four columns, plus two that are gone.
const webBoard = board({
	backlog: [
		card("wait1", {
			dependsOn: [
				{ taskId: "dbBack", projectId: "db" },
				{ taskId: "dbProg", projectId: "db" },
				{ taskId: "dbRevw", projectId: "db" },
				{ taskId: "dbDone", projectId: "db" },
				{ taskId: "dbGone", projectId: "db" },
				{ taskId: "x1234", projectId: "removed-project" },
				{ taskId: "local" },
			],
		}),
		card("local"),
	],
});

const dbBoard = board({
	backlog: [card("dbBack", { title: "Add the column" }), card("dbOther")],
	in_progress: [card("dbProg")],
	review: [card("dbRevw")],
	trash: [card("dbDone")],
});

describe("sked fork: cross-project task refs", () => {
	it("resolves each referenced task to its column and title, and only referenced tasks", () => {
		const result = collectReferencedTasksByProjectId([
			{ workspaceId: "web", board: webBoard },
			{ workspaceId: "db", board: dbBoard },
		]);

		expect(result.get("db")).toEqual([
			{ taskId: "dbBack", title: "Add the column", columnId: "backlog" },
			{ taskId: "dbProg", title: "Title of dbProg", columnId: "in_progress" },
			{ taskId: "dbRevw", title: "Title of dbRevw", columnId: "review" },
			{ taskId: "dbDone", title: "Title of dbDone", columnId: "trash" },
		]);
		// Same-board refs are not cross-project; nothing references web from elsewhere.
		expect(result.get("web")).toEqual([]);
	});

	it("leaves a deleted card and a removed project out, so the client shows them as deleted", () => {
		const result = collectReferencedTasksByProjectId([
			{ workspaceId: "web", board: webBoard },
			{ workspaceId: "db", board: dbBoard },
		]);

		expect(result.get("db")?.some((task) => task.taskId === "dbGone")).toBe(false);
		expect(result.has("removed-project")).toBe(false);
	});

	it("picks up a move on the other board", () => {
		const moved = board({ review: [card("dbBack", { title: "Add the column" })] });
		const result = collectReferencedTasksByProjectId([
			{ workspaceId: "web", board: webBoard },
			{ workspaceId: "db", board: moved },
		]);

		expect(result.get("db")).toEqual([{ taskId: "dbBack", title: "Add the column", columnId: "review" }]);
	});

	it("applies live session state the other project's board has not caught up with", () => {
		const result = collectReferencedTasksByProjectId([
			{ workspaceId: "web", board: webBoard },
			{
				workspaceId: "db",
				board: dbBoard,
				sessionsByTaskId: new Map([
					["dbProg", session("dbProg", "awaiting_review")],
					["dbRevw", session("dbRevw", "running")],
				]),
			},
		]);

		const columnByTaskId = new Map(result.get("db")?.map((task) => [task.taskId, task.columnId]));
		expect(columnByTaskId.get("dbProg")).toBe("review");
		expect(columnByTaskId.get("dbRevw")).toBe("in_progress");
	});

	it("resolves nothing for a project whose board was never read", () => {
		const result = collectReferencedTasksByProjectId([
			{ workspaceId: "web", board: webBoard },
			{ workspaceId: "db", board: null },
		]);

		expect(result.get("db")).toEqual([]);
	});

	it("ignores a ref whose projectId is the board's own project", () => {
		const selfRef = board({ backlog: [card("a", { dependsOn: [{ taskId: "b", projectId: "web" }] }), card("b")] });

		expect(collectReferencedTasksByProjectId([{ workspaceId: "web", board: selfRef }]).get("web")).toEqual([]);
	});

	it("moves a card for its session the way the board does", () => {
		expect(resolveLiveTaskColumnId("in_progress", undefined)).toBe("in_progress");
		expect(resolveLiveTaskColumnId("in_progress", session("t", "awaiting_review"))).toBe("review");
		expect(resolveLiveTaskColumnId("review", session("t", "running"))).toBe("in_progress");
		expect(resolveLiveTaskColumnId("review", session("t", "interrupted"))).toBe("trash");
		// A stale summary never pulls a backlog or done card anywhere.
		expect(resolveLiveTaskColumnId("backlog", session("t", "interrupted"))).toBe("backlog");
		expect(resolveLiveTaskColumnId("trash", session("t", "running"))).toBe("trash");
	});
});
