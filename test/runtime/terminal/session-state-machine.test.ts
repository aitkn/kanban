import { describe, expect, it } from "vitest";
import { resolveHookApprovalSignal } from "../../../src/commands/hook-events/approval-hook-events";
import type { RuntimeHookEvent, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	getPendingApprovals,
	reduceSessionTransition,
	type SessionTransitionEvent,
} from "../../../src/terminal/session-state-machine";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/task-1",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function apply(summary: RuntimeTaskSessionSummary, event: SessionTransitionEvent): RuntimeTaskSessionSummary {
	const result = reduceSessionTransition(summary, event);
	return result.changed ? { ...summary, ...result.patch } : summary;
}

// Mirrors the hook CLI: the Claude hook payload plus the event the generated settings map it to.
function hookEvent(event: RuntimeHookEvent, payload: Record<string, unknown>): SessionTransitionEvent {
	const signal = resolveHookApprovalSignal(event, payload);
	if (event === "approval_requested") {
		if (!signal.approval) {
			throw new Error("approval_requested without an approval");
		}
		return { type: "hook.approval_requested", approval: signal.approval };
	}
	if (event === "to_review") {
		return { type: "hook.to_review" };
	}
	return { type: "hook.to_in_progress", approvalResolution: signal.approvalResolution };
}

// Payload shapes recorded from Claude Code 2.1.314 (session/transcript fields omitted).
const peekInput = {};
const permissionRequestPeek = {
	hook_event_name: "PermissionRequest",
	tool_name: "mcp__probe__peek",
	tool_input: peekInput,
	mcp_server: { name: "probe", source: "dynamic" },
	permission_suggestions: [],
};
const permissionPromptNotification = {
	hook_event_name: "Notification",
	notification_type: "permission_prompt",
	message: "Claude needs your permission",
};
const postToolUsePeek = {
	hook_event_name: "PostToolUse",
	tool_name: "mcp__probe__peek",
	tool_input: peekInput,
	tool_use_id: "toolu_014oP1SAVXhVDoxi3TmxHpnz",
	mcp_server: { name: "probe", source: "dynamic" },
};
const postToolUseSlowOp = {
	hook_event_name: "PostToolUse",
	tool_name: "mcp__probe__slow_op",
	tool_input: { seconds: 8 },
	tool_use_id: "toolu_01Ej4cSrW4qWfTPtEENyhHCo",
	mcp_server: { name: "probe", source: "dynamic" },
};
const subagentPostToolUseBash = {
	hook_event_name: "PostToolUse",
	tool_name: "Bash",
	tool_input: { command: "sleep 2", description: "Wait" },
	tool_use_id: "toolu_01SubagentBash",
	agent_id: "a1b2c3",
};
const elicitation = {
	hook_event_name: "Elicitation",
	mcp_server_name: "plugin:supabase:supabase",
	message: "Confirm change",
	mode: "form",
	requested_schema: { type: "object", properties: { confirm: { type: "boolean" } } },
};
const elicitationDialogNotification = {
	hook_event_name: "Notification",
	notification_type: "elicitation_dialog",
	message: "Claude Code needs your input",
};
const elicitationResult = {
	hook_event_name: "ElicitationResult",
	mcp_server_name: "plugin:supabase:supabase",
	mode: "form",
	action: "accept",
	content: { confirm: true },
};
const userPromptSubmit = { hook_event_name: "UserPromptSubmit", prompt: "go on" };
const stop = { hook_event_name: "Stop", stop_hook_active: false };

function waitingForPeek(): RuntimeTaskSessionSummary {
	return apply(createSummary(), hookEvent("approval_requested", permissionRequestPeek));
}

function waitingForElicitation(): RuntimeTaskSessionSummary {
	return apply(createSummary(), hookEvent("approval_requested", elicitation));
}

