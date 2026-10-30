// sked fork: KANBAN_HOOK_DEBUG_LOG=<file> appends one JSON line per hook the CLI ingests: the raw event
// identity, what Kanban derived from it, and whether the runtime accepted it. Hook failures are otherwise
// swallowed so they never block the agent, which leaves no trace of a card that missed a transition.
import { appendFileSync } from "node:fs";
import type {
	RuntimeHookApprovalResolution,
	RuntimeHookEvent,
	RuntimeTaskPendingApproval,
} from "../../core/api-contract";
import { readHookEventName, readMcpServerName } from "./approval-hook-events";
import { readStringField } from "./hook-utils";

export const HOOK_DEBUG_LOG_ENV = "KANBAN_HOOK_DEBUG_LOG";

export interface HookDebugLogInput {
	event: RuntimeHookEvent;
	taskId: string | null;
	payload: Record<string, unknown> | null;
	approval?: RuntimeTaskPendingApproval;
	approvalResolution?: RuntimeHookApprovalResolution;
	result: string;
}

export function appendHookDebugLog(input: HookDebugLogInput, env: NodeJS.ProcessEnv = process.env): void {
	const logPath = env[HOOK_DEBUG_LOG_ENV]?.trim();
	if (!logPath) {
		return;
	}
	const payload = input.payload;
	const line = {
		at: new Date().toISOString(),
		taskId: input.taskId,
		event: input.event,
		hookEventName: payload ? readHookEventName(payload) : null,
		notificationType: payload ? readStringField(payload, "notification_type") : null,
		toolName: payload ? readStringField(payload, "tool_name") : null,
		toolUseId: payload ? readStringField(payload, "tool_use_id") : null,
		agentId: payload ? readStringField(payload, "agent_id") : null,
		permissionMode: payload ? readStringField(payload, "permission_mode") : null,
		mcpServerName: payload ? readMcpServerName(payload) : null,
		approval: input.approval ?? null,
		approvalResolution: input.approvalResolution ?? null,
		result: input.result,
	};
	try {
		appendFileSync(logPath, `${JSON.stringify(line)}\n`);
	} catch {
		// Debug logging must never affect the hook.
	}
}
