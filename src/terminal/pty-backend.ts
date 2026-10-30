import type { PtyHostExit } from "./pty-host/pty-host-protocol";
import { type PtyExitEvent, PtySession, type SpawnPtySessionRequest } from "./pty-session";

// A running PTY process as TerminalSessionManager drives it. PtySession implements it in process;
// PtyHostProcess implements it for a process owned by the detached PTY host.
export interface PtyProcess {
	readonly pid: number;
	write(data: string | Buffer): void;
	resize(cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): void;
	pause(): void;
	resume(): void;
	stop(options?: { interrupted?: boolean }): void;
	wasInterrupted(): boolean;
}

export interface PtyProcessCallbacks {
	onData?: (chunk: Buffer) => void;
	onExit?: (event: PtyExitEvent) => void;
}

export interface PtyBackendSpawnRequest extends SpawnPtySessionRequest {
	namespace: string;
	taskId: string;
	// Opaque to the backend. The PTY host stores it and hands it back when the session is reattached.
	meta: unknown;
}

export interface DetachedPtySession {
	id: string;
	namespace: string;
	taskId: string;
	pid: number;
	cols: number;
	rows: number;
	exit: PtyHostExit | null;
	meta: unknown;
}

// The snapshot is the screen up to the attach; later output and the exit, if the session has
// already exited, arrive through the callbacks.
export interface AttachedPtySession {
	process: PtyProcess;
	snapshot: string;
	cols: number;
	rows: number;
}

export interface PtyBackend {
	spawn(request: PtyBackendSpawnRequest): Promise<PtyProcess>;
	// Sessions that outlived a previous runtime and are not attached to this one; all namespaces for null.
	listDetachedSessions(namespace: string | null): Promise<DetachedPtySession[]>;
	attach(id: string, callbacks: PtyProcessCallbacks): Promise<AttachedPtySession>;
}

export const inProcessPtyBackend: PtyBackend = {
	async spawn(request) {
		return PtySession.spawn(request);
	},
	async listDetachedSessions() {
		return [];
	},
	async attach(id) {
		throw new Error(`PTY session ${id} cannot be attached: terminals run inside this process.`);
	},
};
