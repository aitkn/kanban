import { describe, expect, it, vi } from "vitest";

import { resolveHookApprovalSignal } from "../../../src/commands/hook-events/approval-hook-events";
import type { RuntimeHookEvent, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
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

	it("waits for approval through the real session manager and notifies once per prompt", async () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({ "task-1": createSummary() });
		const broadcastTaskReadyForReview = vi.fn();
		const captureTaskTurnCheckpoint = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint,
		});
		const ingest = (event: RuntimeHookEvent, payload: Record<string, unknown>) =>
			api.ingest({
				taskId: "task-1",
				workspaceId: "workspace-1",
				event,
				metadata: { hookEventName: String(payload.hook_event_name), source: "claude" },
				...resolveHookApprovalSignal(event, payload),
			});
		const request = {
			hook_event_name: "PermissionRequest",
			tool_name: "Bash",
			tool_input: { command: "npm publish" },
		};

		expect(await ingest("approval_requested", request)).toEqual({ ok: true });
		expect(manager.getSummary("task-1")).toMatchObject({ state: "awaiting_review", reviewReason: "approval" });
		expect(broadcastTaskReadyForReview).toHaveBeenCalledTimes(1);
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith(
			"workspace-1",
			"task-1",
			expect.objectContaining({ kind: "permission", toolName: "Bash" }),
		);
		// Waiting is not a finished turn: no diff checkpoint.
		expect(captureTaskTurnCheckpoint).not.toHaveBeenCalled();

		await ingest("approval_requested", { hook_event_name: "Notification", notification_type: "permission_prompt" });
		expect(broadcastTaskReadyForReview).toHaveBeenCalledTimes(1);

		await ingest("to_in_progress", {
			hook_event_name: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/tmp/a" },
			agent_id: "subagent-1",
		});
		expect(manager.getSummary("task-1")?.reviewReason).toBe("approval");

		await ingest("to_in_progress", { ...request, hook_event_name: "PostToolUse", tool_use_id: "toolu_1" });
		expect(manager.getSummary("task-1")).toMatchObject({ state: "running", reviewReason: null });

		// The answered prompt's own Notification, landing just after the answer, does not block the card again.
		await ingest("approval_requested", { hook_event_name: "Notification", notification_type: "permission_prompt" });
		expect(manager.getSummary("task-1")?.state).toBe("running");
		// A new prompt does.
		await ingest("approval_requested", { ...request, tool_input: { command: "npm publish --tag next" } });
		expect(manager.getSummary("task-1")?.reviewReason).toBe("approval");
		expect(broadcastTaskReadyForReview).toHaveBeenCalledTimes(2);
	});
});
