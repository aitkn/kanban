import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	disposeParkedPersistentTerminals,
	disposePersistentTerminal,
	ensurePersistentTerminal,
	MAX_PARKED_PERSISTENT_TERMINALS,
} from "@/terminal/persistent-terminal-manager";

const xtermInstances = vi.hoisted(() => [] as Array<{ dispose: ReturnType<typeof vi.fn> }>);

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		options: Record<string, unknown> = {};
		unicode = { activeVersion: "" };
		dispose = vi.fn();
		constructor() {
			xtermInstances.push(this);
		}
		loadAddon(): void {}
		open(): void {}
		onData(): void {}
		onBinary(): void {}
		attachCustomKeyEventHandler(): void {}
		write(_data: unknown, callback?: () => void): void {
			callback?.();
		}
		reset(): void {}
		resize(): void {}
		focus(): void {}
	},
}));

vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class {
		onContextLoss(): void {}
		dispose(): void {}
	},
}));

vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit(): void {}
	},
}));

vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: vi.fn(),
}));

class FakeWebSocket {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];
	readyState = FakeWebSocket.OPEN;
	binaryType = "blob";
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	readonly close = vi.fn(() => {
		this.readyState = FakeWebSocket.CLOSED;
	});

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(): void {}
	send(): void {}
}

class FakeResizeObserver {
	observe(): void {}
	disconnect(): void {}
}

const WORKSPACE_ID = "workspace-1";

function ensure(taskId: string, workspaceId = WORKSPACE_ID) {
	return ensurePersistentTerminal({
		taskId,
		workspaceId,
		cursorColor: "cursor",
		terminalBackgroundColor: "background",
	});
}

function openSocketsFor(taskId: string): FakeWebSocket[] {
	return FakeWebSocket.instances.filter(
		(socket) => new URL(socket.url).searchParams.get("taskId") === taskId && socket.readyState === FakeWebSocket.OPEN,
	);
}

// Shows the task's terminal in a panel, then switches away from it, the way a card view does.
function viewThenLeave(taskId: string, workspaceId = WORKSPACE_ID): void {
	const container = document.createElement("div");
	const terminal = ensure(taskId, workspaceId);
	terminal.mount(container, { cursorColor: "cursor", terminalBackgroundColor: "background" }, { isVisible: false });
	terminal.unmount(container);
}

