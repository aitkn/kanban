import { act, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CrossProjectTaskReferences } from "@/components/dependencies/cross-project-task-references";
import { parseProjectIdFromPathname } from "@/hooks/app-utils";
import { useCrossProjectTaskNavigation } from "@/hooks/use-cross-project-task-navigation";
import { useDetailTaskNavigation } from "@/hooks/use-detail-task-navigation";
import type { RuntimeProjectSummary } from "@/runtime/types";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { useWindowEvent } from "@/utils/react-use";

const mockShowAppToast = vi.hoisted(() => vi.fn());
vi.mock("@/components/app-toaster", () => ({ showAppToast: mockShowAppToast }));

function card(id: string): BoardCard {
	return {
		id,
		title: `Title ${id}`,
		prompt: `Title ${id}`,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function board(cards: Partial<Record<BoardColumnId, string[]>>): BoardData {
	const column = (id: BoardColumnId, title: string) => ({ id, title, cards: (cards[id] ?? []).map(card) });
	return {
		columns: [
			column("backlog", "Backlog"),
			column("in_progress", "In Progress"),
			column("review", "Review"),
			column("trash", "Done"),
		],
		dependencies: [],
	};
}

const webBoard = board({ in_progress: ["wait1"] });
const dbBoard = board({ backlog: ["dbBack"], review: ["dbRevw"], trash: ["dbDone"] });

function project(id: string, referencedTasks: RuntimeProjectSummary["referencedTasks"] = []): RuntimeProjectSummary {
	return {
		id,
		path: `/repos/${id}`,
		name: id,
		shortName: id,
		taskCounts: { backlog: 0, in_progress: 0, review: 0, trash: 0 },
		referencedTasks,
	};
}

const projects: RuntimeProjectSummary[] = [
	project("web"),
	project("db", [
		{ taskId: "dbBack", title: "Title dbBack", columnId: "backlog" },
		{ taskId: "dbRevw", title: "Title dbRevw", columnId: "review" },
		{ taskId: "dbDone", title: "Title dbDone", columnId: "trash" },
		// On the server's last payload, but deleted from db's board by the time it loads.
		{ taskId: "dbRace", title: "Title dbRace", columnId: "review" },
	]),
];

interface HarnessProps {
	currentProjectId: string;
	board: BoardData;
	isBoardLoading?: boolean;
	handleSelectProject: (projectId: string) => void;
	onEditTask: (card: BoardCard) => void;
}

interface Snapshot {
	selectedTaskId: string | null;
	references: CrossProjectTaskReferences;
	/** What `useProjectNavigation` does when the requested project no longer exists. */
	abandonSwitch: () => void;
	/** Picking a project in the sidebar. */
	selectProject: (projectId: string) => void;
}

let snapshot: Snapshot | null = null;

/**
 * The two hooks as App wires them: the detail navigation closes on a project change, and
 * `requestedProjectId` is kept as `useProjectNavigation` keeps it, so `isProjectSwitching`
 * turns true in the same update as the select. The test plays the stream: it renders the
 * new `currentProjectId`, then the new board.
 */
function Harness({
	currentProjectId,
	board: currentBoard,
	isBoardLoading = false,
	handleSelectProject,
	onEditTask,
}: HarnessProps): null {
	const [requestedProjectId, setRequestedProjectId] = useState(currentProjectId);
	const isProjectSwitching = requestedProjectId !== currentProjectId;
	const selectProject = useCallback(
		(projectId: string) => {
			handleSelectProject(projectId);
			setRequestedProjectId(projectId);
		},
		[handleSelectProject],
	);
	useWindowEvent("popstate", () => {
		setRequestedProjectId(parseProjectIdFromPathname(window.location.pathname) ?? currentProjectId);
	});
	const { selectedTaskId, setSelectedTaskId } = useDetailTaskNavigation({
		board: currentBoard,
		currentProjectId,
		isAwaitingWorkspaceSnapshot: false,
		isInitialRuntimeLoad: false,
		isProjectSwitching,
		isWorkspaceMetadataPending: isBoardLoading,
	});
	const references = useCrossProjectTaskNavigation({
		projects,
		currentProjectId,
		board: currentBoard,
		isBoardLoading: isProjectSwitching || isBoardLoading,
		isProjectSwitching,
		handleSelectProject: selectProject,
		setSelectedTaskId,
		onCardSelect: setSelectedTaskId,
		onEditTask,
	});
	useEffect(() => {
		snapshot = {
			selectedTaskId,
			references,
			abandonSwitch: () => setRequestedProjectId(currentProjectId),
			selectProject,
		};
	});
	return null;
}

function current(): Snapshot {
	if (!snapshot) {
		throw new Error("Harness has not rendered.");
	}
	return snapshot;
}

function location(): string {
	return `${window.location.pathname}${window.location.search}`;
}

async function goBack(): Promise<void> {
	await act(async () => {
		const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
		window.history.back();
		await popped;
	});
}

describe("useCrossProjectTaskNavigation (sked fork)", () => {
	let container: HTMLDivElement;
	let root: Root;
	let handleSelectProject: ReturnType<typeof vi.fn<(projectId: string) => void>>;
	let onEditTask: ReturnType<typeof vi.fn<(card: BoardCard) => void>>;

	async function render(props: Omit<HarnessProps, "handleSelectProject" | "onEditTask">): Promise<void> {
		await act(async () => {
			root.render(<Harness {...props} handleSelectProject={handleSelectProject} onEditTask={onEditTask} />);
		});
	}

	/** The stream catching up with a requested project: its id arrives first, its board one update later. */
	async function completeSwitch(from: { board: BoardData }, to: { id: string; board: BoardData }) {
		await render({ currentProjectId: to.id, board: from.board, isBoardLoading: true });
		await render({ currentProjectId: to.id, board: to.board });
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		mockShowAppToast.mockReset();
		handleSelectProject = vi.fn<(projectId: string) => void>();
		onEditTask = vi.fn<(card: BoardCard) => void>();
		snapshot = null;
		window.history.replaceState({}, "", "/web?task=wait1");
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("opens the card after the switch, past the detail close, with one history entry", async () => {
		await render({ currentProjectId: "web", board: webBoard });
		expect(current().selectedTaskId).toBe("wait1");
		const historyLength = window.history.length;

		act(() => current().references.openProjectTask("db", "dbRevw"));
		expect(handleSelectProject).toHaveBeenCalledWith("db");
		expect(window.history.length).toBe(historyLength + 1);
		// web's detail view closes at once, so it never renders under db's project id.
		expect(current().selectedTaskId).toBeNull();
		expect(location()).toBe("/db");

		// Still switching: the stream has not moved to db yet.
		await render({ currentProjectId: "web", board: webBoard });
		expect(current().selectedTaskId).toBeNull();
		await render({ currentProjectId: "db", board: webBoard, isBoardLoading: true });
		// The project change closed the detail view and the board is not db's yet: nothing opened.
		expect(current().selectedTaskId).toBeNull();

		await render({ currentProjectId: "db", board: dbBoard });
		expect(current().selectedTaskId).toBe("dbRevw");
		expect(location()).toBe("/db?task=dbRevw");
		expect(window.history.length).toBe(historyLength + 1);
		expect(mockShowAppToast).not.toHaveBeenCalled();
	});

	it("pushes one history entry for repeated clicks while the jump is in flight", async () => {
		await render({ currentProjectId: "web", board: webBoard });
		const historyLength = window.history.length;

		act(() => current().references.openProjectTask("db", "dbRevw"));
		act(() => current().references.openProjectTask("db", "dbRevw"));

		expect(window.history.length).toBe(historyLength + 1);
		expect(handleSelectProject).toHaveBeenCalledTimes(1);
	});

	it("returns to the previous project and card on Back", async () => {
		await render({ currentProjectId: "web", board: webBoard });
		act(() => current().references.openProjectTask("db", "dbRevw"));
		await completeSwitch({ board: webBoard }, { id: "db", board: dbBoard });
		expect(current().selectedTaskId).toBe("dbRevw");

		await goBack();
		expect(location()).toBe("/web?task=wait1");
		await completeSwitch({ board: dbBoard }, { id: "web", board: webBoard });

		expect(current().selectedTaskId).toBe("wait1");
		expect(location()).toBe("/web?task=wait1");
	});

	it("opens a backlog card's editor, as clicking it does", async () => {
		await render({ currentProjectId: "web", board: webBoard });
		act(() => current().references.openProjectTask("db", "dbBack"));
		await completeSwitch({ board: webBoard }, { id: "db", board: dbBoard });

		expect(onEditTask).toHaveBeenCalledWith(expect.objectContaining({ id: "dbBack" }));
		expect(current().selectedTaskId).toBeNull();
	});

	it.each([
		["a deleted card", "db", "gone1"],
		["a removed project", "removed", "x1234"],
	])("does not switch projects for %s", async (_case, projectId, taskId) => {
		await render({ currentProjectId: "web", board: webBoard });
		const historyLength = window.history.length;

		act(() => current().references.openProjectTask(projectId, taskId));

		expect(mockShowAppToast).toHaveBeenCalledWith(expect.objectContaining({ message: "card no longer exists" }));
		expect(handleSelectProject).not.toHaveBeenCalled();
		expect(window.history.length).toBe(historyLength);
		expect(location()).toBe("/web?task=wait1");
	});

	it("does not switch projects for a done card", async () => {
		await render({ currentProjectId: "web", board: webBoard });

		act(() => current().references.openProjectTask("db", "dbDone"));

		expect(mockShowAppToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Card db#dbDone is done. Restore it from Done to open it." }),
		);
		expect(handleSelectProject).not.toHaveBeenCalled();
	});

	it("tells the user when the card was deleted while switching", async () => {
		await render({ currentProjectId: "web", board: webBoard });
		act(() => current().references.openProjectTask("db", "dbRace"));
		await completeSwitch({ board: webBoard }, { id: "db", board: dbBoard });

		expect(mockShowAppToast).toHaveBeenCalledWith(expect.objectContaining({ message: "card no longer exists" }));
		expect(current().selectedTaskId).toBeNull();
	});

	it("forgets the card when the switch is abandoned", async () => {
		await render({ currentProjectId: "web", board: webBoard });
		act(() => current().references.openProjectTask("db", "dbRevw"));
		expect(location()).toBe("/db");
		// The requested project vanished, so navigation fell back to the current one.
		act(() => current().abandonSwitch());
		await render({ currentProjectId: "web", board: webBoard });
		// The address bar no longer names the project that could not be opened.
		expect(location()).toBe("/web");

		// A later visit to db from the project list must not open the card.
		act(() => current().selectProject("db"));
		await completeSwitch({ board: webBoard }, { id: "db", board: dbBoard });
		expect(current().selectedTaskId).toBeNull();
	});
});
