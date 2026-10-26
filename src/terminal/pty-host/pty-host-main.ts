// sked fork: entry point of the detached PTY host (dist/pty-host.js).
// Usage: node pty-host.js <socket path> <log path>. Started by the runtime, never by hand.
import { appendFileSync } from "node:fs";

import { PtyHostServer } from "./pty-host-server";

const [socketPath, logPath] = process.argv.slice(2);

function log(message: string): void {
	if (!logPath) {
		return;
	}
	try {
		appendFileSync(logPath, `${new Date().toISOString()} [pty-host ${process.pid}] ${message}\n`);
	} catch {
		// Logging must never take the host down.
	}
}

if (!socketPath) {
	log("Missing socket path argument.");
	process.exit(2);
}

// The host outlives the runtime and the terminal that started it. A hangup must not take the
// agents' PTYs down with it, and an unexpected error in one session must not kill the others.
process.on("SIGHUP", () => {
	log("Ignoring SIGHUP.");
});
process.on("uncaughtException", (error) => {
	log(`Uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
process.on("unhandledRejection", (reason) => {
	log(`Unhandled rejection: ${String(reason)}`);
});

const server = new PtyHostServer({
	socketPath,
	log,
	onIdle: () => {
		log("No runtime and no running sessions; exiting.");
		void server.close().finally(() => {
			process.exit(0);
		});
	},
});

const listening = await server.listen();
if (!listening) {
	log(`Another PTY host already serves ${socketPath}; exiting.`);
	process.exit(0);
}
log(`Listening on ${socketPath}.`);
