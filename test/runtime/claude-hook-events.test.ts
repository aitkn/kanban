import { describe, expect, it } from "vitest";

import {
	parseClaudeTaskNotifications,
	readClaudeOutstandingBackgroundWork,
} from "../../src/commands/hook-events/claude-hook-events";

const TRANSCRIPT_PATH = "/home/user/.claude/projects/-repo/60c03ec5.jsonl";

// Shapes captured from Claude Code 2.1.314 Stop hooks.
function createStopPayload(backgroundTasks: unknown): Record<string, unknown> {
	return {
		session_id: "60c03ec5",
		transcript_path: TRANSCRIPT_PATH,
		cwd: "/repo",
		hook_event_name: "Stop",
		stop_hook_active: false,
		last_assistant_message: "All three are running in the background.",
		background_tasks: backgroundTasks,
		session_crons: [],
	};
}

function notificationBlock(taskId: string, status: string): string {
	return [
		"<task-notification>",
		`<task-id>${taskId}</task-id>`,
		"<tool-use-id>toolu_01EWZLkqY1drArUszkdy3qe1</tool-use-id>",
		`<output-file>/tmp/claude/tasks/${taskId}.output</output-file>`,
		`<status>${status}</status>`,
		'<summary>Background command "Sleep then echo in background" completed (exit code 0)</summary>',
		"</task-notification>",
	].join("\n");
}

describe("readClaudeOutstandingBackgroundWork", () => {
	it("returns the shell, subagent and monitor tasks a Stop ended on", () => {
		const payload = createStopPayload([
			{
				id: "bmxo3ybzr",
				type: "shell",
				status: "running",
				description: "Sleep then echo in background",
				command: "sleep 90 && echo s2",
			},
			{
				id: "a8232d28e8ebf67e3",
				type: "subagent",
				status: "running",
				description: "Run sleep 60 foreground",
				agent_type: "general-purpose",
			},
			{
				id: "bliv0g1b5",
				type: "shell",
				status: "running",
				description: "sleep 50 then monitor-event",
				command: "sleep 50; echo monitor-event",
			},
		]);

		expect(readClaudeOutstandingBackgroundWork(payload)).toEqual({
			taskIds: ["bmxo3ybzr", "a8232d28e8ebf67e3", "bliv0g1b5"],
			transcriptPath: TRANSCRIPT_PATH,
		});
	});

	it("returns null when nothing is in flight", () => {
		expect(readClaudeOutstandingBackgroundWork(createStopPayload([]))).toBeNull();
	});

	it("returns null for a Claude Code without the field", () => {
		const payload = createStopPayload(undefined);
		delete payload.background_tasks;
		expect(readClaudeOutstandingBackgroundWork(payload)).toBeNull();
	});

	it("ignores tasks in a finished status and malformed entries", () => {
		const payload = createStopPayload([
			{ id: "done1", type: "shell", status: "completed" },
			{ id: "dead1", type: "shell", status: "killed" },
			{ type: "shell", status: "running" },
			"not-a-task",
			{ id: "pending1", type: "workflow", status: "pending" },
		]);
		expect(readClaudeOutstandingBackgroundWork(payload)).toEqual({
			taskIds: ["pending1"],
			transcriptPath: TRANSCRIPT_PATH,
		});
	});

	it("only reads Stop payloads", () => {
		const payload = { ...createStopPayload([{ id: "b1", type: "shell", status: "running" }]) };
		payload.hook_event_name = "SubagentStop";
		expect(readClaudeOutstandingBackgroundWork(payload)).toBeNull();
		expect(readClaudeOutstandingBackgroundWork(null)).toBeNull();
	});
});

describe("parseClaudeTaskNotifications", () => {
	it("reads an enqueued notification that no turn consumed (task stopped from /tasks)", () => {
		const line = JSON.stringify({
			type: "queue-operation",
			operation: "enqueue",
			timestamp: "2026-10-30T02:59:53.541Z",
			sessionId: "60c03ec5",
			content: notificationBlock("bp90luyzs", "killed"),
		});
		expect(parseClaudeTaskNotifications(`${line}\n`)).toEqual([
			{ taskId: "bp90luyzs", status: "killed", timestamp: Date.parse("2026-10-30T02:59:53.541Z") },
		]);
	});

	it("reads a delivered notification and ignores unrelated lines", () => {
		const lines = [
			JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-10-30T02:52:58.024Z" }),
			JSON.stringify({
				type: "user",
				timestamp: "2026-10-30T02:52:58.030Z",
				message: { role: "user", content: notificationBlock("b9wqlnf43", "completed") },
			}),
			JSON.stringify({
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "<task-notification> quoted" }] },
			}),
			"{not json task-notification",
			"",
		];
		expect(parseClaudeTaskNotifications(lines.join("\n"))).toEqual([
			{ taskId: "b9wqlnf43", status: "completed", timestamp: Date.parse("2026-10-30T02:52:58.030Z") },
		]);
	});
});
