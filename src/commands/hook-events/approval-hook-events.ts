// sked fork: turns Claude hook payloads into "waiting for your approval" signals.
//
// Verified against Claude Code 2.1.314 payloads:
// - PermissionRequest carries tool_name, tool_input and mcp_server, but no tool_use_id. A prompt is therefore
//   matched to its PostToolUse by tool name plus a hash of the tool input.
// - Elicitation and ElicitationResult carry mcp_server_name and no tool fields. ElicitationResult fires for
//   accept, decline and cancel.
// - Notification permission_prompt / elicitation_dialog carry neither; they fire ~6s after the prompt opens
//   and only if it is still open.
import { createHash } from "node:crypto";
import type {
	RuntimeHookApprovalResolution,
	RuntimeHookEvent,
	RuntimeTaskPendingApproval,
} from "../../core/api-contract";
import { asRecord, readNestedString, readStringField } from "./hook-utils";

export interface HookApprovalSignal {
	approval?: RuntimeTaskPendingApproval;
	approvalResolution?: RuntimeHookApprovalResolution;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const record = asRecord(value);
	if (record) {
		const entries = Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

export function buildToolCallKey(toolName: string, toolInput: unknown): string {
	const digest = createHash("sha256").update(stableStringify(toolInput)).digest("hex").slice(0, 16);
	return `${toolName}:${digest}`;
}

export function readHookEventName(payload: Record<string, unknown>): string | null {
	return (
		readStringField(payload, "hook_event_name") ??
		readStringField(payload, "hookEventName") ??
		readStringField(payload, "hookName")
	);
}

// PreToolUse and PermissionRequest send mcp_server as { name, source }; the elicitation events send
// mcp_server_name.
export function readMcpServerName(payload: Record<string, unknown>): string | null {
	return readStringField(payload, "mcp_server_name") ?? readNestedString(payload, ["mcp_server", "name"]);
}

function readToolCallKey(payload: Record<string, unknown>): string | null {
	const toolName = readStringField(payload, "tool_name");
	return toolName ? buildToolCallKey(toolName, payload.tool_input) : null;
}

export function resolveHookApprovalSignal(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
): HookApprovalSignal {
	if (!payload) {
		return {};
	}
	const hookEventName = readHookEventName(payload);
	if (event === "approval_requested") {
		const notificationType = readStringField(payload, "notification_type");
		const isElicitation = hookEventName === "Elicitation" || notificationType === "elicitation_dialog";
		return {
			approval: {
				kind: isElicitation ? "elicitation" : "permission",
				toolName: readStringField(payload, "tool_name"),
				mcpServerName: readMcpServerName(payload),
				toolCallKey: readToolCallKey(payload),
			},
		};
	}
	if (event !== "to_in_progress") {
		return {};
	}
	if (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") {
		// Always scoped: an unrelated tool finishing must never release a pending prompt.
		const toolName = readStringField(payload, "tool_name") ?? "unknown";
		return {
			approvalResolution: { scope: "tool_call", toolCallKey: buildToolCallKey(toolName, payload.tool_input) },
		};
	}
	if (hookEventName === "ElicitationResult") {
		return { approvalResolution: { scope: "elicitation", mcpServerName: readMcpServerName(payload) } };
	}
	return {};
}
