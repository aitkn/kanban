// sked fork: the detached PTY host. It owns agent and shell PTYs so they keep running when the Kanban
// runtime restarts or crashes, keeps a terminal mirror of each so a reconnecting runtime can restore
// the screen, and serves one runtime at a time over a Unix socket.
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import { PtySession } from "../pty-session";
import { TerminalStateMirror } from "../terminal-state-mirror";
import {
	encodePtyHostFrame,
	PTY_HOST_PROTOCOL_VERSION,
	type PtyHostClientMessage,
	type PtyHostExit,
	PtyHostFrameDecoder,
	type PtyHostServerMessage,
	type PtyHostSessionInfo,
	type PtyHostSpawnFields,
} from "./pty-host-protocol";

export const PTY_HOST_IDLE_EXIT_MS = 30_000;
// Output is sent in batches like the runtime's own websocket output. An idle host reads every small
// PTY write on its own, and the runtime scans each chunk it receives (trust prompts, transitions),
// so forwarding them one by one cost the runtime about three times the CPU of an in-process PTY.
const OUTPUT_BATCH_INTERVAL_MS = 4;

interface HostConnection {
	socket: Socket;
	helloReceived: boolean;
}

interface HostSession {
	id: string;
	namespace: string;
	taskId: string;
	process: PtySession;
	cols: number;
	rows: number;
	mirror: TerminalStateMirror;
	meta: unknown;
	exit: PtyHostExit | null;
	owner: HostConnection | null;
	// Output received while an attach snapshot is being taken; sent right after the snapshot.
	pendingOutput: Buffer[] | null;
	outputBatch: Buffer[];
	outputFlushTimer: NodeJS.Timeout | null;
	paused: boolean;
}

export interface PtyHostServerOptions {
	socketPath: string;
	idleExitMs?: number;
	onIdle?: () => void;
	log?: (message: string) => void;
}

function isSocketAlive(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createConnection(socketPath);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => {
			resolve(false);
		});
	});
}

export class PtyHostServer {
	private readonly sessions = new Map<string, HostSession>();
	private readonly connections = new Set<HostConnection>();
	private readonly server: Server;
	private idleTimer: NodeJS.Timeout | null = null;
	private readonly idleExitMs: number;
	private readonly log: (message: string) => void;

	constructor(private readonly options: PtyHostServerOptions) {
		this.idleExitMs = options.idleExitMs ?? PTY_HOST_IDLE_EXIT_MS;
		this.log = options.log ?? (() => {});
		this.server = createServer((socket) => {
			this.handleConnection(socket);
		});
	}

	// Resolves false when another live host already serves socketPath.
	async listen(): Promise<boolean> {
		if (existsSync(this.options.socketPath)) {
			if (await isSocketAlive(this.options.socketPath)) {
				return false;
			}
			unlinkSync(this.options.socketPath);
		}
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.options.socketPath, () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		this.scheduleIdleCheck();
		return true;
	}

	// Stops serving. With killSessions the PTYs are terminated too (tests); otherwise they are left as is.
	async close(options?: { killSessions?: boolean }): Promise<void> {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (options?.killSessions) {
			for (const session of this.sessions.values()) {
				if (!session.exit) {
					session.process.stop();
				}
				session.mirror.dispose();
			}
			this.sessions.clear();
		}
		for (const connection of this.connections) {
			connection.socket.destroy();
		}
		this.connections.clear();
		await new Promise<void>((resolve) => {
			this.server.close(() => resolve());
		});
	}

	get liveSessionCount(): number {
		let count = 0;
		for (const session of this.sessions.values()) {
			if (!session.exit) {
				count += 1;
			}
		}
		return count;
	}

	private handleConnection(socket: Socket): void {
		const connection: HostConnection = { socket, helloReceived: false };
		this.connections.add(connection);
		this.cancelIdleCheck();
		const decoder = new PtyHostFrameDecoder<PtyHostClientMessage>();
		socket.on("data", (chunk: Buffer) => {
			let frames: ReturnType<typeof decoder.push>;
			try {
				frames = decoder.push(chunk);
			} catch (error) {
				this.log(`Dropping client after a malformed frame: ${String(error)}`);
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				try {
					this.handleMessage(connection, frame.header, frame.payload);
				} catch (error) {
					this.log(`Failed to handle ${frame.header.type}: ${String(error)}`);
				}
			}
		});
		socket.on("error", () => {
			// The close handler does the cleanup.
		});
		socket.on("close", () => {
			this.handleDisconnect(connection);
		});
	}

