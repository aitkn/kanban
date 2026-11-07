import type { DropResult } from "@hello-pangea/dnd";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanBoard, type RequestProgrammaticCardMove } from "@/components/kanban-board";
import type { BoardData } from "@/types";

const dndMock = vi.hoisted(() => ({
	sensorApi: null as {
		tryGetLock: ReturnType<typeof vi.fn>;
	} | null,
	onDragEnd: null as ((result: DropResult) => void) | null,
}));

vi.mock("@hello-pangea/dnd", async () => {
	const React = await vi.importActual<typeof import("react")>("react");

	return {
		DragDropContext: ({
			children,
			sensors,
			onDragEnd,
		}: {
			children: ReactNode;
			sensors?: Array<(api: NonNullable<typeof dndMock.sensorApi>) => void>;
			onDragEnd: (result: DropResult) => void;
		}): React.ReactElement => {
			dndMock.onDragEnd = onDragEnd;
			React.useEffect(() => {
				if (!dndMock.sensorApi) {
					return;
				}
				for (const sensor of sensors ?? []) {
					sensor(dndMock.sensorApi);
				}
			}, [sensors]);

			return <>{children}</>;
		},
	};
});

vi.mock("@/components/board-column", () => ({
	BoardColumn: ({ column }: { column: BoardData["columns"][number] }): React.ReactElement => (
		<section data-column-id={column.id}>
			<div className="kb-column-cards">
				{column.cards.map((card) => (
					<div key={card.id} data-task-id={card.id} data-rfd-draggable-id={card.id} />
				))}
			</div>
		</section>
	),
}));

vi.mock("@/components/dependencies/dependency-overlay", () => ({
	DependencyOverlay: (): null => null,
}));

vi.mock("@/components/dependencies/use-dependency-linking", () => ({
	useDependencyLinking: () => ({
		draft: null,
		onDependencyPointerDown: vi.fn(),
		onDependencyPointerEnter: vi.fn(),
	}),
}));

function createRect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	} as DOMRect;
}

