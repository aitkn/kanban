import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardCard } from "@/components/board-card";
import {
	type CrossProjectTaskReferences,
	resolveCrossProjectTaskReference,
} from "@/components/dependencies/cross-project-task-references";
import { useTaskReferenceNavigation } from "@/components/dependencies/use-task-reference-navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeProjectSummary, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard as BoardCardModel, BoardColumn, ReviewTaskWorkspaceSnapshot } from "@/types";

let mockWorkspaceSnapshot: ReviewTaskWorkspaceSnapshot | undefined;
let mockMeasureWidths = [240, 240, 240];
let mockMeasureCallCount = 0;

const mockShowAppToast = vi.hoisted(() => vi.fn());
const mockCopyToClipboard = vi.hoisted(() => vi.fn());
type MockCopyState = { value?: string; error?: Error; noUserInteraction: boolean };
let mockCopyState: MockCopyState = { noUserInteraction: true };

vi.mock("@/components/app-toaster", () => ({
	showAppToast: mockShowAppToast,
}));

vi.mock("@hello-pangea/dnd", () => ({
	Draggable: ({
		children,
	}: {
		children: (
			provided: {
				innerRef: (element: HTMLDivElement | null) => void;
				draggableProps: object;
				dragHandleProps: object;
			},
			snapshot: { isDragging: boolean },
		) => ReactNode;
	}): React.ReactElement => (
		<>{children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false })}</>
	),
}));

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => mockWorkspaceSnapshot,
}));

vi.mock("@/utils/react-use", () => ({
	useMedia: () => false,
	useCopyToClipboard: () => [mockCopyState, mockCopyToClipboard],
	useMeasure: () => {
		mockMeasureCallCount += 1;
		const width = mockMeasureWidths[(mockMeasureCallCount - 1) % mockMeasureWidths.length] ?? 240;
		return [
			() => {},
			{
				width,
				height: 0,
				top: 0,
				left: 0,
				bottom: 0,
				right: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			},
		];
	},
}));

vi.mock("@/utils/text-measure", () => ({
	DEFAULT_TEXT_MEASURE_FONT: "400 14px sans-serif",
	measureTextWidth: (value: string) => value.length * 8,
	readElementFontShorthand: () => "400 14px sans-serif",
}));

vi.mock("@/utils/task-prompt", async () => {
	const actual = await vi.importActual<typeof import("@/utils/task-prompt")>("@/utils/task-prompt");
	return {
		...actual,
		truncateTaskPromptLabel: (prompt: string) => prompt.split("||")[0]?.trim() ?? "",
		normalizePromptForDisplay: (value: string) => value.split("||")[0]?.trim() ?? value.trim(),
		getTaskPromptDescription: (prompt: string, title: string) => {
			const normalized = prompt.trim();
			if (!normalized.startsWith(title)) {
				return normalized;
			}
			return normalized.slice(title.length).replace(/^\|\|/, "").trim();
		},
	};
});

