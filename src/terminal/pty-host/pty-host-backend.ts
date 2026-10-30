// sked fork: runs task and shell PTYs in a detached host process, so restarting the runtime
// (with --skip-shutdown-cleanup) or a runtime crash leaves the agents running. The runtime
// reattaches to them on startup. With KANBAN_PTY_HOST=0 new PTYs run inside the runtime as upstream
// does, but sessions an earlier runtime left in a host are still reattached rather than left unseen.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getKanbanRuntimePort } from "../../core/runtime-endpoint";
import { getRuntimeHomePath } from "../../state/workspace-state";
import {
	type AttachedPtySession,
	type DetachedPtySession,
	inProcessPtyBackend,
	type PtyBackend,
	type PtyBackendSpawnRequest,
	type PtyProcess,
	type PtyProcessCallbacks,
} from "../pty-backend";
import { PtyHostClient } from "./pty-host-client";
import { PTY_HOST_PROTOCOL_VERSION } from "./pty-host-protocol";

const HOST_START_TIMEOUT_MS = 5_000;
const HOST_START_POLL_MS = 100;

// One host per runtime home and port, so a sandbox runtime never shares agents with the real one.
// The path stays short because Unix socket paths are limited to about 100 bytes.
export function getPtyHostSocketPath(runtimeHomePath: string, port: number): string {
	const scope = createHash("sha256")
		.update(`${runtimeHomePath}\0${port}\0${PTY_HOST_PROTOCOL_VERSION}`)
		.digest("hex")
		.slice(0, 16);
	const user = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `kanban-pty-${user}`, `${scope}.sock`);
}

// The socket directory sits in a shared temp dir. Another user could create it first and plant a
// socket that receives every spawn request, environment included, so only a directory this user
// owns and nobody else can enter is trusted.
function ensurePrivateDirectory(directory: string): boolean {
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const stats = lstatSync(directory);
		const uid = typeof process.getuid === "function" ? process.getuid() : null;
		return stats.isDirectory() && (uid === null || stats.uid === uid) && (stats.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

interface PtyHostBackendOptions {
	socketPath: string;
	hostScriptPath: string;
	logPath: string;
	// false: start new PTYs inside the runtime and only take over sessions already in a host.
	spawnInHost: boolean;
	warn: (message: string) => void;
}

export class PtyHostBackend implements PtyBackend {
	private client: PtyHostClient | null = null;
	// Connection attempts run one after another so concurrent callers never start two hosts.
	private connectQueue: Promise<PtyHostClient | null> = Promise.resolve(null);
	private warnedFallback = false;
	private warnedDirectory = false;

	constructor(private readonly options: PtyHostBackendOptions) {}

	async spawn(request: PtyBackendSpawnRequest): Promise<PtyProcess> {
		if (!this.options.spawnInHost) {
			return await inProcessPtyBackend.spawn(request);
		}
		const client = await this.getClient({ startIfMissing: true });
		if (!client) {
			if (!this.warnedFallback) {
				this.warnedFallback = true;
				this.options.warn(
					`Could not start the PTY host (log: ${this.options.logPath}). Terminals run inside the runtime and will stop when it exits.`,
				);
			}
			return await inProcessPtyBackend.spawn(request);
		}
		return await client.spawn(request);
	}

	async listDetachedSessions(namespace: string | null): Promise<DetachedPtySession[]> {
		const client = await this.getClient({ startIfMissing: false });
		return client ? await client.listDetachedSessions(namespace) : [];
	}

	async attach(id: string, callbacks: PtyProcessCallbacks): Promise<AttachedPtySession> {
		const client = await this.getClient({ startIfMissing: false });
		if (!client) {
			throw new Error(`PTY session ${id} cannot be attached: the PTY host is not running.`);
		}
		return await client.attach(id, callbacks);
	}

	private async getClient(options: { startIfMissing: boolean }): Promise<PtyHostClient | null> {
		if (this.client && !this.client.isClosed) {
			return this.client;
		}
		this.connectQueue = this.connectQueue.then(async () => {
			if (this.client && !this.client.isClosed) {
				return this.client;
			}
			return await this.connect(options.startIfMissing);
		});
		return await this.connectQueue;
	}

	private async connect(startIfMissing: boolean): Promise<PtyHostClient | null> {
		if (!ensurePrivateDirectory(dirname(this.options.socketPath))) {
			if (!this.warnedDirectory) {
				this.warnedDirectory = true;
				this.options.warn(
					`Not using the PTY host: ${dirname(this.options.socketPath)} must be a directory owned by this user with mode 700.`,
				);
			}
			return null;
		}
		const onClose = () => {
			this.client = null;
		};
		let client = await PtyHostClient.connect(this.options.socketPath, onClose);
		if (!client && startIfMissing) {
			this.startHost();
			const deadline = Date.now() + HOST_START_TIMEOUT_MS;
			while (!client && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, HOST_START_POLL_MS));
				client = await PtyHostClient.connect(this.options.socketPath, onClose);
			}
		}
		this.client = client;
		return client;
	}

	private startHost(): void {
		// detached puts the host in its own session: Ctrl+C or closing the runtime's terminal does not reach it.
		const host = spawn(
			process.execPath,
			[this.options.hostScriptPath, this.options.socketPath, this.options.logPath],
			{
				cwd: "/",
				detached: true,
				stdio: "ignore",
				env: process.env,
			},
		);
		host.on("error", () => {
			// Reported through the connect timeout and the fallback warning.
		});
		host.unref();
	}
}

let runtimePtyBackend: PtyBackend | null = null;

// The backend every workspace's TerminalSessionManager uses in the CLI runtime.
export function getRuntimePtyBackend(warn: (message: string) => void): PtyBackend {
	if (runtimePtyBackend) {
		return runtimePtyBackend;
	}
	const hostScriptPath = fileURLToPath(new URL("./pty-host.js", import.meta.url));
	if (process.platform === "win32" || !existsSync(hostScriptPath)) {
		runtimePtyBackend = inProcessPtyBackend;
		return runtimePtyBackend;
	}
	const runtimeHomePath = getRuntimeHomePath();
	const port = getKanbanRuntimePort();
	runtimePtyBackend = new PtyHostBackend({
		socketPath: getPtyHostSocketPath(runtimeHomePath, port),
		hostScriptPath,
		logPath: join(runtimeHomePath, `pty-host-${port}.log`),
		spawnInHost: process.env.KANBAN_PTY_HOST !== "0",
		warn,
	});
	return runtimePtyBackend;
}
