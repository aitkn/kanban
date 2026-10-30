import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildToolCallKey, resolveHookApprovalSignal } from "../../src/commands/hook-events/approval-hook-events";
import { appendHookDebugLog, HOOK_DEBUG_LOG_ENV } from "../../src/commands/hook-events/hook-debug-log";

describe("resolveHookApprovalSignal", () => {
	it("keys a tool call by name and input, independent of key order", () => {
		expect(buildToolCallKey("Bash", { command: "ls", description: "List" })).toBe(
			buildToolCallKey("Bash", { description: "List", command: "ls" }),
		);
		expect(buildToolCallKey("Bash", { command: "ls" })).not.toBe(buildToolCallKey("Bash", { command: "pwd" }));
		expect(buildToolCallKey("Bash", { command: "ls" })).not.toBe(buildToolCallKey("Read", { command: "ls" }));
	});

	it("reads the MCP server from PermissionRequest's mcp_server object", () => {
		const signal = resolveHookApprovalSignal("approval_requested", {
			hook_event_name: "PermissionRequest",
			tool_name: "mcp__plugin_supabase_supabase__apply_migration",
			tool_input: { name: "m1", query: "select 1" },
			mcp_server: { name: "plugin:supabase:supabase", source: "plugin" },
		});
		expect(signal.approval).toEqual({
			kind: "permission",
			toolName: "mcp__plugin_supabase_supabase__apply_migration",
			mcpServerName: "plugin:supabase:supabase",
			toolCallKey: buildToolCallKey("mcp__plugin_supabase_supabase__apply_migration", {
				name: "m1",
				query: "select 1",
			}),
		});
	});

	it("scopes every PostToolUse to its own call, even without a tool name", () => {
		expect(
			resolveHookApprovalSignal("to_in_progress", { hook_event_name: "PostToolUse" }).approvalResolution,
		).toEqual({ scope: "tool_call", toolCallKey: buildToolCallKey("unknown", undefined) });
	});

	it("resolves everything on UserPromptSubmit and leaves activity events alone", () => {
		expect(resolveHookApprovalSignal("to_in_progress", { hook_event_name: "UserPromptSubmit" })).toEqual({});
		expect(resolveHookApprovalSignal("activity", { hook_event_name: "PreToolUse", tool_name: "Bash" })).toEqual({});
	});
});

describe("appendHookDebugLog", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = null;
		}
	});

	it("appends one line per hook when the env var names a file, and nothing otherwise", () => {
		dir = mkdtempSync(join(tmpdir(), "kanban-hook-debug-"));
		const logPath = join(dir, "hooks.jsonl");
		const payload = {
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_use_id: "toolu_1",
			agent_id: "agent-1",
			tool_input: { command: "ls" },
		};
		appendHookDebugLog({ event: "to_in_progress", taskId: "task-1", payload, result: "ok" }, {});
		appendHookDebugLog(
			{ event: "to_in_progress", taskId: "task-1", payload, result: "error: timed out" },
			{ [HOOK_DEBUG_LOG_ENV]: logPath },
		);
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			taskId: "task-1",
			event: "to_in_progress",
			hookEventName: "PostToolUse",
			toolName: "Bash",
			toolUseId: "toolu_1",
			agentId: "agent-1",
			result: "error: timed out",
		});
	});
});
