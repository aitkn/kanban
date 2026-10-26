import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

import type { PtyBackend } from "../../../src/terminal/pty-backend";
import { PtyHostBackend } from "../../../src/terminal/pty-host/pty-host-backend";
import { PtyHostClient } from "../../../src/terminal/pty-host/pty-host-client";
import { encodePtyHostFrame, PtyHostFrameDecoder } from "../../../src/terminal/pty-host/pty-host-protocol";
import { PtyHostServer } from "../../../src/terminal/pty-host/pty-host-server";
import { PtySession } from "../../../src/terminal/pty-session";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

const BASH = "/bin/bash";

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition.");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function backendFor(client: PtyHostClient): PtyBackend {
	return {
		spawn: async (request) => await client.spawn(request),
		listDetachedSessions: async (namespace) => await client.listDetachedSessions(namespace),
		attach: async (id, callbacks) => await client.attach(id, callbacks),
	};
}

describe("PtyHostFrameDecoder", () => {
	it("reassembles frames split across and packed into socket chunks", () => {
		const encoded = Buffer.concat([
			encodePtyHostFrame({ type: "data", id: "a" }, Buffer.from("first")),
			encodePtyHostFrame({ type: "exit", id: "a" }),
		]);
		const decoder = new PtyHostFrameDecoder<{ type: string; id: string }>();

		const frames = [
			...decoder.push(encoded.subarray(0, 5)),
			...decoder.push(encoded.subarray(5, 30)),
			...decoder.push(encoded.subarray(30)),
		];

		expect(frames.map((frame) => [frame.header.type, frame.payload.toString("utf8")])).toEqual([
			["data", "first"],
			["exit", ""],
		]);
	});
});