	private handleDisconnect(connection: HostConnection): void {
		this.connections.delete(connection);
		for (const session of this.sessions.values()) {
			if (session.owner !== connection) {
				continue;
			}
			session.owner = null;
			session.pendingOutput = null;
			this.dropOutputBatch(session);
			// Nobody is reading for this session any more: never leave the agent blocked on a paused PTY.
			if (session.paused && !session.exit) {
				session.paused = false;
				session.process.resume();
			}
		}
		this.scheduleIdleCheck();
	}

	private send(connection: HostConnection, message: PtyHostServerMessage, payload?: Buffer): void {
		if (connection.socket.destroyed) {
			return;
		}
		connection.socket.write(encodePtyHostFrame(message, payload));
	}

	private handleMessage(connection: HostConnection, message: PtyHostClientMessage, payload: Buffer): void {
		if (message.type === "hello") {
			connection.helloReceived = true;
			this.send(connection, { type: "hello", version: PTY_HOST_PROTOCOL_VERSION, pid: process.pid });
			return;
		}
		if (!connection.helloReceived) {
			connection.socket.destroy();
			return;
		}
		switch (message.type) {
			case "spawn":
				this.spawnSession(connection, message.requestId, message);
				return;
			case "write":
				this.ownedSession(connection, message.id)?.process.write(payload);
				return;
			case "resize": {
				const session = this.ownedSession(connection, message.id);
				if (!session || session.exit) {
					return;
				}
				session.process.resize(message.cols, message.rows, message.pixelWidth, message.pixelHeight);
				session.mirror.resize(message.cols, message.rows);
				session.cols = message.cols;
				session.rows = message.rows;
				return;
			}
			case "pause": {
				const session = this.ownedSession(connection, message.id);
				if (session && !session.exit) {
					session.paused = true;
					session.process.pause();
				}
				return;
			}
			case "resume": {
				const session = this.ownedSession(connection, message.id);
				if (session && !session.exit) {
					session.paused = false;
					session.process.resume();
				}
				return;
			}
			case "kill": {
				const session = this.sessions.get(message.id);
				if (session && !session.exit) {
					session.process.stop();
				}
				return;
			}
			case "list":
				this.send(connection, {
					type: "listed",
					requestId: message.requestId,
					sessions: this.listSessions(message.namespace),
				});
				return;
			case "attach":
				this.attachSession(connection, message.requestId, message.id);
				return;
		}
	}

	private ownedSession(connection: HostConnection, id: string): HostSession | null {
		const session = this.sessions.get(id);
		return session && session.owner === connection ? session : null;
	}

	private listSessions(namespace: string | null): PtyHostSessionInfo[] {
		const sessions: PtyHostSessionInfo[] = [];
		for (const session of this.sessions.values()) {
			if (namespace !== null && session.namespace !== namespace) {
				continue;
			}
			// A session attached to another live connection is not up for grabs.
			if (session.owner && !session.owner.socket.destroyed) {
				continue;
			}
			sessions.push({
				id: session.id,
				namespace: session.namespace,
				taskId: session.taskId,
				pid: session.process.pid,
				cols: session.cols,
				rows: session.rows,
				exit: session.exit,
				meta: session.meta,
			});
		}
		return sessions;
	}

