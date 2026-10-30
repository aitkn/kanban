import type {
	RuntimeHookEvent,
	RuntimeHookIngestResponse,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";
import {
	BackgroundWorkHolds,
	type BackgroundWorkHoldsOptions,
	type BackgroundWorkHoldTarget,
	formatBackgroundWorkActivity,
} from "./background-work-holds";

export interface CreateHooksApiDependencies {
	getWorkspacePathById: (workspaceId: string) => string | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	/** Looks a workspace's manager up without registering or loading it. */
	getTerminalManagerForWorkspace: (workspaceId: string) => TerminalSessionManager | null;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	deleteTaskTurnCheckpointRef?: (input: { cwd: string; ref: string }) => Promise<void>;
	backgroundWorkHolds?: Pick<
		BackgroundWorkHoldsOptions,
		"readTranscriptFrom" | "now" | "recheckIntervalMs" | "settleGraceMs"
	>;
}

function canTransitionTaskForHookEvent(summary: RuntimeTaskSessionSummary, event: RuntimeHookEvent): boolean {
	if (event === "activity") {
		return false;
	}
	if (event === "to_review") {
		return summary.state === "running";
	}
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

/** Keeps per-card background-work holds: create one per runtime, never one per request. */
export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;

	const captureReviewCheckpoint = async (
		manager: TerminalSessionManager,
		target: BackgroundWorkHoldTarget,
		reviewSummary: RuntimeTaskSessionSummary,
	): Promise<void> => {
		const nextTurn = (reviewSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
		const checkpointCwd = reviewSummary.workspacePath ?? target.workspacePath;
		const staleRef = reviewSummary.previousTurnCheckpoint?.ref ?? null;
		try {
			const checkpoint = await checkpointCapture({
				cwd: checkpointCwd,
				taskId: target.taskId,
				turn: nextTurn,
			});
			manager.applyTurnCheckpoint(target.taskId, checkpoint);
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
	};

	const applyTransition = async (
		manager: TerminalSessionManager,
		target: BackgroundWorkHoldTarget,
		event: RuntimeHookEvent,
		metadata: Partial<RuntimeTaskHookActivity> | undefined,
	): Promise<boolean> => {
		const transitionedSummary =
			event === "to_review"
				? manager.transitionToReview(target.taskId, "hook")
				: manager.transitionToRunning(target.taskId);
		if (!transitionedSummary) {
			return false;
		}
		if (event === "to_review") {
			await captureReviewCheckpoint(manager, target, transitionedSummary);
		}
		if (metadata) {
			manager.applyHookActivity(target.taskId, metadata);
		}
		void deps.broadcastRuntimeWorkspaceStateUpdated(target.workspaceId, target.workspacePath);
		if (event === "to_review") {
			deps.broadcastTaskReadyForReview(target.workspaceId, target.taskId);
		}
		return true;
	};

	const backgroundWorkHolds = new BackgroundWorkHolds({
		...deps.backgroundWorkHolds,
		// Re-checks only look managers up: a project removed while a card was held must stay removed,
		// and its session is gone with it.
		isSessionCurrent: async (target, pid) => {
			const summary = deps.getTerminalManagerForWorkspace(target.workspaceId)?.getSummary(target.taskId);
			return summary?.state === "running" && summary.pid === pid;
		},
		onProgress: (target, outstandingCount) => {
			deps.getTerminalManagerForWorkspace(target.workspaceId)?.applyHookActivity(target.taskId, {
				activityText: formatBackgroundWorkActivity(outstandingCount),
			});
		},
		onSettled: (target, reviewMetadata) => {
			const manager = deps.getTerminalManagerForWorkspace(target.workspaceId);
			const summary = manager?.getSummary(target.taskId);
			if (!manager || !summary || !canTransitionTaskForHookEvent(summary, "to_review")) {
				return;
			}
			void applyTransition(manager, target, "to_review", reviewMetadata).catch(() => {
				// Best effort, like every hook transition.
			});
		},
	});

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

				const target: BackgroundWorkHoldTarget = { workspaceId, workspacePath, taskId };
				let metadata = body.metadata;
				// sked fork: a turn that ended on outstanding background work stays In Progress.
				if (event === "to_review" && body.backgroundWork && summary.state === "running") {
					const holdResult = await backgroundWorkHolds.hold(target, body.backgroundWork, {
						pid: summary.pid,
						reviewMetadata: metadata,
					});
					if (holdResult === "held") {
						manager.applyHookActivity(taskId, {
							...metadata,
							activityText: formatBackgroundWorkActivity(body.backgroundWork.taskIds.length),
						});
					}
					if (holdResult !== "unavailable") {
						// "superseded": a later hook already decided the card; this Stop is stale.
						return { ok: true } satisfies RuntimeHookIngestResponse;
					}
				}
				if (
					event === "to_review" ||
					(event === "to_in_progress" && metadata?.hookEventName === "UserPromptSubmit")
				) {
					// The turn ended with nothing outstanding, the agent needs the user, or a new turn started.
					backgroundWorkHolds.release(target);
				} else if (metadata?.activityText && backgroundWorkHolds.isHeld(target)) {
					// Keep "Waiting on background job" while background subagents and idle notifications report in.
					const { activityText: _ignored, ...rest } = metadata;
					metadata = rest;
				}

				if (!canTransitionTaskForHookEvent(summary, event)) {
					if (metadata) {
						manager.applyHookActivity(taskId, metadata);
					}
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				const transitioned = await applyTransition(manager, target, event, metadata);
				if (!transitioned) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
