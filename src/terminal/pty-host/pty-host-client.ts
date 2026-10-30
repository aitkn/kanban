// sked fork: the runtime's connection to its detached PTY host.
import { createConnection, type Socket } from "node:net";

import type {
	AttachedPtySession,
	DetachedPtySession,
	PtyBackendSpawnRequest,
	PtyProcess,
	PtyProcessCallbacks,
} from "../pty-backend";
import {
	encodePtyHostFrame,
	PTY_HOST_PROTOCOL_VERSION,
	type PtyHostClientMessage,
	type PtyHostExit,
	PtyHostFrameDecoder,
	type PtyHostServerMessage,
} from "./pty-host-protocol";

const HELLO_TIMEOUT_MS = 2_000;

type ServerMessageOf<T extends PtyHostServerMessage["type"]> = Extract<PtyHostServerMessage, { type: T }>;

interface PendingRequest {
	resolve: (message: PtyHostServerMessage) => void;
	reject: (error: Error) => void;
}

// A PTY owned by the host. Output that arrives before the session manager has stored this process
// is held back one macrotask, the same guarantee an in-process PtySession gives by spawning synchronously.
export class PtyHostProcess implements PtyProcess {
	private interrupted = false;
	private exited = false;
	private deliveryReady = false;
	private readonly queued: Array<{ chunk?: Buffer; exit?: PtyHostExit | null }> = [];

	constructor(
		private readonly client: PtyHostClient,
		readonly id: string,
		readonly pid: number,
		private readonly callbacks: PtyProcessCallbacks,
	) {}

	write(data: string | Buffer): void {
		if (this.exited) {
			return;
		}
		this.client.send({ type: "write", id: this.id }, typeof data === "string" ? Buffer.from(data, "utf8") : data);
	}

	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void {
		if (this.exited) {
			return;
		}
		this.client.send({ type: "resize", id: this.id, cols, rows, pixelWidth, pixelHeight });
	}

	pause(): void {
		if (!this.exited) {
			this.client.send({ type: "pause", id: this.id });
		}
	}

	resume(): void {
		if (!this.exited) {
			this.client.send({ type: "resume", id: this.id });
		}
	}

	stop(options?: { interrupted?: boolean }): void {
		if (options?.interrupted) {
			this.interrupted = true;
		}
		if (!this.exited) {
			this.client.send({ type: "kill", id: this.id });
		}
	}

	wasInterrupted(): boolean {
		return this.interrupted;
	}

	startDelivery(): void {
		setImmediate(() => {
			this.deliveryReady = true;
			for (const item of this.queued.splice(0)) {
				if (item.chunk) {
					this.callbacks.onData?.(item.chunk);
				} else {
					this.finish(item.exit ?? null);
				}
			}
		});
	}

	deliverData(chunk: Buffer): void {
		if (this.exited) {
			return;
		}
		if (!this.deliveryReady) {
			this.queued.push({ chunk });
			return;
		}
		this.callbacks.onData?.(chunk);
	}

	// exit is null when the host connection was lost: the process is gone from this runtime's view.
	deliverExit(exit: PtyHostExit | null): void {
		if (exit === null) {
			this.interrupted = true;
		}
		if (!this.deliveryReady) {
			this.queued.push({ exit });
			return;
		}
		this.finish(exit);
	}

	private finish(exit: PtyHostExit | null): void {
		if (this.exited) {
			return;
		}
		this.exited = true;
		this.client.forget(this.id);
		this.callbacks.onExit?.({ exitCode: exit?.exitCode ?? null, signal: exit?.signal });
	}
}

export class PtyHostClient {
	private readonly decoder = new PtyHostFrameDecoder<PtyHostServerMessage>();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly processes = new Map<string, PtyHostProcess>();
	// Frames for a session whose spawn or attach reply is still being awaited.
	private readonly earlyFrames = new Map<string, Array<{ chunk?: Buffer; exit?: PtyHostExit | null }>>();
	private nextRequestId = 1;
	private closed = false;

	private constructor(
		private readonly socket: Socket,
		private readonly onClose: () => void,
	) {
		socket.on("data", (chunk: Buffer) => {
			let frames: ReturnType<typeof this.decoder.push>;
			try {
				frames = this.decoder.push(chunk);
			} catch {
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				this.handleMessage(frame.header, frame.payload);
			}
		});
		socket.on("error", () => {
			// The close handler does the cleanup.
		});
		socket.on("close", () => {
			this.handleClose();
		});
	}

