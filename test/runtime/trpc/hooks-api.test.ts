import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveHookApprovalSignal } from "../../../src/commands/hook-events/approval-hook-events";
import type {
	RuntimeHookEvent,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
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
			getTerminalManagerForWorkspace: vi.fn(() => manager),
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
			getTerminalManagerForWorkspace: vi.fn(() => manager),
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
			getTerminalManagerForWorkspace: vi.fn(() => manager),
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
			getTerminalManagerForWorkspace: vi.fn(() => manager),
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

	it("shows a background subagent's permission prompt on a card waiting on background work", async () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({ "task-1": createSummary() });
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			getTerminalManagerForWorkspace: vi.fn(() => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			captureTaskTurnCheckpoint: vi.fn(async () => ({ turn: 1, ref: "r", commit: "c", createdAt: 1 })),
			backgroundWorkHolds: { readTranscriptFrom: async () => ({ text: "", nextOffset: 0 }) },
		});
		const ingest = (event: RuntimeHookEvent, payload: Record<string, unknown>, activityText?: string) =>
			api.ingest({
				taskId: "task-1",
				workspaceId: "workspace-1",
				event,
				metadata: { hookEventName: String(payload.hook_event_name), source: "claude", activityText },
				...resolveHookApprovalSignal(event, payload),
			});

		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { hookEventName: "Stop", source: "claude" },
			backgroundWork: { taskIds: ["a1"], transcriptPath: "/t.jsonl" },
		});
		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.latestHookActivity?.activityText).toBe("Waiting on background job (1)");

		const request = {
			hook_event_name: "PermissionRequest",
			tool_name: "Bash",
			tool_input: { command: "npm publish" },
			agent_id: "a1",
		};
		await ingest("approval_requested", request, "Waiting for approval");
		expect(manager.getSummary("task-1")).toMatchObject({ state: "awaiting_review", reviewReason: "approval" });
		expect(manager.getSummary("task-1")?.latestHookActivity?.activityText).toBe("Waiting for approval");

		await ingest(
			"to_in_progress",
			{ ...request, hook_event_name: "PostToolUse", tool_use_id: "toolu_1" },
			"Completed Bash: npm publish",
		);
		expect(manager.getSummary("task-1")).toMatchObject({ state: "running", reviewReason: null });
		// The prompt ended the hold, so the card shows what the agent does next again.
		expect(manager.getSummary("task-1")?.latestHookActivity?.activityText).toBe("Completed Bash: npm publish");

		// Claude resumes for the finished subagent and ends the turn with nothing outstanding.
		await ingest("to_review", { hook_event_name: "Stop" });
		expect(manager.getSummary("task-1")).toMatchObject({ state: "awaiting_review", reviewReason: "hook" });
	});

	it("blocks on an MCP form that opens right after a prompt settled", async () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({ "task-1": createSummary() });
		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			getTerminalManagerForWorkspace: vi.fn(() => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint: vi.fn(),
		});
		const ingest = (event: RuntimeHookEvent, payload: Record<string, unknown>) =>
			api.ingest({
				taskId: "task-1",
				workspaceId: "workspace-1",
				event,
				metadata: { hookEventName: String(payload.hook_event_name), source: "claude" },
				...resolveHookApprovalSignal(event, payload),
			});
		const request = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } };

		await ingest("approval_requested", request);
		await ingest("to_in_progress", { ...request, hook_event_name: "PostToolUse", tool_use_id: "toolu_1" });
		expect(manager.getSummary("task-1")?.state).toBe("running");

		// Keyless like the Notification echo, but it is the form itself.
		await ingest("approval_requested", {
			hook_event_name: "Elicitation",
			mcp_server_name: "plugin:supabase:supabase",
		});
		expect(manager.getSummary("task-1")).toMatchObject({ state: "awaiting_review", reviewReason: "approval" });
		expect(broadcastTaskReadyForReview).toHaveBeenCalledTimes(2);
	});
});

describe("createHooksApi Claude Stop with background work", () => {
	const transcriptPath = "/home/user/.claude/projects/-repo/session.jsonl";
	let transcript: string;
	let summary: RuntimeTaskSessionSummary;
	let manager: TerminalSessionManager;
	let broadcastTaskReadyForReview: ReturnType<typeof vi.fn<(workspaceId: string, taskId: string) => void>>;
	let api: ReturnType<typeof createHooksApi>;
	let projectRegistered: boolean;
	let ensureTerminalManagerForWorkspace: ReturnType<
		typeof vi.fn<(workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>>
	>;

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
		projectRegistered = true;
		ensureTerminalManagerForWorkspace = vi.fn(async () => manager);
		api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace,
			getTerminalManagerForWorkspace: vi.fn(() => (projectRegistered ? manager : null)),
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

	it("does not move a resumed turn to review when the finished job's notification is in the transcript", async () => {
		await stop(["b1"]);
		// Claude records the completion and resumes for it right away.
		transcript += `${JSON.stringify({
			type: "queue-operation",
			operation: "enqueue",
			timestamp: new Date(Date.now()).toISOString(),
			content: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>",
		})}\n`;
		await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
			metadata: { source: "claude", hookEventName: "UserPromptSubmit", activityText: "Resumed after user input" },
		});

		// The resumed turn runs long; nothing may settle it to review behind its back.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(summary.state).toBe("running");
		expect(manager.transitionToReview).not.toHaveBeenCalled();
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

	it("drops the hold without reloading a project removed while the card was held", async () => {
		await stop(["b1"]);
		expect(ensureTerminalManagerForWorkspace).toHaveBeenCalledTimes(1);
		projectRegistered = false;
		transcript += `${JSON.stringify({
			type: "queue-operation",
			operation: "enqueue",
			timestamp: new Date(Date.now()).toISOString(),
			content: "<task-notification>\n<task-id>b1</task-id>\n<status>killed</status>\n</task-notification>",
		})}\n`;

		await vi.advanceTimersByTimeAsync(60_000);
		expect(ensureTerminalManagerForWorkspace).toHaveBeenCalledTimes(1);
		expect(manager.transitionToReview).not.toHaveBeenCalled();
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
