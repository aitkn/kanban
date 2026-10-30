// sked fork: a card whose agent is blocked on the user (a permission prompt or an MCP elicitation form) is in
// the Review column for a different reason than a finished turn, and must say so.
import type { RuntimeTaskPendingApproval, RuntimeTaskSessionSummary } from "@/runtime/types";

export const WAITING_FOR_APPROVAL_TEXT = "Waiting for your approval";

export function isSessionWaitingForApproval(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	return summary?.state === "awaiting_review" && summary.reviewReason === "approval";
}

export function getFirstPendingApproval(
	summary: RuntimeTaskSessionSummary | null | undefined,
): RuntimeTaskPendingApproval | null {
	if (!isSessionWaitingForApproval(summary)) {
		return null;
	}
	return summary?.pendingApprovals?.[0] ?? null;
}

// "mcp__plugin_supabase_supabase__apply_migration" -> { server: "plugin_supabase_supabase", tool: "apply_migration" }
function splitMcpToolName(toolName: string): { server: string; tool: string } | null {
	if (!toolName.startsWith("mcp__")) {
		return null;
	}
	const rest = toolName.slice("mcp__".length);
	const separator = rest.lastIndexOf("__");
	if (separator <= 0) {
		return null;
	}
	return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

export function describePendingApprovalSubject(approval: RuntimeTaskPendingApproval | null): string | null {
	if (!approval) {
		return null;
	}
	const mcpTool = approval.toolName ? splitMcpToolName(approval.toolName) : null;
	const serverName = approval.mcpServerName ?? mcpTool?.server ?? null;
	if (mcpTool) {
		return `${mcpTool.tool} (MCP ${serverName})`;
	}
	if (approval.toolName) {
		return approval.toolName;
	}
	return serverName ? `MCP ${serverName}` : null;
}

export function describeWaitingForApproval(approval: RuntimeTaskPendingApproval | null): string {
	const subject = describePendingApprovalSubject(approval);
	return subject ? `${WAITING_FOR_APPROVAL_TEXT}: ${subject}` : WAITING_FOR_APPROVAL_TEXT;
}