	// Resolves null when no compatible host is listening on socketPath.
	static async connect(socketPath: string, onClose: () => void = () => {}): Promise<PtyHostClient | null> {
		const socket = await new Promise<Socket | null>((resolve) => {
			const candidate = createConnection(socketPath);
			candidate.once("connect", () => {
				candidate.removeAllListeners("error");
				resolve(candidate);
			});
			candidate.once("error", () => {
				resolve(null);
			});
		});
		if (!socket) {
			return null;
		}
		const client = new PtyHostClient(socket, onClose);
		try {
			const hello = await client.request<"hello">(
				{ type: "hello", version: PTY_HOST_PROTOCOL_VERSION },
				HELLO_TIMEOUT_MS,
			);
			if (hello.version !== PTY_HOST_PROTOCOL_VERSION) {
				client.close();
				return null;
			}
		} catch {
			client.close();
			return null;
		}
		return client;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	close(): void {
		this.socket.destroy();
	}

	send(message: PtyHostClientMessage, payload?: Buffer): void {
		if (this.closed) {
			return;
		}
		this.socket.write(encodePtyHostFrame(message, payload));
	}

	forget(id: string): void {
		this.processes.delete(id);
	}

	async spawn(request: PtyBackendSpawnRequest): Promise<PtyHostProcess> {
		const reply = await this.request<"spawned">((requestId) => ({
			type: "spawn",
			requestId,
			namespace: request.namespace,
			taskId: request.taskId,
			binary: request.binary,
			args: typeof request.args === "string" ? [request.args] : (request.args ?? []),
			cwd: request.cwd,
			env: request.env ?? {},
			cols: request.cols,
			rows: request.rows,
			meta: request.meta,
		}));
		return this.register(
			new PtyHostProcess(this, reply.id, reply.pid, {
				onData: request.onData,
				onExit: request.onExit,
			}),
		);
	}

	async listDetachedSessions(namespace: string | null): Promise<DetachedPtySession[]> {
		const reply = await this.request<"listed">((requestId) => ({ type: "list", requestId, namespace }));
		return reply.sessions.map((session) => ({
			id: session.id,
			namespace: session.namespace,
			taskId: session.taskId,
			pid: session.pid,
			cols: session.cols,
			rows: session.rows,
			exit: session.exit,
			meta: session.meta,
		}));
	}

	async attach(id: string, callbacks: PtyProcessCallbacks): Promise<AttachedPtySession> {
		const reply = await this.request<"attached">((requestId) => ({ type: "attach", requestId, id }));
		const process = this.register(new PtyHostProcess(this, id, reply.pid, callbacks));
		return { process, snapshot: reply.snapshot, cols: reply.cols, rows: reply.rows };
	}

	private register(process: PtyHostProcess): PtyHostProcess {
		this.processes.set(process.id, process);
		for (const frame of this.earlyFrames.get(process.id) ?? []) {
			if (frame.chunk) {
				process.deliverData(frame.chunk);
			} else {
				process.deliverExit(frame.exit ?? null);
			}
		}
		this.earlyFrames.delete(process.id);
		process.startDelivery();
		return process;
	}

	private routeFrame(id: string, frame: { chunk?: Buffer; exit?: PtyHostExit | null }): void {
		const process = this.processes.get(id);
		if (!process) {
			const early = this.earlyFrames.get(id) ?? [];
			early.push(frame);
			this.earlyFrames.set(id, early);
			return;
		}
		if (frame.chunk) {
			process.deliverData(frame.chunk);
		} else {
			process.deliverExit(frame.exit ?? null);
		}
	}

	private request<T extends "hello" | "spawned" | "listed" | "attached">(
		build: PtyHostClientMessage | ((requestId: number) => PtyHostClientMessage),
		timeoutMs?: number,
	): Promise<ServerMessageOf<T>> {
		if (this.closed) {
			return Promise.reject(new Error("The PTY host connection is closed."));
		}
		// hello has no request id; it is the only message in flight while connecting.
		const requestId = typeof build === "function" ? this.nextRequestId++ : 0;
		const message = typeof build === "function" ? build(requestId) : build;
		return new Promise<ServerMessageOf<T>>((resolve, reject) => {
			let timer: NodeJS.Timeout | null = null;
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					this.pending.delete(requestId);
					reject(new Error(`The PTY host did not answer ${message.type} within ${timeoutMs}ms.`));
				}, timeoutMs);
			}
			this.pending.set(requestId, {
				resolve: (reply) => {
					if (timer) {
						clearTimeout(timer);
					}
					resolve(reply as ServerMessageOf<T>);
				},
				reject: (error) => {
					if (timer) {
						clearTimeout(timer);
					}
					reject(error);
				},
			});
			this.send(message);
		});
	}

	private settle(requestId: number, message: PtyHostServerMessage): void {
		const pending = this.pending.get(requestId);
		if (!pending) {
			return;
		}
		this.pending.delete(requestId);
		if (message.type === "error") {
			pending.reject(new Error(message.message));
			return;
		}
		pending.resolve(message);
	}

	private handleMessage(message: PtyHostServerMessage, payload: Buffer): void {
		switch (message.type) {
			case "hello":
				this.settle(0, message);
				return;
			case "spawned":
			case "listed":
			case "attached":
			case "error":
				this.settle(message.requestId, message);
				return;
			case "data":
				this.routeFrame(message.id, { chunk: payload });
				return;
			case "exit":
				this.routeFrame(message.id, { exit: message.exit });
				return;
			case "detached":
				this.routeFrame(message.id, { exit: null });
				return;
		}
	}

	private handleClose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const error = new Error("The PTY host connection closed.");
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
		this.earlyFrames.clear();
		for (const process of [...this.processes.values()]) {
			process.deliverExit(null);
		}
		this.processes.clear();
		this.onClose();
	}
}