describe("persistent terminal eviction", () => {
	const createdKeys: Array<[string, string]> = [];

	beforeEach(() => {
		vi.stubGlobal("WebSocket", FakeWebSocket);
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
		FakeWebSocket.instances = [];
		xtermInstances.length = 0;
	});

	afterEach(() => {
		for (const [workspaceId, taskId] of createdKeys.splice(0)) {
			disposePersistentTerminal(workspaceId, taskId);
		}
		vi.unstubAllGlobals();
	});

	function track(taskIds: string[], workspaceId = WORKSPACE_ID): string[] {
		for (const taskId of taskIds) {
			createdKeys.push([workspaceId, taskId]);
		}
		return taskIds;
	}

	it("disposes the least recently viewed parked terminal and closes its sockets", () => {
		const taskIds = track(Array.from({ length: MAX_PARKED_PERSISTENT_TERMINALS + 1 }, (_, index) => `task-${index}`));

		for (const taskId of taskIds.slice(0, MAX_PARKED_PERSISTENT_TERMINALS)) {
			viewThenLeave(taskId);
		}
		expect(openSocketsFor("task-0")).toHaveLength(2);
		expect(xtermInstances[0]?.dispose).not.toHaveBeenCalled();

		viewThenLeave(taskIds[MAX_PARKED_PERSISTENT_TERMINALS] as string);

		expect(openSocketsFor("task-0")).toHaveLength(0);
		expect(FakeWebSocket.instances.filter((socket) => socket.url.includes("taskId=task-0"))).toHaveLength(2);
		expect(xtermInstances[0]?.dispose).toHaveBeenCalledTimes(1);
		for (const taskId of taskIds.slice(1)) {
			expect(openSocketsFor(taskId)).toHaveLength(2);
		}
		expect(FakeWebSocket.instances.filter((socket) => socket.readyState === FakeWebSocket.OPEN)).toHaveLength(
			2 * MAX_PARKED_PERSISTENT_TERMINALS,
		);
	});

	it("keeps the full parked quota while a newly created terminal is shown", () => {
		const taskIds = track(Array.from({ length: MAX_PARKED_PERSISTENT_TERMINALS + 1 }, (_, index) => `task-${index}`));
		for (const taskId of taskIds.slice(0, MAX_PARKED_PERSISTENT_TERMINALS)) {
			viewThenLeave(taskId);
		}

		const shown = ensure(taskIds[MAX_PARKED_PERSISTENT_TERMINALS] as string);
		shown.mount(
			document.createElement("div"),
			{ cursorColor: "c", terminalBackgroundColor: "b" },
			{ isVisible: false },
		);

		for (const taskId of taskIds) {
			expect(openSocketsFor(taskId)).toHaveLength(2);
		}
	});

	it("creates a fresh connected terminal when an evicted task is shown again", () => {
		const taskIds = track(Array.from({ length: MAX_PARKED_PERSISTENT_TERMINALS + 1 }, (_, index) => `task-${index}`));
		const first = ensure("task-0");
		first.mount(
			document.createElement("div"),
			{ cursorColor: "c", terminalBackgroundColor: "b" },
			{ isVisible: false },
		);
		first.unmount(null);
		for (const taskId of taskIds.slice(1)) {
			viewThenLeave(taskId);
		}
		expect(openSocketsFor("task-0")).toHaveLength(0);

		const reopened = ensure("task-0");

		expect(reopened).not.toBe(first);
		expect(openSocketsFor("task-0")).toHaveLength(2);
	});

	it("never evicts a mounted terminal however many others are parked", () => {
		const visibleTaskId = track(["visible-task"])[0] as string;
		const visible = ensure(visibleTaskId);
		visible.mount(
			document.createElement("div"),
			{ cursorColor: "c", terminalBackgroundColor: "b" },
			{ isVisible: false },
		);
		const visibleXterm = xtermInstances[0];

		for (const taskId of track(Array.from({ length: MAX_PARKED_PERSISTENT_TERMINALS + 3 }, (_, i) => `other-${i}`))) {
			viewThenLeave(taskId);
		}

		expect(visible.isMounted).toBe(true);
		expect(visibleXterm?.dispose).not.toHaveBeenCalled();
		expect(openSocketsFor(visibleTaskId)).toHaveLength(2);
		expect(FakeWebSocket.instances.filter((socket) => socket.readyState === FakeWebSocket.OPEN)).toHaveLength(
			2 * (MAX_PARKED_PERSISTENT_TERMINALS + 1),
		);
	});

	it("keeps a parked terminal marked keepConnectedWhenHidden until its workspace is cleaned up", () => {
		const sidebarTaskId = track(["sidebar-agent"])[0] as string;
		const sidebar = ensurePersistentTerminal({
			taskId: sidebarTaskId,
			workspaceId: WORKSPACE_ID,
			cursorColor: "cursor",
			terminalBackgroundColor: "background",
			keepConnectedWhenHidden: true,
		});
		const container = document.createElement("div");
		sidebar.mount(container, { cursorColor: "c", terminalBackgroundColor: "b" }, { isVisible: false });
		sidebar.unmount(container);

		const cardTaskIds = track(Array.from({ length: MAX_PARKED_PERSISTENT_TERMINALS + 2 }, (_, i) => `card-${i}`));
		for (const taskId of cardTaskIds) {
			viewThenLeave(taskId);
		}

		expect(openSocketsFor(sidebarTaskId)).toHaveLength(2);
		expect(openSocketsFor("card-0")).toHaveLength(0);
		expect(openSocketsFor("card-1")).toHaveLength(0);
		expect(openSocketsFor(cardTaskIds.at(-1) as string)).toHaveLength(2);

		disposeParkedPersistentTerminals(WORKSPACE_ID);

		expect(openSocketsFor(sidebarTaskId)).toHaveLength(0);
	});

	it("keeps a terminal that was shown again more recently than older parked ones", () => {
		const taskIds = track(Array.from({ length: MAX_PARKED_PERSISTENT_TERMINALS + 1 }, (_, index) => `task-${index}`));
		for (const taskId of taskIds.slice(0, MAX_PARKED_PERSISTENT_TERMINALS)) {
			viewThenLeave(taskId);
		}

		viewThenLeave("task-0");
		viewThenLeave(taskIds[MAX_PARKED_PERSISTENT_TERMINALS] as string);

		expect(openSocketsFor("task-0")).toHaveLength(2);
		expect(openSocketsFor("task-1")).toHaveLength(0);
	});

	it("disposes only the named parked terminals of a workspace", () => {
		track(["parked-a", "parked-b", "mounted-a"]);
		track(["parked-a"], "workspace-2");
		viewThenLeave("parked-a");
		viewThenLeave("parked-b");
		viewThenLeave("parked-a", "workspace-2");
		const mounted = ensure("mounted-a");
		mounted.mount(
			document.createElement("div"),
			{ cursorColor: "c", terminalBackgroundColor: "b" },
			{ isVisible: false },
		);

		disposeParkedPersistentTerminals(WORKSPACE_ID, ["parked-a", "mounted-a"]);

		expect(
			FakeWebSocket.instances
				.filter(
					(socket) => socket.url.includes("taskId=parked-a") && socket.url.includes(`workspaceId=${WORKSPACE_ID}`),
				)
				.every((socket) => socket.readyState === FakeWebSocket.CLOSED),
		).toBe(true);
		expect(openSocketsFor("parked-b")).toHaveLength(2);
		expect(openSocketsFor("mounted-a")).toHaveLength(2);
		expect(
			FakeWebSocket.instances
				.filter(
					(socket) => socket.url.includes("taskId=parked-a") && socket.url.includes("workspaceId=workspace-2"),
				)
				.every((socket) => socket.readyState === FakeWebSocket.OPEN),
		).toBe(true);

		disposeParkedPersistentTerminals(WORKSPACE_ID);

		expect(openSocketsFor("parked-b")).toHaveLength(0);
		expect(openSocketsFor("mounted-a")).toHaveLength(2);
	});
});