	private spawnSession(connection: HostConnection, requestId: number, fields: PtyHostSpawnFields): void {
		const id = randomUUID();
		const mirror = new TerminalStateMirror(fields.cols, fields.rows);
		let session: HostSession | null = null;
		let ptyProcess: PtySession;
		try {
			ptyProcess = PtySession.spawn({
				binary: fields.binary,
				args: fields.args,
				cwd: fields.cwd,
				env: fields.env,
				cols: fields.cols,
				rows: fields.rows,
				onData: (chunk) => {
					if (session) {
						this.handleOutput(session, chunk);
					}
				},
				onExit: (event) => {
					if (session) {
						this.handleExit(session, { exitCode: event.exitCode ?? -1, signal: event.signal });
					}
				},
			});
		} catch (error) {
			mirror.dispose();
			this.send(connection, {
				type: "error",
				requestId,
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		session = {
			id,
			namespace: fields.namespace,
			taskId: fields.taskId,
			process: ptyProcess,
			cols: fields.cols,
			rows: fields.rows,
			mirror,
			meta: fields.meta,
			exit: null,
			owner: connection,
			pendingOutput: null,
			outputBatch: [],
			outputFlushTimer: null,
			paused: false,
		};
		this.sessions.set(id, session);
		this.log(`Spawned ${fields.binary} for ${fields.namespace}/${fields.taskId} as pid ${ptyProcess.pid}.`);
		this.send(connection, { type: "spawned", requestId, id, pid: ptyProcess.pid });
	}

	private handleOutput(session: HostSession, chunk: Buffer): void {
		session.mirror.applyOutput(chunk);
		const owner = session.owner;
		if (!owner) {
			return;
		}
		if (session.pendingOutput) {
			session.pendingOutput.push(chunk);
			return;
		}
		session.outputBatch.push(chunk);
		if (session.outputFlushTimer === null) {
			session.outputFlushTimer = setTimeout(() => {
				this.flushOutputBatch(session);
			}, OUTPUT_BATCH_INTERVAL_MS);
		}
	}

	private flushOutputBatch(session: HostSession): void {
		if (session.outputFlushTimer !== null) {
			clearTimeout(session.outputFlushTimer);
			session.outputFlushTimer = null;
		}
		const chunks = session.outputBatch;
		session.outputBatch = [];
		if (chunks.length > 0 && session.owner) {
			this.send(session.owner, { type: "data", id: session.id }, Buffer.concat(chunks));
		}
	}

	// The mirror already holds this output, so a later attach still gets it in its snapshot.
	private dropOutputBatch(session: HostSession): void {
		if (session.outputFlushTimer !== null) {
			clearTimeout(session.outputFlushTimer);
			session.outputFlushTimer = null;
		}
		session.outputBatch = [];
	}

	private handleExit(session: HostSession, exit: PtyHostExit): void {
		session.exit = exit;
		this.log(`Session ${session.namespace}/${session.taskId} exited with ${exit.exitCode}.`);
		const owner = session.owner;
		if (owner && !session.pendingOutput) {
			this.flushOutputBatch(session);
			this.send(owner, { type: "exit", id: session.id, exit });
			this.removeSession(session);
			return;
		}
		// Kept with its final screen until a runtime attaches to it.
		this.scheduleIdleCheck();
	}

	private attachSession(connection: HostConnection, requestId: number, id: string): void {
		const session = this.sessions.get(id);
		if (!session) {
			this.send(connection, { type: "error", requestId, message: `Unknown PTY session ${id}.` });
			return;
		}
		const previousOwner = session.owner;
		if (previousOwner && previousOwner !== connection) {
			this.send(previousOwner, { type: "detached", id });
		}
		this.dropOutputBatch(session);
		session.owner = connection;
		session.pendingOutput = [];
		void session.mirror.getSnapshot().then((snapshot) => {
			if (session.owner !== connection) {
				return;
			}
			const pendingOutput = session.pendingOutput ?? [];
			session.pendingOutput = null;
			this.send(connection, {
				type: "attached",
				requestId,
				id,
				pid: session.process.pid,
				snapshot: snapshot.snapshot,
				cols: snapshot.cols,
				rows: snapshot.rows,
			});
			for (const chunk of pendingOutput) {
				this.send(connection, { type: "data", id }, chunk);
			}
			if (session.exit) {
				this.send(connection, { type: "exit", id, exit: session.exit });
				this.removeSession(session);
			}
		});
	}

	private removeSession(session: HostSession): void {
		if (this.sessions.get(session.id) !== session) {
			return;
		}
		this.sessions.delete(session.id);
		this.dropOutputBatch(session);
		session.mirror.dispose();
		this.scheduleIdleCheck();
	}

	private cancelIdleCheck(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	// The host exits once no runtime is connected and no PTY is running, so it never lingers on its own.
	private scheduleIdleCheck(): void {
		this.cancelIdleCheck();
		if (this.connections.size > 0 || this.liveSessionCount > 0) {
			return;
		}
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			if (this.connections.size === 0 && this.liveSessionCount === 0) {
				this.options.onIdle?.();
			}
		}, this.idleExitMs);
		this.idleTimer.unref();
	}
}
