import type {
	RuntimeHookApprovalResolution,
	RuntimeTaskPendingApproval,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";

export type SessionTransitionEvent =
	| { type: "hook.to_review" }
	| { type: "hook.to_in_progress"; approvalResolution?: RuntimeHookApprovalResolution }
	| { type: "hook.approval_requested"; approval: RuntimeTaskPendingApproval }
	| { type: "agent.prompt-ready" }
	| { type: "process.exit"; exitCode: number | null; interrupted: boolean };

export interface SessionTransitionResult {
	changed: boolean;
	patch: Partial<RuntimeTaskSessionSummary>;
	clearAttentionBuffer: boolean;
}

const UNCHANGED: SessionTransitionResult = { changed: false, patch: {}, clearAttentionBuffer: false };

function canReturnToRunning(reason: RuntimeTaskSessionReviewReason): boolean {
	return reason === "attention" || reason === "hook" || reason === "error";
}

function asReviewState(reason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionSummary["state"] {
	if (reason === "interrupted") {
		return "interrupted";
	}
	return "awaiting_review";
}

function isWaitingForApproval(summary: RuntimeTaskSessionSummary): boolean {
	return summary.state === "awaiting_review" && summary.reviewReason === "approval";
}

// sked fork: the prompts a card in the "approval" review state is waiting on. Empty in any other state, so a
// stale list left behind by another code path is never read.
export function getPendingApprovals(summary: RuntimeTaskSessionSummary): RuntimeTaskPendingApproval[] {
	return isWaitingForApproval(summary) ? (summary.pendingApprovals ?? []) : [];
}

// Claude reports one permission prompt twice: PermissionRequest (with the tool call) and, if the prompt is
// still open six seconds later, a Notification without it. A keyless request folds into a pending prompt
// of the same kind; a keyed one replaces a keyless placeholder.
function addPendingApproval(
	pending: RuntimeTaskPendingApproval[],
	approval: RuntimeTaskPendingApproval,
): RuntimeTaskPendingApproval[] {
	const sameKind = pending.filter((entry) => entry.kind === approval.kind);
	if (approval.toolCallKey === null) {
		const isCovered = sameKind.some(
			(entry) =>
				approval.mcpServerName === null ||
				entry.mcpServerName === null ||
				entry.mcpServerName === approval.mcpServerName,
		);
		return isCovered ? pending : [...pending, approval];
	}
	if (sameKind.some((entry) => entry.toolCallKey === approval.toolCallKey)) {
		return pending;
	}
	const withoutPlaceholder = pending.filter((entry) => entry.kind !== approval.kind || entry.toolCallKey !== null);
	return [...withoutPlaceholder, approval];
}

// Undefined resolves everything (a new user prompt). Only hooks resolve a prompt: the keypress that answers
// one cannot tell "Yes" from "No", and a "No" fires no hook while Claude waits for the user to type.
function resolvePendingApprovals(
	pending: RuntimeTaskPendingApproval[],
	resolution: RuntimeHookApprovalResolution | undefined,
): RuntimeTaskPendingApproval[] {
	if (resolution === undefined) {
		return [];
	}
	if (resolution.scope === "tool_call") {
		return pending.filter((entry) => entry.toolCallKey !== resolution.toolCallKey);
	}
	return pending.filter(
		(entry) =>
			entry.kind !== "elicitation" ||
			(entry.mcpServerName !== null &&
				resolution.mcpServerName !== null &&
				entry.mcpServerName !== resolution.mcpServerName),
	);
}

function settlePendingApprovals(
	summary: RuntimeTaskSessionSummary,
	remaining: RuntimeTaskPendingApproval[],
): SessionTransitionResult {
	if (remaining.length === getPendingApprovals(summary).length) {
		return UNCHANGED;
	}
	if (remaining.length > 0) {
		return { changed: true, patch: { pendingApprovals: remaining }, clearAttentionBuffer: false };
	}
	return {
		changed: true,
		patch: { state: "running", reviewReason: null, pendingApprovals: [] },
		clearAttentionBuffer: true,
	};
}

function reduceReturnToRunning(summary: RuntimeTaskSessionSummary): SessionTransitionResult {
	if (summary.state !== "awaiting_review" || !canReturnToRunning(summary.reviewReason)) {
		return UNCHANGED;
	}
	return {
		changed: true,
		patch: {
			state: "running",
			reviewReason: null,
		},
		clearAttentionBuffer: true,
	};
}

export function reduceSessionTransition(
	summary: RuntimeTaskSessionSummary,
	event: SessionTransitionEvent,
): SessionTransitionResult {
	switch (event.type) {
		case "hook.to_review": {
			// A turn that ended is no longer waiting on any prompt.
			if (summary.state !== "running" && !isWaitingForApproval(summary)) {
				return UNCHANGED;
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "hook",
					pendingApprovals: [],
				},
				clearAttentionBuffer: true,
			};
		}
		case "hook.approval_requested": {
			// Being blocked on the user outranks "done, review the diff", so a review card can still get here.
			const canWait =
				summary.state === "running" ||
				(summary.state === "awaiting_review" &&
					(canReturnToRunning(summary.reviewReason) || summary.reviewReason === "approval"));
			if (!canWait) {
				return UNCHANGED;
			}
			const pending = getPendingApprovals(summary);
			const next = addPendingApproval(pending, event.approval);
			if (next === pending) {
				return UNCHANGED;
			}
			return {
				changed: true,
				patch: {
					state: "awaiting_review",
					reviewReason: "approval",
					pendingApprovals: next,
				},
				clearAttentionBuffer: summary.state === "running",
			};
		}
		case "hook.to_in_progress": {
			if (isWaitingForApproval(summary)) {
				return settlePendingApprovals(
					summary,
					resolvePendingApprovals(getPendingApprovals(summary), event.approvalResolution),
				);
			}
			return reduceReturnToRunning(summary);
		}
		case "agent.prompt-ready": {
			return reduceReturnToRunning(summary);
		}
		case "process.exit": {
			let reason: RuntimeTaskSessionReviewReason = event.exitCode === 0 ? "exit" : "error";
			if (event.interrupted) {
				reason = "interrupted";
			}
			return {
				changed: true,
				patch: {
					state: asReviewState(reason),
					reviewReason: reason,
					exitCode: event.exitCode,
					pid: null,
					pendingApprovals: [],
				},
				clearAttentionBuffer: false,
			};
		}
		default: {
			return UNCHANGED;
		}
	}
}
