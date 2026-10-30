import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	BackgroundWorkHolds,
	type BackgroundWorkHoldsOptions,
	type BackgroundWorkHoldTarget,
	readTranscriptFrom,
	type TranscriptChunk,
} from "../../../src/trpc/background-work-holds";

const target: BackgroundWorkHoldTarget = { workspaceId: "ws", workspacePath: "/repo", taskId: "task-1" };

function notificationLine(taskId: string, timestamp: number): string {
	return `${JSON.stringify({
		type: "queue-operation",
		operation: "enqueue",
		timestamp: new Date(timestamp).toISOString(),
		content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>killed</status>\n</task-notification>`,
	})}\n`;
}

/** An in-memory transcript that the holds read the way they read the real file. */
function createTranscript() {
	let content = "";
	return {
		append(text: string) {
			content += text;
		},
		read: async (_path: string, offset: number): Promise<TranscriptChunk | null> => {
			const start = Math.min(offset, content.length);
			return { text: content.slice(start), nextOffset: content.length };
		},
	};
}

describe("BackgroundWorkHolds", () => {
	let now: number;
	let transcript: ReturnType<typeof createTranscript>;
	let onSettled: ReturnType<typeof vi.fn<BackgroundWorkHoldsOptions["onSettled"]>>;
	let onProgress: ReturnType<typeof vi.fn<BackgroundWorkHoldsOptions["onProgress"]>>;
	let sessionCurrent: boolean;
	let holds: BackgroundWorkHolds;

	beforeEach(() => {
		vi.useFakeTimers();
		now = 1_000_000;
		transcript = createTranscript();
		transcript.append('{"type":"user","message":{"role":"user","content":"earlier turn"}}\n');
		onSettled = vi.fn<BackgroundWorkHoldsOptions["onSettled"]>();
		onProgress = vi.fn<BackgroundWorkHoldsOptions["onProgress"]>();
		sessionCurrent = true;
		holds = new BackgroundWorkHolds({
			isSessionCurrent: async () => sessionCurrent,
			onSettled,
			onProgress,
			readTranscriptFrom: transcript.read,
			now: () => now,
			recheckIntervalMs: 15_000,
			settleGraceMs: 10_000,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function advance(ms: number): Promise<void> {
		now += ms;
		await vi.advanceTimersByTimeAsync(ms);
	}

	it("keeps holding while the work has not finished", async () => {
		expect(
			await holds.hold(
				target,
				{ taskIds: ["b1"], transcriptPath: "/t.jsonl" },
				{ pid: 1, reviewMetadata: undefined },
			),
		).toBe("held");
		await advance(60_000);
		expect(onSettled).not.toHaveBeenCalled();
		expect(holds.isHeld(target)).toBe(true);
	});

	it("settles once every task finished and the agent did not resume", async () => {
		const reviewMetadata = { finalMessage: "Started it in the background." };
		await holds.hold(target, { taskIds: ["b1", "b2"], transcriptPath: "/t.jsonl" }, { pid: 1, reviewMetadata });

		transcript.append(notificationLine("b1", now + 1_000));
		await advance(15_000);
		expect(onProgress).toHaveBeenCalledWith(target, 1);
		expect(onSettled).not.toHaveBeenCalled();

		transcript.append(notificationLine("b2", now + 1_000));
		await advance(15_000);
		// The notification is 14s old: past the grace the agent gets to resume by itself.
		expect(onSettled).toHaveBeenCalledWith(target, reviewMetadata);
		expect(holds.isHeld(target)).toBe(false);
	});

	it("waits out the grace period after the last task finished", async () => {
		await holds.hold(target, { taskIds: ["b1"], transcriptPath: "/t.jsonl" }, { pid: 1, reviewMetadata: undefined });
		transcript.append(notificationLine("b1", now + 14_000));
		await advance(15_000);
		expect(onSettled).not.toHaveBeenCalled();
		await advance(15_000);
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("ignores completions written before the Stop", async () => {
		transcript.append(notificationLine("b1", now - 5_000));
		await holds.hold(target, { taskIds: ["b1"], transcriptPath: "/t.jsonl" }, { pid: 1, reviewMetadata: undefined });
		await advance(60_000);
		expect(onSettled).not.toHaveBeenCalled();
	});

	it("drops the hold without settling when the session is no longer the one that held", async () => {
		await holds.hold(target, { taskIds: ["b1"], transcriptPath: "/t.jsonl" }, { pid: 1, reviewMetadata: undefined });
		sessionCurrent = false;
		await advance(15_000);
		expect(holds.isHeld(target)).toBe(false);
		expect(onSettled).not.toHaveBeenCalled();
	});

	it("settles when the transcript can no longer be read", async () => {
		let readable = true;
		holds = new BackgroundWorkHolds({
			isSessionCurrent: async () => true,
			onSettled,
			onProgress,
			readTranscriptFrom: async (path, offset) => (readable ? transcript.read(path, offset) : null),
			now: () => now,
		});
		await holds.hold(target, { taskIds: ["b1"], transcriptPath: "/t.jsonl" }, { pid: 1, reviewMetadata: undefined });
		readable = false;
		await advance(15_000);
		expect(onSettled).toHaveBeenCalledTimes(1);
	});

	it("refuses to hold without a readable transcript", async () => {
		expect(
			await holds.hold(target, { taskIds: ["b1"], transcriptPath: null }, { pid: 1, reviewMetadata: undefined }),
		).toBe("unavailable");
		const unreadable = new BackgroundWorkHolds({
			isSessionCurrent: async () => true,
			onSettled,
			onProgress,
			readTranscriptFrom: async () => null,
		});
		expect(
			await unreadable.hold(
				target,
				{ taskIds: ["b1"], transcriptPath: "/t.jsonl" },
				{ pid: 1, reviewMetadata: undefined },
			),
		).toBe("unavailable");
	});

	it("reports a hold released while it was being set up as superseded", async () => {
		const pendingRead: { finish?: () => void } = {};
		const slowHolds = new BackgroundWorkHolds({
			isSessionCurrent: async () => true,
			onSettled,
			onProgress,
			readTranscriptFrom: (path, offset) =>
				new Promise((resolve) => {
					pendingRead.finish = () => void transcript.read(path, offset).then(resolve);
				}),
			now: () => now,
		});
		const pending = slowHolds.hold(
			target,
			{ taskIds: ["b1"], transcriptPath: "/t.jsonl" },
			{ pid: 1, reviewMetadata: undefined },
		);
		// A UserPromptSubmit arrives before the transcript read finishes.
		expect(slowHolds.isHeld(target)).toBe(true);
		slowHolds.release(target);
		pendingRead.finish?.();
		expect(await pending).toBe("superseded");
		expect(slowHolds.isHeld(target)).toBe(false);
	});

	it("stops re-checking after release", async () => {
		await holds.hold(target, { taskIds: ["b1"], transcriptPath: "/t.jsonl" }, { pid: 1, reviewMetadata: undefined });
		holds.release(target);
		transcript.append(notificationLine("b1", now));
		await advance(60_000);
		expect(onSettled).not.toHaveBeenCalled();
	});
});

describe("readTranscriptFrom", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "kanban-transcript-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("returns only complete lines and resumes after them", async () => {
		const path = join(directory, "t.jsonl");
		await writeFile(path, '{"a":1}\n{"b":');
		const first = await readTranscriptFrom(path, 0);
		expect(first).toEqual({ text: '{"a":1}\n', nextOffset: 8 });

		await appendFile(path, "2}\n");
		const second = await readTranscriptFrom(path, first?.nextOffset ?? 0);
		expect(second).toEqual({ text: '{"b":2}\n', nextOffset: 16 });
	});

	it("starts at the end when asked past it, and returns null for a missing file", async () => {
		const path = join(directory, "t.jsonl");
		await writeFile(path, '{"a":1}\n');
		expect(await readTranscriptFrom(path, Number.MAX_SAFE_INTEGER)).toEqual({ text: "", nextOffset: 8 });
		expect(await readTranscriptFrom(join(directory, "missing.jsonl"), 0)).toBeNull();
	});
});
