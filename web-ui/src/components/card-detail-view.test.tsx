import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CardDetailView } from "@/components/card-detail-view";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

const { mockAgentTerminalPanel, mockGetChangesQuery, mockIsMobile } = vi.hoisted(() => ({
	mockAgentTerminalPanel: vi.fn((_props: { panelBackgroundColor?: string; terminalBackgroundColor?: string }) => null),
	mockGetChangesQuery: vi.fn(async () => ({ files: [] })),
	mockIsMobile: vi.fn(() => false),
}));

vi.mock("react-hotkeys-hook", () => ({
	useHotkeys: () => {},
}));

vi.mock("@/hooks/use-is-mobile", () => ({
	useIsMobile: () => mockIsMobile(),
}));

vi.mock("@/components/detail-panels/agent-terminal-panel", () => ({
	AgentTerminalPanel: mockAgentTerminalPanel,
}));

vi.mock("@/components/detail-panels/cline-agent-chat-panel", () => ({
	ClineAgentChatPanel: () => <div data-testid="cline-agent-chat-panel" />,
}));

vi.mock("@/components/detail-panels/column-context-panel", () => ({
	ColumnContextPanel: () => <div data-testid="column-context-panel" />,
}));

vi.mock("@/resize/resizable-bottom-pane", () => ({
	ResizableBottomPane: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// sked fork: the detail view must never load the task's diff, so getChanges is spied on at the client.
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: { getChanges: { query: mockGetChangesQuery } },
	}),
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutResetEffect: () => {},
}));

function createCard(id: string): BoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Task ${id}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createSelection(): CardSelection {
	const card = createCard("task-1");
	const columns: BoardColumn[] = [
		{
			id: "backlog",
			title: "Backlog",
			cards: [card],
		},
		{
			id: "in_progress",
			title: "In Progress",
			cards: [],
		},
		{
			id: "review",
			title: "Review",
			cards: [],
		},
		{
			id: "trash",
			title: "Done",
			cards: [],
		},
	];
	return {
		card,
		column: columns[0]!,
		allColumns: columns,
	};
}

function createInProgressSelection(): CardSelection {
	const selection = createSelection();
	const inProgress = selection.allColumns.find((column) => column.id === "in_progress")!;
	inProgress.cards = [selection.card];
	selection.allColumns[0]!.cards = [];
	return { ...selection, column: inProgress };
}

describe("CardDetailView", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		window.localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockAgentTerminalPanel.mockClear();
		mockGetChangesQuery.mockClear();
		mockIsMobile.mockReturnValue(false);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		mockAgentTerminalPanel.mockClear();
		mockGetChangesQuery.mockClear();
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("opens a card without loading its changes and gives the agent the full width", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createInProgressSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(mockAgentTerminalPanel).toHaveBeenCalled();
		expect(mockGetChangesQuery).not.toHaveBeenCalled();
		expect(container.querySelector('[aria-label="Resize agent and diff panels"]')).toBeNull();
		expect(container.querySelector('button[aria-label="Expand split diff view"]')).toBeNull();
		expect(container.textContent).not.toContain("All Changes");
	});

	it("shows only the agent on narrow screens and never loads changes", async () => {
		mockIsMobile.mockReturnValue(true);

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createInProgressSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(mockAgentTerminalPanel).toHaveBeenCalled();
		expect(mockGetChangesQuery).not.toHaveBeenCalled();
		const tabLabels = Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim());
		expect(tabLabels).not.toContain("Diff");
		expect(tabLabels).not.toContain("Files");
	});

	it("closes git history before handling other Escape behavior", async () => {
		const onCloseGitHistory = vi.fn();

		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					gitHistoryPanel={<div data-testid="git-history-panel">Git history</div>}
					onCloseGitHistory={onCloseGitHistory}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const input = document.createElement("input");
		container.appendChild(input);
		input.focus();

		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(onCloseGitHistory).toHaveBeenCalledTimes(1);
	});

	it("renders native chat panel for cline agent", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeInstanceOf(HTMLDivElement);
		expect(container.querySelector('[data-testid="agent-terminal-panel"]')).toBeNull();
	});

	it("does not render native chat panel when the task explicitly uses a non-cline agent", async () => {
		const selection = createSelection();
		selection.card.agentId = "codex";

		await act(async () => {
			root.render(
				<CardDetailView
					selection={selection}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeNull();
	});

	it("shows cline chat panel when task session agentId is cline even if global agent is claude", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: null,
						pid: null,
						startedAt: null,
						updatedAt: Date.now(),
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
						warningMessage: null,
					}}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeInstanceOf(HTMLDivElement);
	});

	it("shows terminal panel when task session agentId is claude even if global agent is cline", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="cline"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "claude",
						workspacePath: null,
						pid: null,
						startedAt: null,
						updatedAt: Date.now(),
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
						lastHookAt: null,
						latestHookActivity: null,
						warningMessage: null,
					}}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="cline-agent-chat-panel"]')).toBeNull();
		expect(mockAgentTerminalPanel).toHaveBeenCalled();
	});

	it("uses surface-primary colors for the detail terminal panel", async () => {
		await act(async () => {
			root.render(
				<CardDetailView
					selection={createSelection()}
					currentProjectId="workspace-1"
					selectedAgentId="claude"
					sessionSummary={null}
					taskSessions={{}}
					onSessionSummary={() => {}}
					onCardSelect={() => {}}
					onTaskDragEnd={() => {}}
					onMoveToTrash={() => {}}
					bottomTerminalOpen={false}
					bottomTerminalTaskId={null}
					bottomTerminalSummary={null}
					onBottomTerminalClose={() => {}}
				/>,
			);
		});

		const lastCall = mockAgentTerminalPanel.mock.calls.at(-1);
		expect(lastCall?.[0]).toMatchObject({
			panelBackgroundColor: "var(--color-surface-0)",
			terminalBackgroundColor: TERMINAL_THEME_COLORS.surfacePrimary,
		});
	});
});
