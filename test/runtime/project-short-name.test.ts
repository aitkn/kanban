import { describe, expect, it } from "vitest";

import {
	formatProjectTaskRef,
	getSharedProjectIdPrefix,
	PROJECT_SHORT_NAME_MAX_LENGTH,
	resolveProjectShortNames,
	validateProjectShortName,
} from "../../src/core/project-short-name";

// The project IDs registered on the Sked AI machine when short names were added.
const SKED_PROJECT_IDS = ["sked-ai", "skedai-web", "skedai-db", "skedai-android", "skedai-llm", "xtil", "aitkn-kanban"];

function resolve(projects: Array<{ workspaceId: string; shortName?: string }>): Record<string, string> {
	return Object.fromEntries(resolveProjectShortNames(projects));
}

describe("sked fork: project short names", () => {
	describe("default derivation", () => {
		it("keeps the full IDs for the real project list, which shares no prefix", () => {
			expect(getSharedProjectIdPrefix(SKED_PROJECT_IDS)).toBe("");
			expect(resolve(SKED_PROJECT_IDS.map((workspaceId) => ({ workspaceId })))).toEqual(
				Object.fromEntries(SKED_PROJECT_IDS.map((id) => [id, id])),
			);
		});

		it("keeps the full IDs for the skedai projects alone with sked-ai, whose shared prefix 'sked' ends at no separator", () => {
			const ids = ["sked-ai", "skedai-web", "skedai-db", "skedai-android", "skedai-llm"];
			expect(getSharedProjectIdPrefix(ids)).toBe("");
			expect(resolve(ids.map((workspaceId) => ({ workspaceId })))).toEqual(
				Object.fromEntries(ids.map((id) => [id, id])),
			);
		});

		it("removes a shared prefix that ends at a separator", () => {
			const ids = ["skedai-web", "skedai-db", "skedai-android", "skedai-llm"];
			expect(getSharedProjectIdPrefix(ids)).toBe("skedai-");
			expect(resolve(ids.map((workspaceId) => ({ workspaceId })))).toEqual({
				"skedai-web": "web",
				"skedai-db": "db",
				"skedai-android": "android",
				"skedai-llm": "llm",
			});
		});

		it("cuts the shared prefix back to its last separator", () => {
			// The common prefix is "skedai-w"; only "skedai-" is removed.
			expect(getSharedProjectIdPrefix(["skedai-web", "skedai-www"])).toBe("skedai-");
			expect(resolve([{ workspaceId: "skedai-web" }, { workspaceId: "skedai-www" }])).toEqual({
				"skedai-web": "web",
				"skedai-www": "www",
			});
		});

		it("treats '_' as a separator", () => {
			expect(resolve([{ workspaceId: "acme_api" }, { workspaceId: "acme_ui" }])).toEqual({
				acme_api: "api",
				acme_ui: "ui",
			});
		});

		it("removes only the part up to the last separator when one ID is a prefix of another", () => {
			expect(resolve([{ workspaceId: "a-b" }, { workspaceId: "a-b-c" }])).toEqual({ "a-b": "b", "a-b-c": "b-c" });
			expect(resolve([{ workspaceId: "skedai" }, { workspaceId: "skedai-web" }])).toEqual({
				skedai: "skedai",
				"skedai-web": "skedai-web",
			});
		});

		it("falls back to the full ID when removing the prefix leaves nothing", () => {
			expect(resolve([{ workspaceId: "acme-" }, { workspaceId: "acme-web" }])).toEqual({
				"acme-": "acme-",
				"acme-web": "web",
			});
		});

		it("returns nothing for no projects", () => {
			expect(resolve([])).toEqual({});
		});

		it("keeps a lone project's full ID, so adding a second project does not rename it", () => {
			expect(getSharedProjectIdPrefix(["skedai-web"])).toBe("");
			expect(resolve([{ workspaceId: "skedai-web" }])).toEqual({ "skedai-web": "skedai-web" });
		});
	});

	describe("set short names", () => {
		it("uses a set short name and derives the rest from the shared prefix", () => {
			expect(
				resolve(
					SKED_PROJECT_IDS.map((workspaceId) =>
						workspaceId === "skedai-db" ? { workspaceId, shortName: "db" } : { workspaceId },
					),
				),
			).toMatchObject({ "skedai-db": "db", "skedai-web": "skedai-web", "sked-ai": "sked-ai" });
		});

		it("falls back to the full ID when a derived default is another project's set short name", () => {
			expect(
				resolve([
					{ workspaceId: "skedai-web" },
					{ workspaceId: "skedai-db" },
					{ workspaceId: "skedai-llm", shortName: "web" },
				]),
			).toEqual({ "skedai-web": "skedai-web", "skedai-db": "db", "skedai-llm": "web" });
		});

		it("gives a set short name up to a project added later whose ID equals it", () => {
			// Project "web" was registered after "skedai-db" was named "web".
			expect(
				resolve([{ workspaceId: "skedai-db", shortName: "web" }, { workspaceId: "web" }, { workspaceId: "xtil" }]),
			).toEqual({ "skedai-db": "skedai-db", web: "web", xtil: "xtil" });
		});

		it("never derives another project's ID", () => {
			// Prefix "p-": "p-p-a" would derive "p-a", which is another project's ID.
			expect(
				resolve([{ workspaceId: "p-a" }, { workspaceId: "p-p-a" }, { workspaceId: "p-z", shortName: "a" }]),
			).toEqual({ "p-a": "p-a", "p-p-a": "p-p-a", "p-z": "a" });
		});

		it("never shows two projects under one name", () => {
			const cases = [
				[{ workspaceId: "skedai-db", shortName: "web" }, { workspaceId: "web" }],
				[{ workspaceId: "p-a" }, { workspaceId: "p-p-a" }, { workspaceId: "p-z", shortName: "a" }],
				[{ workspaceId: "a-b" }, { workspaceId: "a-c", shortName: "b" }, { workspaceId: "b" }],
				[{ workspaceId: "x-1", shortName: "x-2" }, { workspaceId: "x-2" }, { workspaceId: "x-3", shortName: "2" }],
			];
			for (const projects of cases) {
				const names = [...resolveProjectShortNames(projects).values()];
				expect(new Set(names).size).toBe(names.length);
			}
		});

		it("falls back to the full IDs when two projects carry the same set short name", () => {
			expect(
				resolve([
					{ workspaceId: "sked-ai", shortName: "x" },
					{ workspaceId: "xtil", shortName: "x" },
				]),
			).toEqual({ "sked-ai": "sked-ai", xtil: "xtil" });
		});
	});

	describe("validation", () => {
		it("accepts lowercase letters, digits, '-' and '_'", () => {
			for (const name of ["db", "web", "a1", "sked-ai", "sked_ai", "9"]) {
				expect(validateProjectShortName(name)).toBeNull();
			}
		});

		it("rejects empty, too long, upper-case, '#', spaces and a leading separator", () => {
			for (const name of ["", "x".repeat(PROJECT_SHORT_NAME_MAX_LENGTH + 1), "DB", "db#1", "my db", "-db", "_db"]) {
				expect(validateProjectShortName(name)).not.toBeNull();
			}
			expect(validateProjectShortName("x".repeat(PROJECT_SHORT_NAME_MAX_LENGTH))).toBeNull();
		});
	});

	describe("formatProjectTaskRef", () => {
		const shortNames = new Map([
			["skedai-db", "db"],
			["skedai-web", "web"],
		]);

		it("shows only the task ID for a task on the same board", () => {
			expect(formatProjectTaskRef({ taskId: "c64f9" }, shortNames)).toBe("c64f9");
		});

		it("prefixes the project's short name for a task on another board", () => {
			expect(formatProjectTaskRef({ taskId: "c64f9", projectId: "skedai-db" }, shortNames)).toBe("db#c64f9");
		});

		it("shows the project ID for a project that is no longer registered", () => {
			expect(formatProjectTaskRef({ taskId: "c64f9", projectId: "gone" }, shortNames)).toBe("gone#c64f9");
		});
	});
});
