import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createHooksApi } from "../../../src/trpc/hooks-api";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

describe("createHooksApi", () => {
	it("treats ineligible hook transitions as successful no-ops", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
	});

	it("stores activity metadata without changing session state", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: {
				source: "claude",
				activityText: "Using Read",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", {
			source: "claude",
			activityText: "Using Read",
		});
	});

	it("captures a turn checkpoint when transitioning to review", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			latestTurnCheckpoint: {
				turn: 2,
				ref: "refs/kanban/checkpoints/task-1/turn/2",
				commit: "2222222",
				createdAt: 1,
			},
			previousTurnCheckpoint: {
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			},
		});

		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const captureTaskTurnCheckpoint = vi.fn(async () => ({
			turn: 3,
			ref: "refs/kanban/checkpoints/task-1/turn/3",
			commit: "3333333",
			createdAt: Date.now(),
		}));
		const deleteTaskTurnCheckpointRef = vi.fn(async () => undefined);

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: true });
		expect(captureTaskTurnCheckpoint).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			turn: 3,
		});
		expect(manager.applyTurnCheckpoint).toHaveBeenCalledTimes(1);
		expect(deleteTaskTurnCheckpointRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			ref: "refs/kanban/checkpoints/task-1/turn/1",
		});
	});
});

describe("createHooksApi Claude Stop with background work", () => {
	const transcriptPath = "/home/user/.claude/projects/-repo/session.jsonl";
	let transcript: string;
	let summary: RuntimeTaskSessionSummary;
	let manager: TerminalSessionManager;
	let broadcastTaskReadyForReview: ReturnType<typeof vi.fn<(workspaceId: string, taskId: string) => void>>;
	let api: ReturnType<typeof createHooksApi>;

	beforeEach(() => {
		vi.useFakeTimers();
		transcript = '{"type":"user","message":{"role":"user","content":"start"}}\n';
		summary = createSummary({ state: "running" });
		// A manager whose state follows the transitions, so a sequence of hooks can be replayed.
		manager = {
			getSummary: vi.fn(() => summary),
			transitionToReview: vi.fn(() => {
				summary = { ...summary, state: "awaiting_review", reviewReason: "hook" };
				return summary;
			}),
			transitionToRunning: vi.fn(() => {
				summary = { ...summary, state: "running", reviewReason: null };
				return summary;
			}),
			applyHookActivity: vi.fn((_taskId: string, activity: Partial<RuntimeTaskHookActivity>) => {
				summary = {
					...summary,
					latestHookActivity: {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: null,
						notificationType: null,
						source: null,
						...summary.latestHookActivity,
						...activity,
					},
				};
				return summary;
			}),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;
		broadcastTaskReadyForReview = vi.fn<(workspaceId: string, taskId: string) => void>();
		api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint: vi.fn(async () => ({ turn: 1, ref: "r", commit: "c", createdAt: 1 })),
			backgroundWorkHolds: {
				readTranscriptFrom: async (_path, offset) => ({
					text: transcript.slice(Math.min(offset, transcript.length)),
					nextOffset: transcript.length,
				}),
				recheckIntervalMs: 15_000,
				settleGraceMs: 10_000,
			},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const stop = (taskIds: string[]) =>
		api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop", activityText: "Final: Started it." },
			...(taskIds.length > 0 ? { backgroundWork: { taskIds, transcriptPath } } : {}),
		});

	it("keeps the card running while background work is outstanding", async () => {
		expect(await stop(["b1", "a2"])).toEqual({ ok: true });

		expect(summary.state).toBe("running");
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(broadcastTaskReadyForReview).not.toHaveBeenCalled();
		expect(summary.latestHookActivity?.activityText).toBe("Waiting on background job (2)");
	});

	it("moves to review when the turn ends with nothing outstanding", async () => {
		await stop([]);
		expect(summary.state).toBe("awaiting_review");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledTimes(1);
	});

	it("moves to review once the agent resumes for the finished job and stops with nothing outstanding", async () => {
		await stop(["b1"]);
		// A background subagent reporting in does not replace the waiting text or move the card.
		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "PostToolUse", activityText: "Completed Bash: ls" },
		});
		expect(summary.latestHookActivity?.activityText).toBe("Waiting on background job (1)");

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit", activityText: "Resumed after user input" },
		});
		expect(summary.state).toBe("running");
		expect(summary.latestHookActivity?.activityText).toBe("Resumed after user input");

		await stop([]);
		expect(summary.state).toBe("awaiting_review");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledTimes(1);
	});

	it("moves to review when the job ends and the agent never resumes", async () => {
		await stop(["b1"]);
		// The user stops the job from /tasks 10s later: Claude records it, but starts no turn.
		transcript += `${JSON.stringify({
			type: "queue-operation",
			operation: "enqueue",
			timestamp: new Date(Date.now() + 10_000).toISOString(),
			content: "<task-notification>\n<task-id>b1</task-id>\n<status>killed</status>\n</task-notification>",
		})}\n`;

		await vi.advanceTimersByTimeAsync(15_000);
		expect(summary.state).toBe("running");

		await vi.advanceTimersByTimeAsync(15_000);
		expect(summary.state).toBe("awaiting_review");
		expect(summary.latestHookActivity?.activityText).toBe("Final: Started it.");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledTimes(1);
	});

	it("falls back to review when the work cannot be re-checked", async () => {
		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "claude", hookEventName: "Stop" },
			backgroundWork: { taskIds: ["b1"], transcriptPath: null },
		});
		expect(summary.state).toBe("awaiting_review");
	});
});
