import { open } from "node:fs/promises";

import { parseClaudeTaskNotifications } from "../commands/hook-events/claude-hook-events";
import type { RuntimeHookBackgroundWork, RuntimeTaskHookActivity } from "../core/api-contract";

// sked fork: keeps a card in In Progress while the agent's turn ended only to wait for background work.
// The agent normally resumes by itself when the work finishes, and its next Stop decides the column.
// The re-check covers the case where it never does: a task the user stops from Claude's /tasks
// view is recorded in the transcript, but no turn and no hook follows.

/** How often a held card's transcript is re-checked. One stat plus the bytes appended since the last check. */
const RECHECK_INTERVAL_MS = 15_000;
/** How long a finished task's notification may sit unconsumed before the card moves to Review. */
const SETTLE_GRACE_MS = 10_000;
/** Upper bound on one re-check read; a held agent is idle, so its transcript barely grows. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface BackgroundWorkHoldTarget {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
}

export interface TranscriptChunk {
	text: string;
	nextOffset: number;
}

export interface BackgroundWorkHoldsOptions {
	/** Is the session that started the hold still the running one? */
	isSessionCurrent: (target: BackgroundWorkHoldTarget, pid: number | null) => Promise<boolean>;
	/** Outstanding work finished without the agent resuming: move the card to Review. */
	onSettled: (target: BackgroundWorkHoldTarget, reviewMetadata: Partial<RuntimeTaskHookActivity> | undefined) => void;
	/** Some outstanding work finished, some is left. */
	onProgress: (target: BackgroundWorkHoldTarget, outstandingCount: number) => void;
	readTranscriptFrom?: (path: string, offset: number) => Promise<TranscriptChunk | null>;
	now?: () => number;
	recheckIntervalMs?: number;
	settleGraceMs?: number;
}

interface BackgroundWorkHold {
	target: BackgroundWorkHoldTarget;
	pid: number | null;
	outstanding: Set<string>;
	transcriptPath: string;
	offset: number;
	lastFinishedAt: number;
	reviewMetadata: Partial<RuntimeTaskHookActivity> | undefined;
	timer: NodeJS.Timeout | null;
}

export function formatBackgroundWorkActivity(outstandingCount: number): string {
	return `Waiting on background job (${outstandingCount})`;
}

/** Reads the complete lines appended to a file since `offset`. Returns null when the file is unreadable. */
export async function readTranscriptFrom(path: string, offset: number): Promise<TranscriptChunk | null> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(path, "r");
		const { size } = await handle.stat();
		const start = size < offset ? size : offset;
		const length = Math.min(size - start, MAX_READ_BYTES);
		if (length <= 0) {
			return { text: "", nextOffset: start };
		}
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		const lastNewline = buffer.lastIndexOf(0x0a, bytesRead - 1);
		if (lastNewline < 0) {
			return { text: "", nextOffset: start };
		}
		return {
			text: buffer.subarray(0, lastNewline + 1).toString("utf8"),
			nextOffset: start + lastNewline + 1,
		};
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
}

function toHoldKey(target: BackgroundWorkHoldTarget): string {
	return `${target.workspaceId}\u0000${target.taskId}`;
}

export class BackgroundWorkHolds {
	private readonly holds = new Map<string, BackgroundWorkHold>();
	private readonly readTranscript: (path: string, offset: number) => Promise<TranscriptChunk | null>;
	private readonly now: () => number;
	private readonly recheckIntervalMs: number;
	private readonly settleGraceMs: number;

	constructor(private readonly options: BackgroundWorkHoldsOptions) {
		this.readTranscript = options.readTranscriptFrom ?? readTranscriptFrom;
		this.now = options.now ?? Date.now;
		this.recheckIntervalMs = options.recheckIntervalMs ?? RECHECK_INTERVAL_MS;
		this.settleGraceMs = options.settleGraceMs ?? SETTLE_GRACE_MS;
	}

	/**
	 * Holds the card in In Progress until the work finishes. Returns false when the work cannot be
	 * re-checked (no readable transcript): the caller then moves the card to Review as before.
	 */
	async hold(
		target: BackgroundWorkHoldTarget,
		work: RuntimeHookBackgroundWork,
		session: { pid: number | null; reviewMetadata: Partial<RuntimeTaskHookActivity> | undefined },
	): Promise<boolean> {
		this.release(target);
		if (work.taskIds.length === 0 || !work.transcriptPath) {
			return false;
		}
		const hold: BackgroundWorkHold = {
			target,
			pid: session.pid,
			outstanding: new Set(work.taskIds),
			transcriptPath: work.transcriptPath,
			offset: 0,
			lastFinishedAt: this.now(),
			reviewMetadata: session.reviewMetadata,
			timer: null,
		};
		// Registered before the read so activity hooks arriving meanwhile already see the hold.
		this.holds.set(toHoldKey(target), hold);
		// Only completions recorded after this Stop count: the listed tasks were still running when it fired.
		const start = await this.readTranscript(work.transcriptPath, Number.MAX_SAFE_INTEGER);
		if (!this.isCurrent(hold)) {
			return true;
		}
		if (!start) {
			this.release(target);
			return false;
		}
		hold.offset = start.nextOffset;
		this.schedule(hold);
		return true;
	}

	release(target: BackgroundWorkHoldTarget): void {
		const key = toHoldKey(target);
		const hold = this.holds.get(key);
		if (!hold) {
			return;
		}
		if (hold.timer) {
			clearTimeout(hold.timer);
		}
		this.holds.delete(key);
	}

	isHeld(target: BackgroundWorkHoldTarget): boolean {
		return this.holds.has(toHoldKey(target));
	}

	private schedule(hold: BackgroundWorkHold): void {
		hold.timer = setTimeout(() => {
			hold.timer = null;
			void this.recheck(hold);
		}, this.recheckIntervalMs);
		hold.timer.unref?.();
	}

	private isCurrent(hold: BackgroundWorkHold): boolean {
		return this.holds.get(toHoldKey(hold.target)) === hold;
	}

	private async recheck(hold: BackgroundWorkHold): Promise<void> {
		const sessionCurrent = await this.options.isSessionCurrent(hold.target, hold.pid).catch(() => false);
		if (!this.isCurrent(hold)) {
			return;
		}
		if (!sessionCurrent) {
			// The session exited or was replaced; its own exit already decided the column.
			this.release(hold.target);
			return;
		}
		const chunk = await this.readTranscript(hold.transcriptPath, hold.offset);
		if (!this.isCurrent(hold)) {
			return;
		}
		if (!chunk) {
			// The transcript is gone, so nothing can say the work is still running.
			this.settle(hold);
			return;
		}
		hold.offset = chunk.nextOffset;
		const countBefore = hold.outstanding.size;
		for (const notification of parseClaudeTaskNotifications(chunk.text)) {
			if (hold.outstanding.delete(notification.taskId)) {
				hold.lastFinishedAt = Math.max(hold.lastFinishedAt, notification.timestamp ?? this.now());
			}
		}
		if (hold.outstanding.size === 0) {
			// Give the agent the chance to pick the notification up and resume on its own first.
			if (this.now() - hold.lastFinishedAt >= this.settleGraceMs) {
				this.settle(hold);
				return;
			}
		} else if (hold.outstanding.size !== countBefore) {
			this.options.onProgress(hold.target, hold.outstanding.size);
		}
		this.schedule(hold);
	}

	private settle(hold: BackgroundWorkHold): void {
		this.release(hold.target);
		this.options.onSettled(hold.target, hold.reviewMetadata);
	}
}
