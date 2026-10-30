import type { RuntimeHookBackgroundWork } from "../../core/api-contract";
import { asRecord, readStringField } from "./hook-utils";

// sked fork: Claude Code's Stop payload lists "in-flight background work (running/pending + backgrounded)"
// in `background_tasks`: background Bash, background subagents and Monitor watches. When the list is not
// empty the turn ended only to wait for that work, and Claude starts a new turn by itself when a task
// finishes. The list is documented as in-flight only; the terminal statuses are dropped defensively.
const FINISHED_BACKGROUND_TASK_STATUSES = new Set(["completed", "failed", "killed", "stopped", "cancelled"]);

export function readClaudeOutstandingBackgroundWork(
	payload: Record<string, unknown> | null,
): RuntimeHookBackgroundWork | null {
	if (!payload || readStringField(payload, "hook_event_name") !== "Stop") {
		return null;
	}
	const backgroundTasks = payload.background_tasks;
	if (!Array.isArray(backgroundTasks)) {
		return null;
	}
	const taskIds: string[] = [];
	for (const entry of backgroundTasks) {
		const task = asRecord(entry);
		const id = task ? readStringField(task, "id") : null;
		if (!task || !id) {
			continue;
		}
		const status = readStringField(task, "status")?.toLowerCase() ?? null;
		if (status && FINISHED_BACKGROUND_TASK_STATUSES.has(status)) {
			continue;
		}
		taskIds.push(id);
	}
	if (taskIds.length === 0) {
		return null;
	}
	const transcriptPath = payload.transcript_path;
	return {
		taskIds,
		transcriptPath: typeof transcriptPath === "string" && transcriptPath.length > 0 ? transcriptPath : null,
	};
}

export interface ClaudeTaskNotification {
	taskId: string;
	status: string | null;
	timestamp: number | null;
}

const TASK_NOTIFICATION_PATTERN = /<task-notification>[\s\S]*?<\/task-notification>/g;
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/;
const TASK_STATUS_PATTERN = /<status>([^<]+)<\/status>/;

function readNotificationText(entry: Record<string, unknown>): string | null {
	// Claude writes a `queue-operation` "enqueue" line the moment a task finishes, even when no turn
	// follows (a task the user stops from /tasks). A delivered notification is also a user message.
	if (entry.type === "queue-operation" && entry.operation === "enqueue" && typeof entry.content === "string") {
		return entry.content;
	}
	if (entry.type === "user") {
		const message = asRecord(entry.message);
		if (message && typeof message.content === "string") {
			return message.content;
		}
	}
	return null;
}

/** Finds the background task completions Claude recorded in a chunk of its JSONL transcript. */
export function parseClaudeTaskNotifications(transcriptChunk: string): ClaudeTaskNotification[] {
	const notifications: ClaudeTaskNotification[] = [];
	for (const line of transcriptChunk.split("\n")) {
		if (!line.includes("task-notification")) {
			continue;
		}
		let entry: Record<string, unknown> | null;
		try {
			entry = asRecord(JSON.parse(line));
		} catch {
			continue;
		}
		const text = entry ? readNotificationText(entry) : null;
		if (!entry || !text) {
			continue;
		}
		const parsedTimestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		for (const block of text.match(TASK_NOTIFICATION_PATTERN) ?? []) {
			const taskId = block.match(TASK_ID_PATTERN)?.[1]?.trim();
			if (!taskId) {
				continue;
			}
			notifications.push({
				taskId,
				status: block.match(TASK_STATUS_PATTERN)?.[1]?.trim() ?? null,
				timestamp: Number.isNaN(parsedTimestamp) ? null : parsedTimestamp,
			});
		}
	}
	return notifications;
}