function createCard(overrides?: Partial<Parameters<typeof BoardCard>[0]["card"]>) {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createSummary(
	state: RuntimeTaskSessionSummary["state"],
	overrides?: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function Harness(): React.ReactElement {
	const [card, setCard] = useState(
		createCard({
			autoReviewEnabled: true,
			autoReviewMode: "pr",
		}),
	);

	return (
		<BoardCard
			card={card}
			index={0}
			columnId="backlog"
			onCancelAutomaticAction={() => {
				setCard((currentCard) => ({
					...currentCard,
					autoReviewEnabled: false,
				}));
			}}
		/>
	);
}

describe("BoardCard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		mockShowAppToast.mockReset();
		mockCopyToClipboard.mockReset();
		mockCopyState = { noUserInteraction: true };
		mockWorkspaceSnapshot = undefined;
		mockMeasureWidths = [240, 240, 240];
		mockMeasureCallCount = 0;
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 240,
			height: 32,
			right: 240,
			bottom: 32,
			toJSON: () => ({}),
		}));
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows a mode-specific cancel button and hides it after canceling auto review", async () => {
		await act(async () => {
			root.render(<Harness />);
		});

		const cancelButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Cancel Auto-PR",
		);
		expect(cancelButton).toBeDefined();

		await act(async () => {
			cancelButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			cancelButton?.click();
		});

		const nextCancelButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Cancel Auto-"),
		);
		expect(nextCancelButton).toBeUndefined();
	});

	it("shows a loading state on the review done button while moving to done", async () => {
		await act(async () => {
			root.render(<BoardCard card={createCard()} index={0} columnId="review" isMoveToTrashLoading />);
		});

		const trashButton = container.querySelector('button[aria-label="Move task to done"]');
		expect(trashButton).toBeInstanceOf(HTMLButtonElement);
		expect((trashButton as HTMLButtonElement | null)?.disabled).toBe(true);
		expect(trashButton?.querySelector("svg.animate-spin")).toBeTruthy();
	});

	it("hides Commit and Open PR while the agent waits for approval", async () => {
		mockWorkspaceSnapshot = {
			taskId: "task-1",
			path: "/tmp/worktree",
			branch: "task-1",
			isDetached: false,
			headCommit: "abc123",
			changedFiles: 2,
			additions: 1,
			deletions: 0,
		};
		const gitActionLabels = () =>
			Array.from(container.querySelectorAll("button"))
				.map((button) => button.textContent?.trim())
				.filter((label) => label === "Commit" || label === "Open PR");
		const renderWithReason = async (reviewReason: RuntimeTaskSessionSummary["reviewReason"]) => {
			await act(async () => {
				root.render(
					<BoardCard
						card={createCard()}
						index={0}
						columnId="review"
						sessionSummary={createSummary("awaiting_review", {
							reviewReason,
							pendingApprovals:
								reviewReason === "approval"
									? [{ kind: "permission", toolName: "Bash", mcpServerName: null, toolCallKey: "Bash:abc" }]
									: [],
						})}
					/>,
				);
			});
		};

		await renderWithReason("hook");
		expect(gitActionLabels()).toEqual(["Commit", "Open PR"]);
		await renderWithReason("approval");
		expect(gitActionLabels()).toEqual([]);
	});

	it("shows how many prerequisites a backlog card is still waiting on when there are several", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="backlog" pendingPrerequisiteCount={2} />
				</TooltipProvider>,
			);
		});

		const indicator = container.querySelector('[aria-label="Waiting on 2 linked tasks"]');
		expect(indicator?.textContent).toBe("2");
	});

	it("hides the prerequisite indicator for a single prerequisite or outside backlog", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard card={createCard()} index={0} columnId="backlog" pendingPrerequisiteCount={1} />
					<BoardCard
						card={createCard({ id: "task-2" })}
						index={1}
						columnId="review"
						pendingPrerequisiteCount={3}
					/>
				</TooltipProvider>,
			);
		});

		expect(container.querySelector('[aria-label^="Waiting on"]')).toBeNull();
	});

	it("shows inline see more and less controls for long descriptions", async () => {
		const description =
			"Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau final hidden segment";

		await act(async () => {
			root.render(
				<BoardCard card={createCard({ prompt: `Task title||${description}` })} index={0} columnId="backlog" />,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		const seeMoreButton = findButton("See more");
		expect(seeMoreButton).toBeDefined();
		expect(container.textContent).not.toContain("final hidden segment");

		await act(async () => {
			seeMoreButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			seeMoreButton?.click();
		});

		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeDefined();
		expect(container.textContent).toContain(description);

		const lessButton = findButton("Less");
		await act(async () => {
			lessButton?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			lessButton?.click();
		});

		expect(findButton("See more")).toBeDefined();
		expect(container.textContent).not.toContain("final hidden segment");
	});

	it("reconstructs and shows trashed worktree path when workspace metadata is not tracked", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard({ id: "trash-task-1" })}
						index={0}
						columnId="trash"
						workspacePath="/Users/alice/projects/kanban"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("~/.cline/worktrees/trash-task-1/kanban");
	});

	it("shows formatted agent override details with model name and reasoning effort", async () => {
		mockWorkspaceSnapshot = {
			taskId: "task-1",
			path: "/tmp/worktrees/task-1",
			branch: "feature/override",
			isDetached: false,
			headCommit: "1234567890abcdef",
			changedFiles: 2,
			additions: 5,
			deletions: 1,
		};

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "cline",
						clineSettings: {
							modelId: "openai/gpt-5.5",
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="review"
				/>,
			);
		});

		expect(container.textContent).toContain("Cline");
		expect(container.textContent).toContain("GPT-5.5 (Low)");
		expect(container.textContent).not.toContain("openai/gpt-5.5");
	});

	it("shows the task-level indicator for reasoning-only overrides", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						clineSettings: {
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
					defaultClineModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(container.textContent).toContain("GPT-5.5 (Low)");
	});

	it("shows a fallback indicator for reasoning-only overrides without a resolved default model", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						clineSettings: {
							reasoningEffort: "low",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Default model (Low)");
	});

	it("shows explicit default reasoning metadata for reasoning-only task overrides", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "cline",
						clineSettings: {},
					})}
					index={0}
					columnId="backlog"
					defaultClineModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(container.textContent).toContain("GPT-5.5 (Default)");
		expect(container.textContent).not.toContain("GPT-5.5 (High)");
	});

	it("does not mislabel provider-only overrides as the global default model", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						clineSettings: {
							providerId: "groq",
						},
					})}
					index={0}
					columnId="backlog"
					defaultClineModelId="openai/gpt-5.5"
				/>,
			);
		});

		expect(container.textContent).toContain("Provider: groq");
		expect(container.textContent).not.toContain("GPT-5.5");
	});

	it("does not show inherited global reasoning for explicit model overrides using default effort", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({
						agentId: "cline",
						clineSettings: {
							modelId: "openai/gpt-5.5",
						},
					})}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("GPT-5.5");
		expect(container.textContent).not.toContain("GPT-5.5 (High)");
	});

	it("shows tool input details in the session preview text", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: "/tmp/worktree",
						pid: null,
						startedAt: Date.now(),
						updatedAt: Date.now(),
						lastOutputAt: Date.now(),
						reviewReason: null,
						exitCode: null,
						lastHookAt: Date.now(),
						latestHookActivity: {
							activityText: "Using Read",
							toolName: "Read",
							toolInputSummary: "src/index.ts",
							finalMessage: null,
							hookEventName: "tool_call",
							notificationType: null,
							source: "cline-sdk",
						},
						latestTurnCheckpoint: null,
						previousTurnCheckpoint: null,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Using Read");
	});

	it("shows non-cline tool activity in the compact tool label format", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "claude",
						latestHookActivity: {
							activityText: "Completed Read: src/index.ts",
							toolName: "Read",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "tool_result",
							notificationType: null,
							source: "claude",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Completed Read");
	});

	it("keeps canonical tool names in the session preview label", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "kiro",
						latestHookActivity: {
							activityText: "Using fs_write: src/index.ts",
							toolName: "fs_write",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "preToolUse",
							notificationType: null,
							source: "kiro",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("fs_write(src/index.ts)");
	});

	it("parses codex tool activity into the compact tool label format", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "codex",
						latestHookActivity: {
							activityText: "Calling Read: src/index.ts",
							toolName: null,
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "raw_response_item",
							notificationType: null,
							source: "codex",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Calling Read");
	});

	it("does not show a stale bare tool name for non-tool review updates", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="review"
					sessionSummary={createSummary("awaiting_review", {
						agentId: "kiro",
						latestHookActivity: {
							activityText: "Waiting for review",
							toolName: "fs_write",
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "stop",
							notificationType: null,
							source: "kiro",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Waiting for review");
		expect(container.textContent).not.toContain("fs_write");
	});

	it("keeps showing the last cline tool label during assistant streaming", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={{
						taskId: "task-1",
						state: "running",
						agentId: "cline",
						workspacePath: "/tmp/worktree",
						pid: null,
						startedAt: Date.now(),
						updatedAt: Date.now(),
						lastOutputAt: Date.now(),
						reviewReason: null,
						exitCode: null,
						lastHookAt: Date.now(),
						latestHookActivity: {
							activityText: "Agent active",
							toolName: "Read",
							toolInputSummary: "src/index.ts",
							finalMessage: "Looking at the file now",
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
						latestTurnCheckpoint: null,
						previousTurnCheckpoint: null,
					}}
				/>,
			);
		});

		expect(container.textContent).toContain("Read(src/index.ts)");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("renders a new card description before the async measure observer reports width", async () => {
		mockMeasureWidths = [0, 0, 0];

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard({ prompt: "Task title||Freshly created task description" })}
					index={0}
					columnId="backlog"
				/>,
			);
		});

		expect(container.textContent).toContain("Freshly created task description");
	});

	it("renders session activity as single-line truncated text on trash cards", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			root.render(
				<TooltipProvider>
					<BoardCard
						card={createCard()}
						index={0}
						columnId="trash"
						sessionSummary={createSummary("awaiting_review", {
							latestHookActivity: {
								activityText: null,
								toolName: null,
								toolInputSummary: null,
								finalMessage: preview,
								hookEventName: "assistant_delta",
								notificationType: null,
								source: "cline-sdk",
							},
						})}
					/>
				</TooltipProvider>,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("renders session activity as single-line truncated text for running tasks", async () => {
		const preview =
			"Reviewing the archived implementation details and collecting the final notes for the handoff before cleanup hidden tail";

		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						latestHookActivity: {
							activityText: null,
							toolName: null,
							toolInputSummary: null,
							finalMessage: preview,
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
					})}
				/>,
			);
		});

		const findButton = (label: string) =>
			Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);

		// Session activity uses CSS truncation with no See more / Less buttons
		expect(findButton("See more")).toBeUndefined();
		expect(findButton("Less")).toBeUndefined();

		// The full text is in the DOM (CSS handles visual truncation)
		expect(container.textContent).toContain(preview);
	});

	it("shows the latest assistant preview on active task cards", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						latestHookActivity: {
							activityText: "Reviewing the final diff",
							toolName: null,
							toolInputSummary: null,
							finalMessage: "Reviewing the final diff",
							hookEventName: "assistant_delta",
							notificationType: null,
							source: "cline-sdk",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("Reviewing the final diff");
		expect(container.textContent).not.toContain("Thinking...");
	});

	it("shows normal agent messages without the agent prefix", async () => {
		await act(async () => {
			root.render(
				<BoardCard
					card={createCard()}
					index={0}
					columnId="in_progress"
					sessionSummary={createSummary("running", {
						agentId: "codex",
						latestHookActivity: {
							activityText: "Agent: checking the next file",
							toolName: null,
							toolInputSummary: null,
							finalMessage: null,
							hookEventName: "agent_message",
							notificationType: null,
							source: "codex",
						},
					})}
				/>,
			);
		});

		expect(container.textContent).toContain("checking the next file");
		expect(container.textContent).not.toContain("Agent:");
	});

	describe("card id and prerequisite chips (sked fork)", () => {
		function column(id: BoardColumn["id"], title: string, cards: BoardCardModel[]): BoardColumn {
			return { id, title, cards };
		}

		const waitingCard = createCard({
			id: "wait1",
			title: "Waiting card",
			prompt: "Waiting card",
			dependsOn: [
				{ taskId: "back1" },
				{ taskId: "prog1" },
				{ taskId: "revw1" },
				{ taskId: "done1" },
				{ taskId: "gone1" },
			],
		});
		const columns: BoardColumn[] = [
			column("backlog", "Backlog", [createCard({ id: "back1", title: "Backlog prereq", prompt: "Backlog prereq" })]),
			column("in_progress", "In Progress", [
				waitingCard,
				createCard({ id: "prog1", title: "Running prereq", prompt: "Running prereq" }),
			]),
			column("review", "Review", [createCard({ id: "revw1", title: "Review prereq", prompt: "Review prereq" })]),
			column("trash", "Done", [createCard({ id: "done1", title: "Done prereq", prompt: "Done prereq" })]),
		];

		function ChipHarness({
			onCardClick,
			onCardSelect,
			onEditTask,
		}: {
			onCardClick: () => void;
			onCardSelect: (taskId: string) => void;
			onEditTask: (card: BoardCardModel) => void;
		}): React.ReactElement {
			const taskReferences = useTaskReferenceNavigation({ columns, onCardSelect, onEditTask });
			return (
				<TooltipProvider>
					<BoardCard
						card={waitingCard}
						index={0}
						columnId="in_progress"
						onClick={onCardClick}
						taskReferences={taskReferences}
					/>
				</TooltipProvider>
			);
		}

		async function renderChips() {
			const handlers = { onCardClick: vi.fn(), onCardSelect: vi.fn(), onEditTask: vi.fn() };
			await act(async () => {
				root.render(<ChipHarness {...handlers} />);
			});
			return handlers;
		}

		function chip(taskId: string): HTMLButtonElement {
			const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-reference-state]")).find(
				(button) => button.textContent === taskId,
			);
			if (!found) {
				throw new Error(`No chip for ${taskId}`);
			}
			return found;
		}

		async function press(button: HTMLButtonElement): Promise<MouseEvent> {
			const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
			await act(async () => {
				button.dispatchEvent(mouseDown);
				button.click();
			});
			return mouseDown;
		}

		it("shows the card id and copies it on click without opening the card", async () => {
			const handlers = await renderChips();
			const idButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy task id wait1"]');
			expect(idButton?.textContent).toBe("wait1");
			expect(idButton?.className).toContain("font-mono");

			const mouseDown = await press(idButton as HTMLButtonElement);

			expect(mouseDown.defaultPrevented).toBe(true);
			expect(mockCopyToClipboard).toHaveBeenCalledWith("wait1");
			expect(handlers.onCardClick).not.toHaveBeenCalled();
		});

		it("confirms a copy only when it succeeded", async () => {
			const renderBadge = async () => {
				await act(async () => {
					root.render(<BoardCard card={waitingCard} index={0} columnId="in_progress" />);
				});
			};
			await renderBadge();
			expect(mockShowAppToast).not.toHaveBeenCalled();

			mockCopyState = { value: "wait1", noUserInteraction: true };
			await renderBadge();
			expect(mockShowAppToast).toHaveBeenLastCalledWith(
				expect.objectContaining({ intent: "success", message: "Copied wait1" }),
			);

			// The browser blocked the copy and react-use fell back to a manual-copy prompt.
			mockCopyState = { value: "wait1", noUserInteraction: false };
			await renderBadge();
			expect(mockShowAppToast).toHaveBeenLastCalledWith(
				expect.objectContaining({ intent: "warning", message: "Could not copy wait1 automatically." }),
			);
			expect(mockShowAppToast).toHaveBeenCalledTimes(2);
		});

		it("colours each prerequisite chip by the referenced card's current column", async () => {
			await renderChips();

			expect(
				Array.from(container.querySelectorAll("button[data-reference-state]")).map((button) => [
					button.textContent,
					button.getAttribute("data-reference-state"),
				]),
			).toEqual([
				["back1", "backlog"],
				["prog1", "in_progress"],
				["revw1", "review"],
				["done1", "trash"],
				["gone1", "deleted"],
			]);
			expect(chip("back1").className).toContain("text-status-red");
			expect(chip("prog1").className).toContain("text-status-orange");
			expect(chip("revw1").className).toContain("text-status-gold");
			expect(chip("done1").className).toContain("text-status-green");
			expect(chip("gone1").className).toContain("line-through");
			expect(chip("gone1").className).toContain("text-text-tertiary");
			expect(chip("gone1").getAttribute("aria-label")).toContain("card deleted");
		});

		it("opens the referenced card as clicking it would, without opening or dragging this card", async () => {
			const handlers = await renderChips();

			const mouseDown = await press(chip("revw1"));
			await press(chip("prog1"));
			await press(chip("back1"));

			// @hello-pangea/dnd never starts a drag from a <button>; that, not the mocked Draggable, is the guard.
			expect(chip("revw1").tagName).toBe("BUTTON");
			expect(mouseDown.defaultPrevented).toBe(true);
			expect(handlers.onCardSelect.mock.calls).toEqual([["revw1"], ["prog1"]]);
			expect(handlers.onEditTask).toHaveBeenCalledWith(expect.objectContaining({ id: "back1" }));
			expect(handlers.onCardClick).not.toHaveBeenCalled();
		});

		it("explains instead of opening a deleted or done prerequisite", async () => {
			const handlers = await renderChips();

			await press(chip("gone1"));
			await press(chip("done1"));

			expect(mockShowAppToast).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ message: "card no longer exists" }),
			);
			expect(mockShowAppToast).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ message: expect.stringContaining("done1") }),
			);
			expect(handlers.onCardSelect).not.toHaveBeenCalled();
			expect(handlers.onEditTask).not.toHaveBeenCalled();
			expect(handlers.onCardClick).not.toHaveBeenCalled();
		});

		describe("on another project's board", () => {
			const crossCard = createCard({
				id: "wait2",
				title: "Waiting on db",
				prompt: "Waiting on db",
				dependsOn: [
					{ taskId: "back1" },
					{ taskId: "dbBack", projectId: "skedai-db" },
					{ taskId: "dbProg", projectId: "skedai-db" },
					{ taskId: "dbRevw", projectId: "skedai-db" },
					{ taskId: "dbDone", projectId: "skedai-db" },
					{ taskId: "dbGone", projectId: "skedai-db" },
					{ taskId: "x1234", projectId: "removed-project" },
				],
			});
			const projects: RuntimeProjectSummary[] = [
				{
					id: "skedai-db",
					path: "/repos/skedai-db",
					name: "skedai-db",
					shortName: "db",
					taskCounts: { backlog: 1, in_progress: 1, review: 1, trash: 1 },
					referencedTasks: [
						{ taskId: "dbBack", title: "Add the column", columnId: "backlog" },
						{ taskId: "dbProg", title: "Migrate rows", columnId: "in_progress" },
						{ taskId: "dbRevw", title: "Index it", columnId: "review" },
						{ taskId: "dbDone", title: "Drop the old table", columnId: "trash" },
					],
				},
			];

			function CrossHarness({
				onCardClick,
				openProjectTask,
				withCrossProject,
			}: {
				onCardClick: () => void;
				openProjectTask: CrossProjectTaskReferences["openProjectTask"];
				withCrossProject: boolean;
			}): React.ReactElement {
				const crossProject: CrossProjectTaskReferences = {
					resolveProjectTask: (projectId, taskId) => resolveCrossProjectTaskReference(projects, projectId, taskId),
					openProjectTask,
				};
				const taskReferences = useTaskReferenceNavigation({
					columns,
					onCardSelect: vi.fn(),
					onEditTask: vi.fn(),
					crossProject: withCrossProject ? crossProject : undefined,
				});
				return (
					<TooltipProvider>
						<BoardCard
							card={crossCard}
							index={0}
							columnId="backlog"
							onClick={onCardClick}
							taskReferences={taskReferences}
						/>
					</TooltipProvider>
				);
			}

			async function renderCrossChips(withCrossProject = true) {
				const handlers = { onCardClick: vi.fn(), openProjectTask: vi.fn() };
				await act(async () => {
					root.render(<CrossHarness {...handlers} withCrossProject={withCrossProject} />);
				});
				return handlers;
			}

			it("shows <shortName>#<taskId> chips coloured by the other card's column, beside same-board chips", async () => {
				await renderCrossChips();

				expect(
					Array.from(container.querySelectorAll("button[data-reference-state]")).map((button) => [
						button.textContent,
						button.getAttribute("data-reference-state"),
					]),
				).toEqual([
					["back1", "backlog"],
					["db#dbBack", "backlog"],
					["db#dbProg", "in_progress"],
					["db#dbRevw", "review"],
					["db#dbDone", "trash"],
					["db#dbGone", "deleted"],
					["removed-project#x1234", "deleted"],
				]);
				expect(chip("db#dbBack").className).toContain("text-status-red");
				expect(chip("db#dbProg").className).toContain("text-status-orange");
				expect(chip("db#dbRevw").className).toContain("text-status-gold");
				expect(chip("db#dbDone").className).toContain("text-status-green");
				for (const deleted of ["db#dbGone", "removed-project#x1234"]) {
					expect(chip(deleted).className).toContain("line-through");
					expect(chip(deleted).getAttribute("aria-label")).toContain("card deleted");
				}
				expect(chip("db#dbRevw").getAttribute("aria-label")).toBe(
					"Open prerequisite db#dbRevw in project skedai-db (Review)",
				);
			});

			it("shows the project and the card title in the tooltip", async () => {
				await renderCrossChips();

				await act(async () => {
					chip("db#dbRevw").focus();
				});

				expect(document.body.textContent).toContain("skedai-db · Review: Index it");
			});

			it("opens the other project's card without opening or dragging this card", async () => {
				const handlers = await renderCrossChips();

				const mouseDown = await press(chip("db#dbRevw"));
				await press(chip("db#dbGone"));
				await press(chip("removed-project#x1234"));

				expect(mouseDown.defaultPrevented).toBe(true);
				expect(handlers.openProjectTask.mock.calls).toEqual([
					["skedai-db", "dbRevw"],
					["skedai-db", "dbGone"],
					["removed-project", "x1234"],
				]);
				expect(handlers.onCardClick).not.toHaveBeenCalled();
			});

			it("renders only same-board chips without cross-project references", async () => {
				await renderCrossChips(false);

				expect(
					Array.from(container.querySelectorAll("button[data-reference-state]")).map(
						(button) => button.textContent,
					),
				).toEqual(["back1"]);
			});
		});

		it("renders no chips without task references or prerequisites", async () => {
			await act(async () => {
				root.render(
					<TooltipProvider>
						<BoardCard card={waitingCard} index={0} columnId="in_progress" />
						<BoardCard card={createCard({ id: "solo1" })} index={1} columnId="in_progress" />
					</TooltipProvider>,
				);
			});

			expect(container.querySelectorAll("button[data-reference-state]")).toHaveLength(0);
			expect(container.textContent).toContain("solo1");
		});
	});
});
