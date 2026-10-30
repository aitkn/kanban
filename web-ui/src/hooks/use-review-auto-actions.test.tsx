import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { resetWorkspaceMetadataStore, setTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardColumnId, BoardData, ReviewTaskWorkspaceSnapshot } from "@/types";

function createBoard(autoReviewEnabled: boolean): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Test task",
						prompt: "Test task",
						startInPlanMode: false,
						autoReviewEnabled,
						autoReviewMode: "commit",
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

const workspaceSnapshots: Record<string, ReviewTaskWorkspaceSnapshot> = {
	"task-1": {
		taskId: "task-1",
		path: "/tmp/task-1",
		branch: "task-1",
		isDetached: false,
		headCommit: "abc123",
		changedFiles: 3,
		additions: 10,
		deletions: 2,
	},
};

function createReviewSession(reviewReason: RuntimeTaskSessionSummary["reviewReason"]): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/tmp/task-1",
		pid: 123,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason,
		exitCode: null,
		lastHookAt: 2,
		latestHookActivity: null,
		pendingApprovals:
			reviewReason === "approval"
				? [{ kind: "elicitation", toolName: null, mcpServerName: "supabase", toolCallKey: null }]
				: [],
	};
}

function HookHarness({
	board,
	sessions = {},
	changedFiles,
	runAutoReviewGitAction,
	requestMoveTaskToTrash,
}: {
	board: BoardData;
	sessions?: Record<string, RuntimeTaskSessionSummary>;
	changedFiles?: number;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	requestMoveTaskToTrash: (taskId: string, fromColumnId: BoardColumnId) => Promise<void>;
}): null {
	const snapshot = workspaceSnapshots["task-1"];
	setTaskWorkspaceSnapshot(
		snapshot && changedFiles !== undefined ? { ...snapshot, changedFiles } : (snapshot ?? null),
	);
	useReviewAutoActions({
		board,
		sessions,
		taskGitActionLoadingByTaskId: {},
		runAutoReviewGitAction,
		requestMoveTaskToTrash,
	});
	return null;
}

describe("useReviewAutoActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		resetWorkspaceMetadataStore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("cancels a scheduled auto review action when autoReviewEnabled is turned off", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(false)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("never commits a review card whose agent is waiting for the user's approval", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					sessions={{ "task-1": createReviewSession("approval") }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	it("cancels a scheduled commit when the card starts waiting for approval", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});
		const board = createBoard(true);

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					sessions={{ "task-1": createReviewSession("hook") }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					sessions={{ "task-1": createReviewSession("approval") }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
	});

	it("commits once the turn that waited for approval finishes", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});
		const board = createBoard(true);

		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					sessions={{ "task-1": createReviewSession("approval") }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			root.render(
				<HookHarness
					board={board}
					sessions={{ "task-1": createReviewSession("hook") }}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).toHaveBeenCalledWith("task-1", "commit");
	});

	it("does not move a committed card to done while its agent waits for approval", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});
		const board = createBoard(true);
		const render = async (reviewReason: RuntimeTaskSessionSummary["reviewReason"], changedFiles: number) => {
			await act(async () => {
				root.render(
					<HookHarness
						board={board}
						sessions={{ "task-1": createReviewSession(reviewReason) }}
						changedFiles={changedFiles}
						runAutoReviewGitAction={runAutoReviewGitAction}
						requestMoveTaskToTrash={requestMoveTaskToTrash}
					/>,
				);
			});
			await act(async () => {
				vi.advanceTimersByTime(1000);
			});
		};

		// The commit fires and arms the move to done.
		await render("hook", 3);
		expect(runAutoReviewGitAction).toHaveBeenCalledWith("task-1", "commit");
		// The agent committed, then asked for approval (for example to push): the tree is clean but the card waits.
		await render("approval", 0);
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
		// Once the turn ends, the armed move goes ahead.
		await render("hook", 0);
		expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-1", "review", { skipWorkingChangeWarning: true });
	});
});