function createCard(id: string): BoardData["columns"][number]["cards"][number] {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createStartBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [createCard("source-task")] },
			{ id: "in_progress", title: "In Progress", cards: [createCard("target-task-1")] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

/**
 * Browser-like animation frames: every callback requested before a frame runs in that frame, in
 * request order, with the frame's timestamp; callbacks requested during a frame run in the next.
 */
function installAnimationFrames(frameMs: number): void {
	let queue: Array<{ id: number; callback: FrameRequestCallback }> = [];
	const cancelled = new Set<number>();
	let nextId = 1;
	let frameTimeoutId: number | null = null;
	const runFrame = () => {
		frameTimeoutId = null;
		const callbacks = queue;
		queue = [];
		const frameTime = performance.now();
		for (const { id, callback } of callbacks) {
			if (!cancelled.delete(id)) {
				callback(frameTime);
			}
		}
	};
	vi.mocked(window.requestAnimationFrame).mockImplementation((callback: FrameRequestCallback) => {
		const id = nextId;
		nextId += 1;
		queue.push({ id, callback });
		if (frameTimeoutId === null) {
			frameTimeoutId = window.setTimeout(runFrame, frameMs);
		}
		return id;
	});
	vi.mocked(window.cancelAnimationFrame).mockImplementation((id: number) => {
		cancelled.add(id);
	});
}

interface FakeFluidDrag {
	/** Where pangea's drop landed before the board saw it; undefined until dropped. */
	droppedDestination: string | null | undefined;
	release: () => void;
}

/**
 * Stands in for @hello-pangea/dnd 18.0.1's fluid drag: `move()` is rafSchd-throttled (dispatched
 * on the next frame with the latest point), `drop()` cancels a move still waiting for its frame,
 * and the drop lands in whichever column the last dispatched point is over.
 */
function installFakeFluidDrag(options: { landsAtHome?: boolean; stallsOnDrop?: boolean } = {}): FakeFluidDrag {
	let active = true;
	let pendingMoveFrameId: number | null = null;
	let pendingPoint: { x: number; y: number } | null = null;
	let dispatchedPoint: { x: number; y: number } | null = null;
	let dropResult: DropResult | null = null;
	const fake: FakeFluidDrag = {
		droppedDestination: undefined,
		release: () => {
			if (dropResult) {
				dndMock.onDragEnd?.(dropResult);
			}
		},
	};
	const dragActions = {
		isActive: () => active,
		move: (point: { x: number; y: number }) => {
			pendingPoint = point;
			if (pendingMoveFrameId === null) {
				pendingMoveFrameId = window.requestAnimationFrame(() => {
					pendingMoveFrameId = null;
					dispatchedPoint = pendingPoint;
				});
			}
		},
		drop: () => {
			if (pendingMoveFrameId !== null) {
				window.cancelAnimationFrame(pendingMoveFrameId);
				pendingMoveFrameId = null;
			}
			active = false;
			const overTarget = !options.landsAtHome && dispatchedPoint !== null && dispatchedPoint.x >= 292;
			const destinationColumnId = overTarget ? "in_progress" : "backlog";
			fake.droppedDestination = destinationColumnId;
			dropResult = {
				draggableId: "source-task",
				type: "CARD",
				source: { droppableId: "backlog", index: 0 },
				destination: { droppableId: destinationColumnId, index: 0 },
				combine: null,
				mode: "FLUID",
				reason: "DROP",
			};
			if (!options.stallsOnDrop) {
				fake.release();
			}
		},
		cancel: () => {
			active = false;
		},
	};
	const preDrag = {
		fluidLift: vi.fn(() => dragActions),
		isActive: vi.fn(() => true),
		abort: vi.fn(),
	};
	dndMock.sensorApi = {
		tryGetLock: vi.fn(() => preDrag),
	};
	return fake;
}

describe("KanbanBoard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			return window.setTimeout(() => {
				callback(performance.now());
			}, 16);
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle: number) => {
			window.clearTimeout(handle);
		});
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(
			this: HTMLElement,
		) {
			if (this.dataset.taskId === "source-task") {
				return createRect(20, 20, 160, 96);
			}
			if (this.dataset.taskId === "target-task-1") {
				return createRect(300, 20, 160, 96);
			}
			if (this.classList.contains("kb-column-cards")) {
				const columnId = this.closest<HTMLElement>("[data-column-id]")?.dataset.columnId;
				if (columnId === "backlog") {
					return createRect(12, 12, 176, 420);
				}
				if (columnId === "in_progress") {
					return createRect(292, 12, 176, 420);
				}
			}
			return createRect(0, 0, 0, 0);
		});
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
		dndMock.sensorApi = null;
		dndMock.onDragEnd = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("marks the board while a programmatic move is active", async () => {
		const dragActions = {
			isActive: vi.fn(() => true),
			move: vi.fn(),
			drop: vi.fn(),
			cancel: vi.fn(),
		};
		const preDrag = {
			fluidLift: vi.fn(() => dragActions),
			isActive: vi.fn(() => true),
			abort: vi.fn(),
		};
		dndMock.sensorApi = {
			tryGetLock: vi.fn(() => preDrag),
		};

		const board: BoardData = {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "source-task",
							title: "Source task",
							prompt: "Source task",
							startInPlanMode: false,
							autoReviewEnabled: false,
							autoReviewMode: "commit",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "target-task-1",
							title: "Target task 1",
							prompt: "Target task 1",
							startInPlanMode: false,
							autoReviewEnabled: false,
							autoReviewMode: "commit",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};

		let requestMove: RequestProgrammaticCardMove | null = null;

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					dependencies={[]}
					onDragEnd={() => {}}
					onRequestProgrammaticCardMoveReady={(nextRequestMove) => {
						requestMove = nextRequestMove;
					}}
				/>,
			);
		});

		const boardElement = container.querySelector<HTMLElement>(".kb-board");
		expect(boardElement?.dataset.programmaticCardMove).toBeUndefined();

		await act(async () => {
			requestMove?.({
				taskId: "source-task",
				fromColumnId: "backlog",
				toColumnId: "in_progress",
				insertAtTop: true,
			});
		});

		expect(boardElement?.dataset.programmaticCardMove).toBe("true");
	});
	async function renderStartBoard(onDragEnd: (result: DropResult) => void): Promise<RequestProgrammaticCardMove> {
		let requestMove: RequestProgrammaticCardMove | null = null;
		await act(async () => {
			root.render(
				<KanbanBoard
					data={createStartBoard()}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					dependencies={[]}
					onDragEnd={onDragEnd}
					onRequestProgrammaticCardMoveReady={(nextRequestMove) => {
						requestMove = nextRequestMove;
					}}
				/>,
			);
		});
		if (!requestMove) {
			throw new Error("Expected the board to offer programmatic moves.");
		}
		return requestMove;
	}

	async function startProgrammaticMove(requestMove: RequestProgrammaticCardMove): Promise<void> {
		await act(async () => {
			expect(
				requestMove({
					taskId: "source-task",
					fromColumnId: "backlog",
					toColumnId: "in_progress",
					insertAtTop: true,
				}),
			).toBe(true);
		});
	}

	async function advance(ms: number): Promise<void> {
		await act(async () => {
			vi.advanceTimersByTime(ms);
		});
	}

	const getBoardElement = () => container.querySelector<HTMLElement>(".kb-board");

	it.each([16, 50, 200])("drops a programmatic move over its target with %ims animation frames", async (frameMs) => {
		installAnimationFrames(frameMs);
		const fake = installFakeFluidDrag();
		const onDragEnd = vi.fn();
		const requestMove = await renderStartBoard(onDragEnd);

		await startProgrammaticMove(requestMove);
		await advance(frameMs * 20);

		expect(fake.droppedDestination).toBe("in_progress");
		expect(onDragEnd).toHaveBeenCalledTimes(1);
		expect(onDragEnd.mock.calls[0]?.[0].destination).toEqual({ droppableId: "in_progress", index: 0 });
		expect(getBoardElement()?.dataset.programmaticCardMove).toBeUndefined();
	});

	it("lands a programmatic move on its target when pangea drops it at home", async () => {
		installAnimationFrames(16);
		const fake = installFakeFluidDrag({ landsAtHome: true });
		const onDragEnd = vi.fn();
		const requestMove = await renderStartBoard(onDragEnd);

		await startProgrammaticMove(requestMove);
		await advance(1000);

		expect(fake.droppedDestination).toBe("backlog");
		expect(onDragEnd).toHaveBeenCalledTimes(1);
		expect(onDragEnd.mock.calls[0]?.[0]).toMatchObject({
			draggableId: "source-task",
			source: { droppableId: "backlog", index: 0 },
			destination: { droppableId: "in_progress", index: 0 },
		});
	});

	it("leaves a manual drop that misses its target alone", async () => {
		installAnimationFrames(16);
		const onDragEnd = vi.fn();
		await renderStartBoard(onDragEnd);
		const homeDrop: DropResult = {
			draggableId: "source-task",
			type: "CARD",
			source: { droppableId: "backlog", index: 0 },
			destination: { droppableId: "backlog", index: 0 },
			combine: null,
			mode: "FLUID",
			reason: "DROP",
		};

		await act(async () => {
			dndMock.onDragEnd?.(homeDrop);
		});

		expect(onDragEnd).toHaveBeenCalledWith(homeDrop);
	});

	it("releases a drop animation stalled on a transitionend that never fires", async () => {
		installAnimationFrames(16);
		const fake = installFakeFluidDrag({ stallsOnDrop: true });
		const onDragEnd = vi.fn();
		const requestMove = await renderStartBoard(onDragEnd);
		const draggable = container.querySelector<HTMLElement>('[data-rfd-draggable-id="source-task"]');
		const transitionEndProperties: string[] = [];
		draggable?.addEventListener("transitionend", (event) => {
			transitionEndProperties.push((event as TransitionEvent).propertyName);
			fake.release();
		});

		await startProgrammaticMove(requestMove);
		await advance(500);
		expect(fake.droppedDestination).toBe("in_progress");
		expect(onDragEnd).not.toHaveBeenCalled();
		expect(getBoardElement()?.dataset.programmaticCardMove).toBe("true");

		await advance(1000);

		expect(transitionEndProperties).toEqual(["transform"]);
		expect(onDragEnd).toHaveBeenCalledTimes(1);
		expect(onDragEnd.mock.calls[0]?.[0].destination).toEqual({ droppableId: "in_progress", index: 0 });
		expect(getBoardElement()?.dataset.programmaticCardMove).toBeUndefined();
	});

	it("finishes a programmatic move that pangea never ends", async () => {
		installAnimationFrames(16);
		installFakeFluidDrag({ landsAtHome: true, stallsOnDrop: true });
		const onDragEnd = vi.fn();
		const requestMove = await renderStartBoard(onDragEnd);

		await startProgrammaticMove(requestMove);
		await advance(1500);
		expect(onDragEnd).not.toHaveBeenCalled();

		await advance(1000);

		expect(onDragEnd).toHaveBeenCalledTimes(1);
		expect(onDragEnd.mock.calls[0]?.[0]).toMatchObject({
			draggableId: "source-task",
			reason: "DROP",
			source: { droppableId: "backlog", index: 0 },
			destination: { droppableId: "in_progress", index: 0 },
		});
		expect(getBoardElement()?.dataset.programmaticCardMove).toBeUndefined();

		await advance(5000);
		expect(onDragEnd).toHaveBeenCalledTimes(1);
	});
});