describe("PTY host", () => {
	let directory: string;
	let socketPath: string;
	let server: PtyHostServer;
	let onIdle: ReturnType<typeof vi.fn<() => void>>;
	const clients: PtyHostClient[] = [];

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "kanban-pty-host-test-"));
		socketPath = join(directory, "host.sock");
		onIdle = vi.fn<() => void>();
		server = new PtyHostServer({ socketPath, idleExitMs: 50, onIdle });
		expect(await server.listen()).toBe(true);
		prepareAgentLaunchMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) {
			client.close();
		}
		await server.close({ killSessions: true });
		rmSync(directory, { recursive: true, force: true });
	});

	async function connect(): Promise<PtyHostClient> {
		const client = await PtyHostClient.connect(socketPath);
		if (!client) {
			throw new Error("Could not connect to the PTY host.");
		}
		clients.push(client);
		return client;
	}

	it("keeps a process running after its runtime disconnects and hands it to the next runtime", async () => {
		const firstRuntime = await connect();
		let firstOutput = "";
		const spawned = await firstRuntime.spawn({
			namespace: "workspace-1",
			taskId: "task-1",
			binary: BASH,
			args: ["-c", "echo ready; read line; echo got:$line; sleep 30"],
			cwd: directory,
			env: process.env,
			cols: 80,
			rows: 24,
			meta: { kind: "test" },
			onData: (chunk) => {
				firstOutput += chunk.toString("utf8");
			},
		});
		await waitFor(() => firstOutput.includes("ready"));

		firstRuntime.close();
		await waitFor(() => firstRuntime.isClosed);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(isProcessAlive(spawned.pid)).toBe(true);

		const secondRuntime = await connect();
		const detached = await secondRuntime.listDetachedSessions("workspace-1");
		expect(detached).toEqual([
			expect.objectContaining({ taskId: "task-1", pid: spawned.pid, exit: null, meta: { kind: "test" } }),
		]);
		expect(await secondRuntime.listDetachedSessions("workspace-2")).toEqual([]);

		let secondOutput = "";
		const exits: Array<number | null> = [];
		const attached = await secondRuntime.attach(detached[0]?.id as string, {
			onData: (chunk) => {
				secondOutput += chunk.toString("utf8");
			},
			onExit: (event) => {
				exits.push(event.exitCode);
			},
		});
		expect(attached.snapshot).toContain("ready");
		expect(attached.process.pid).toBe(spawned.pid);

		attached.process.write("hello\r");
		await waitFor(() => secondOutput.includes("got:hello"));

		attached.process.stop();
		await waitFor(() => exits.length === 1);
		expect(isProcessAlive(spawned.pid)).toBe(false);
	});

	it("reports an exit that happened while no runtime was attached, after the final screen", async () => {
		const firstRuntime = await connect();
		let firstOutput = "";
		await firstRuntime.spawn({
			namespace: "workspace-1",
			taskId: "task-1",
			binary: BASH,
			args: ["-c", "echo started; sleep 0.3; echo finished; exit 3"],
			cwd: directory,
			env: process.env,
			cols: 80,
			rows: 24,
			meta: null,
			onData: (chunk) => {
				firstOutput += chunk.toString("utf8");
			},
		});
		await waitFor(() => firstOutput.includes("started"));
		firstRuntime.close();
		await new Promise((resolve) => setTimeout(resolve, 600));

		const secondRuntime = await connect();
		const [detached] = await secondRuntime.listDetachedSessions(null);
		expect(detached?.exit).toEqual(expect.objectContaining({ exitCode: 3 }));

		const exits: Array<number | null> = [];
		const attached = await secondRuntime.attach(detached?.id as string, {
			onExit: (event) => {
				exits.push(event.exitCode);
			},
		});
		expect(attached.snapshot).toContain("finished");
		await waitFor(() => exits.length === 1);
		expect(exits).toEqual([3]);
		expect(await secondRuntime.listDetachedSessions(null)).toEqual([]);
	});

	it("goes idle once no runtime is connected and nothing is running", async () => {
		const runtime = await connect();
		const exits: Array<number | null> = [];
		await runtime.spawn({
			namespace: "workspace-1",
			taskId: "task-1",
			binary: BASH,
			args: ["-c", "exit 0"],
			cwd: directory,
			env: process.env,
			cols: 80,
			rows: 24,
			meta: null,
			onExit: (event) => {
				exits.push(event.exitCode);
			},
		});
		await waitFor(() => exits.length === 1);
		expect(onIdle).not.toHaveBeenCalled();

		runtime.close();

		await waitFor(() => onIdle.mock.calls.length === 1);
	});

	it("does not go idle while a process is running without a runtime", async () => {
		const runtime = await connect();
		await runtime.spawn({
			namespace: "workspace-1",
			taskId: "task-1",
			binary: BASH,
			args: ["-c", "sleep 30"],
			cwd: directory,
			env: process.env,
			cols: 80,
			rows: 24,
			meta: null,
		});
		runtime.close();

		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(onIdle).not.toHaveBeenCalled();
		expect(server.liveSessionCount).toBe(1);
	});

	it("lets a restarted runtime's session manager take over a running shell session", async () => {
		const firstManager = new TerminalSessionManager({ ptyBackend: backendFor(await connect()), namespace: "ws" });
		const started = await firstManager.startShellSession({
			taskId: "__home_terminal__",
			cwd: directory,
			binary: BASH,
			args: ["-c", "echo one; read line; echo two:$line; sleep 30"],
		});
		const firstListenerOutput: string[] = [];
		firstManager.attach("__home_terminal__", { onOutput: (chunk) => firstListenerOutput.push(chunk.toString()) });
		await waitFor(() => firstListenerOutput.join("").includes("one"));
		const persisted = firstManager.listSummaries();
		clients[0]?.close();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const secondManager = new TerminalSessionManager({ ptyBackend: backendFor(await connect()), namespace: "ws" });
		secondManager.hydrateFromRecord(Object.fromEntries(persisted.map((summary) => [summary.taskId, summary])));

		expect(await secondManager.reattachDetachedSessions()).toBe(1);

		const summary = secondManager.getSummary("__home_terminal__");
		expect(summary).toEqual(
			expect.objectContaining({ state: "running", pid: started.pid, startedAt: started.startedAt }),
		);
		expect((await secondManager.getRestoreSnapshot("__home_terminal__"))?.snapshot).toContain("one");
		const secondListenerOutput: string[] = [];
		secondManager.attach("__home_terminal__", { onOutput: (chunk) => secondListenerOutput.push(chunk.toString()) });
		secondManager.writeInput("__home_terminal__", Buffer.from("x\r"));
		await waitFor(() => secondListenerOutput.join("").includes("two:x"));
		secondManager.stopTaskSession("__home_terminal__");
		await waitFor(() => secondManager.getSummary("__home_terminal__")?.state === "idle");
	});

	it("keeps an agent's review state across the takeover and applies an exit after it", async () => {
		const firstManager = new TerminalSessionManager({ ptyBackend: backendFor(await connect()), namespace: "ws" });
		await firstManager.startTaskSession({
			taskId: "task-1",
			agentId: "claude",
			binary: BASH,
			args: ["-c", "echo working; read line; exit 0"],
			cwd: directory,
			prompt: "do the thing",
		});
		firstManager.transitionToReview("task-1", "hook");
		expect(firstManager.getSummary("task-1")?.state).toBe("awaiting_review");
		const persisted = firstManager.listSummaries();
		clients[0]?.close();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const secondManager = new TerminalSessionManager({ ptyBackend: backendFor(await connect()), namespace: "ws" });
		secondManager.hydrateFromRecord(Object.fromEntries(persisted.map((summary) => [summary.taskId, summary])));
		await secondManager.reattachDetachedSessions();

		expect(secondManager.getSummary("task-1")).toEqual(
			expect.objectContaining({ state: "awaiting_review", reviewReason: "hook", agentId: "claude" }),
		);

		secondManager.writeInput("task-1", Buffer.from("\r"));

		await waitFor(() => secondManager.getSummary("task-1")?.reviewReason === "exit");
		expect(secondManager.getSummary("task-1")).toEqual(
			expect.objectContaining({ state: "awaiting_review", exitCode: 0, pid: null }),
		);
	});

	it("with spawning in the host off, starts PTYs in process but still finds sessions left in the host", async () => {
		const earlierRuntime = await connect();
		await earlierRuntime.spawn({
			namespace: "ws",
			taskId: "left-behind",
			binary: BASH,
			args: ["-c", "sleep 30"],
			cwd: directory,
			env: process.env,
			cols: 80,
			rows: 24,
			meta: null,
		});
		earlierRuntime.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const backend = new PtyHostBackend({
			socketPath,
			hostScriptPath: join(directory, "missing-pty-host.js"),
			logPath: join(directory, "pty-host.log"),
			spawnInHost: false,
			warn: () => {},
		});

		const spawned = await backend.spawn({
			namespace: "ws",
			taskId: "new",
			binary: BASH,
			args: ["-c", "sleep 30"],
			cwd: directory,
			env: process.env,
			cols: 80,
			rows: 24,
			meta: null,
		});

		expect(spawned).toBeInstanceOf(PtySession);
		spawned.stop();
		expect((await backend.listDetachedSessions("ws")).map((session) => session.taskId)).toEqual(["left-behind"]);
	});

	it("refuses a socket directory other users can enter and runs PTYs in process instead", async () => {
		const sharedDirectory = join(directory, "shared");
		mkdirSync(sharedDirectory);
		chmodSync(sharedDirectory, 0o777);
		const warn = vi.fn();
		const backend = new PtyHostBackend({
			socketPath: join(sharedDirectory, "host.sock"),
			hostScriptPath: join(directory, "missing-pty-host.js"),
			logPath: join(directory, "pty-host.log"),
			spawnInHost: true,
			warn,
		});

		const spawned = await backend.spawn({
			namespace: "ws",
			taskId: "task",
			binary: BASH,
			args: ["-c", "sleep 30"],
			cwd: directory,
			env: process.env,
			cols: 80,
			rows: 24,
			meta: null,
		});

		expect(spawned).toBeInstanceOf(PtySession);
		spawned.stop();
		expect(await backend.listDetachedSessions(null)).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("must be a directory owned by this user"));
	});

	it("does not take over another namespace's sessions", async () => {
		const firstManager = new TerminalSessionManager({ ptyBackend: backendFor(await connect()), namespace: "ws-a" });
		await firstManager.startShellSession({
			taskId: "shell",
			cwd: directory,
			binary: BASH,
			args: ["-c", "sleep 30"],
		});
		clients[0]?.close();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const otherManager = new TerminalSessionManager({ ptyBackend: backendFor(await connect()), namespace: "ws-b" });

		expect(await otherManager.reattachDetachedSessions()).toBe(0);
		expect(otherManager.getSummary("shell")).toBeNull();
	});
});