describe("session state machine: waiting for approval", () => {
	it("moves a running card to the approval review state on PermissionRequest", () => {
		const summary = waitingForPeek();
		expect(summary.state).toBe("awaiting_review");
		expect(summary.reviewReason).toBe("approval");
		expect(getPendingApprovals(summary)).toEqual([
			expect.objectContaining({ kind: "permission", toolName: "mcp__probe__peek", mcpServerName: "probe" }),
		]);
	});

	it("stays waiting when an unrelated parallel tool finishes", () => {
		const summary = waitingForPeek();
		const result = reduceSessionTransition(summary, hookEvent("to_in_progress", postToolUseSlowOp));
		expect(result.changed).toBe(false);
	});

	it("stays waiting when a subagent's tool finishes", () => {
		const summary = waitingForPeek();
		expect(reduceSessionTransition(summary, hookEvent("to_in_progress", subagentPostToolUseBash)).changed).toBe(
			false,
		);
	});

	it("returns to running when the tool call that asked finishes", () => {
		const summary = apply(waitingForPeek(), hookEvent("to_in_progress", postToolUsePeek));
		expect(summary.state).toBe("running");
		expect(summary.reviewReason).toBeNull();
		expect(summary.pendingApprovals).toEqual([]);
	});

	it("returns to running when the same call fails (PostToolUseFailure)", () => {
		const failure = { ...postToolUsePeek, hook_event_name: "PostToolUseFailure", error: "boom" };
		expect(apply(waitingForPeek(), hookEvent("to_in_progress", failure)).state).toBe("running");
	});

	it("does not stack the delayed permission_prompt Notification on its PermissionRequest", () => {
		const summary = waitingForPeek();
		const result = reduceSessionTransition(summary, hookEvent("approval_requested", permissionPromptNotification));
		expect(result.changed).toBe(false);
	});

	it("still blocks on a permission_prompt Notification that arrives alone", () => {
		const summary = apply(createSummary(), hookEvent("approval_requested", permissionPromptNotification));
		expect(summary.reviewReason).toBe("approval");
		// Keyless, so a later PermissionRequest replaces it rather than adding a second prompt.
		const upgraded = apply(summary, hookEvent("approval_requested", permissionRequestPeek));
		expect(getPendingApprovals(upgraded)).toHaveLength(1);
		expect(getPendingApprovals(upgraded)[0]?.toolName).toBe("mcp__probe__peek");
	});

	it("waits for every open prompt, not just the first one answered", () => {
		const otherRequest = {
			...permissionRequestPeek,
			tool_name: "Bash",
			tool_input: { command: "rm -rf build" },
			mcp_server: undefined,
		};
		const otherPost = { ...otherRequest, hook_event_name: "PostToolUse", tool_use_id: "toolu_bash" };
		let summary = apply(waitingForPeek(), hookEvent("approval_requested", otherRequest));
		expect(getPendingApprovals(summary)).toHaveLength(2);
		summary = apply(summary, hookEvent("to_in_progress", postToolUsePeek));
		expect(summary.reviewReason).toBe("approval");
		expect(getPendingApprovals(summary)).toHaveLength(1);
		summary = apply(summary, hookEvent("to_in_progress", otherPost));
		expect(summary.state).toBe("running");
	});

	it("treats the same tool with different input as a different call", () => {
		const sameToolOtherInput = { ...postToolUsePeek, tool_input: { verbose: true } };
		expect(reduceSessionTransition(waitingForPeek(), hookEvent("to_in_progress", sameToolOtherInput)).changed).toBe(
			false,
		);
	});

	it("returns to running on UserPromptSubmit (a prompt after a denial)", () => {
		expect(apply(waitingForPeek(), hookEvent("to_in_progress", userPromptSubmit)).state).toBe("running");
	});

	it("becomes a normal review when the turn stops", () => {
		const summary = apply(waitingForPeek(), hookEvent("to_review", stop));
		expect(summary.state).toBe("awaiting_review");
		expect(summary.reviewReason).toBe("hook");
		expect(getPendingApprovals(summary)).toEqual([]);
	});

	it("outranks a finished turn: a review card can start waiting for approval", () => {
		const reviewCard = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		expect(apply(reviewCard, hookEvent("approval_requested", permissionRequestPeek)).reviewReason).toBe("approval");
	});

	it("does not wait on a card whose process exited", () => {
		const exited = createSummary({ state: "awaiting_review", reviewReason: "exit", pid: null });
		expect(reduceSessionTransition(exited, hookEvent("approval_requested", permissionRequestPeek)).changed).toBe(
			false,
		);
	});

	it("clears the prompts when the process exits", () => {
		const summary = apply(waitingForPeek(), { type: "process.exit", exitCode: 0, interrupted: false });
		expect(summary.reviewReason).toBe("exit");
		expect(summary.pendingApprovals).toEqual([]);
	});
});

