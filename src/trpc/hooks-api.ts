import type {
	RuntimeHookEvent,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeTaskPendingApproval,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { getPendingApprovals } from "../terminal/session-state-machine";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateHooksApiDependencies {
	getWorkspacePathById: (workspaceId: string) => string | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastTaskReadyForReview: (
		workspaceId: string,
		taskId: string,
		pendingApproval?: RuntimeTaskPendingApproval | null,
	) => void;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	deleteTaskTurnCheckpointRef?: (input: { cwd: string; ref: string }) => Promise<void>;
}

function canTransitionTaskForHookEvent(summary: RuntimeTaskSessionSummary, event: RuntimeHookEvent): boolean {
	if (event === "activity") {
		return false;
	}
	if (event === "to_review") {
		return summary.state === "running" || isWaitingForApproval(summary);
	}
	if (event === "approval_requested") {
		return summary.state === "running" || summary.state === "awaiting_review";
	}
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" ||
			summary.reviewReason === "hook" ||
			summary.reviewReason === "error" ||
			summary.reviewReason === "approval")
	);
}

function isWaitingForApproval(summary: RuntimeTaskSessionSummary): boolean {
	return summary.state === "awaiting_review" && summary.reviewReason === "approval";
}

// sked fork: an approval request without a structured payload (an older hook command) still blocks the card.
function resolveRequestedApproval(body: RuntimeHookIngestRequest): RuntimeTaskPendingApproval {
	if (body.approval) {
		return body.approval;
	}
	const isElicitation =
		body.metadata?.hookEventName === "Elicitation" || body.metadata?.notificationType === "elicitation_dialog";
	return {
		kind: isElicitation ? "elicitation" : "permission",
		toolName: isElicitation ? null : (body.metadata?.toolName ?? null),
		mcpServerName: null,
		toolCallKey: null,
	};
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;

	return {
		ingest: async (input) => {
			try {
				const body = parseHookIngestRequest(input);
				const taskId = body.taskId;
				const workspaceId = body.workspaceId;
				const event = body.event;
				const knownWorkspacePath = deps.getWorkspacePathById(workspaceId);
				const workspaceContext = knownWorkspacePath ? null : await loadWorkspaceContextById(workspaceId);
				const workspacePath = knownWorkspacePath ?? workspaceContext?.repoPath ?? null;
				if (!workspacePath) {
					return {
						ok: false,
						error: `Workspace "${workspaceId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
				const summary = manager.getSummary(taskId);
				if (!summary) {
					return {
						ok: false,
						error: `Task "${taskId}" not found in workspace "${workspaceId}"`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (!canTransitionTaskForHookEvent(summary, event)) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				if (event === "approval_requested") {
					const approvalSummary = manager.requestApproval(taskId, resolveRequestedApproval(body));
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
					// Notify once per wait: Claude's follow-up Notification for the same prompt changes nothing.
					const pendingApprovals = approvalSummary ? getPendingApprovals(approvalSummary) : [];
					if (pendingApprovals.length > getPendingApprovals(summary).length) {
						deps.broadcastTaskReadyForReview(workspaceId, taskId, pendingApprovals.at(-1) ?? null);
					}
					return { ok: true } satisfies RuntimeHookIngestResponse;
				}

				const transitionedSummary =
					event === "to_review"
						? manager.transitionToReview(taskId, "hook")
						: manager.transitionToRunning(taskId, body.approvalResolution);
				if (!transitionedSummary) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (event === "to_review") {
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.workspacePath ?? workspacePath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					try {
						const checkpoint = await checkpointCapture({
							cwd: checkpointCwd,
							taskId,
							turn: nextTurn,
						});
						manager.applyTurnCheckpoint(taskId, checkpoint);
						if (staleRef) {
							void checkpointRefDelete({
								cwd: checkpointCwd,
								ref: staleRef,
							}).catch(() => {
								// Best effort cleanup only.
							});
						}
					} catch {
						// Best effort checkpointing only.
					}
				}

				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				if (event === "to_review") {
					deps.broadcastTaskReadyForReview(workspaceId, taskId);
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