describe("session state machine: MCP elicitation", () => {
	it("moves a running card to the approval review state on Elicitation", () => {
		const summary = waitingForElicitation();
		expect(summary.state).toBe("awaiting_review");
		expect(summary.reviewReason).toBe("approval");
		expect(getPendingApprovals(summary)).toEqual([
			{ kind: "elicitation", toolName: null, mcpServerName: "plugin:supabase:supabase", toolCallKey: null },
		]);
	});

	it("blocks on an elicitation_dialog Notification alone (Kanban missed the Elicitation hook)", () => {
		const summary = apply(createSummary(), hookEvent("approval_requested", elicitationDialogNotification));
		expect(summary.reviewReason).toBe("approval");
		expect(apply(summary, hookEvent("to_in_progress", elicitationResult)).state).toBe("running");
	});

	it("does not stack the delayed elicitation_dialog Notification on its Elicitation", () => {
		const result = reduceSessionTransition(
			waitingForElicitation(),
			hookEvent("approval_requested", elicitationDialogNotification),
		);
		expect(result.changed).toBe(false);
	});

	it("returns to running on ElicitationResult", () => {
		const summary = apply(waitingForElicitation(), hookEvent("to_in_progress", elicitationResult));
		expect(summary.state).toBe("running");
		expect(summary.reviewReason).toBeNull();
	});

	it("returns to running on a cancelled elicitation", () => {
		const cancelled = { ...elicitationResult, action: "cancel", content: undefined };
		expect(apply(waitingForElicitation(), hookEvent("to_in_progress", cancelled)).state).toBe("running");
	});

	it("stays waiting when an unrelated tool finishes or another server's form resolves", () => {
		const summary = waitingForElicitation();
		expect(reduceSessionTransition(summary, hookEvent("to_in_progress", subagentPostToolUseBash)).changed).toBe(
			false,
		);
		const otherServer = { ...elicitationResult, mcp_server_name: "probe" };
		expect(reduceSessionTransition(summary, hookEvent("to_in_progress", otherServer)).changed).toBe(false);
	});

	it("waits for both when an approved tool opens a form, and releases after the tool finishes", () => {
		const applyMigration = {
			...permissionRequestPeek,
			tool_name: "mcp__plugin_supabase_supabase__apply_migration",
			tool_input: { name: "add_index", query: "create index ..." },
			mcp_server: { name: "plugin:supabase:supabase", source: "plugin" },
		};
		let summary = apply(createSummary(), hookEvent("approval_requested", applyMigration));
		summary = apply(summary, hookEvent("approval_requested", elicitation));
		expect(getPendingApprovals(summary).map((entry) => entry.kind)).toEqual(["permission", "elicitation"]);
		summary = apply(summary, hookEvent("to_in_progress", elicitationResult));
		expect(summary.reviewReason).toBe("approval");
		summary = apply(summary, hookEvent("to_in_progress", { ...applyMigration, hook_event_name: "PostToolUse" }));
		expect(summary.state).toBe("running");
	});
});

describe("session state machine: existing review transitions", () => {
	it("still returns a finished-turn review card to running on PostToolUse", () => {
		const reviewCard = createSummary({ state: "awaiting_review", reviewReason: "hook" });
		expect(apply(reviewCard, hookEvent("to_in_progress", postToolUseSlowOp)).state).toBe("running");
	});
});
