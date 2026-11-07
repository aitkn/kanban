import type { DropResult } from "@hello-pangea/dnd";

import type { ProgrammaticCardMoveInFlight } from "@/state/drag-rules";
import type { BoardData } from "@/types";

/**
 * How long after `drop()` a programmatic move may stay unfinished before the board nudges
 * @hello-pangea/dnd out of a stalled drop animation. Pangea's longest drop animation is 0.55s.
 */
export const PROGRAMMATIC_DROP_NUDGE_DELAY_MS = 1000;

/**
 * How long after `drop()` the board waits in total before finishing a programmatic move itself.
 */
export const PROGRAMMATIC_DROP_FORCE_END_DELAY_MS = 2000;

/**
 * A programmatic move is a command (start this task, move it to Done); the drag only animates it.
 * When pangea reports the drop anywhere but the requested column (for example at home, because
 * the last fluid `move()` never reached the target), keep the command and land it on the target.
 */
export function retargetProgrammaticDropResult(
	result: DropResult,
	move: ProgrammaticCardMoveInFlight | null,
	board: BoardData,
): DropResult {
	if (!move || result.draggableId !== move.taskId || result.reason !== "DROP") {
		return result;
	}
	if (result.source.droppableId !== move.fromColumnId || result.destination?.droppableId === move.toColumnId) {
		return result;
	}
	const targetColumn = board.columns.find((column) => column.id === move.toColumnId);
	if (!targetColumn) {
		return result;
	}
	return {
		...result,
		destination: {
			droppableId: move.toColumnId,
			index: move.insertAtTop ? 0 : targetColumn.cards.length,
		},
		combine: null,
	};
}

/**
 * The drop result pangea would have reported had the programmatic move completed, used when
 * pangea never reports the drop at all.
 */
export function buildProgrammaticDropResult(move: ProgrammaticCardMoveInFlight, board: BoardData): DropResult | null {
	const sourceColumn = board.columns.find((column) => column.id === move.fromColumnId);
	const sourceIndex = sourceColumn?.cards.findIndex((card) => card.id === move.taskId) ?? -1;
	if (sourceIndex < 0) {
		return null;
	}
	return retargetProgrammaticDropResult(
		{
			draggableId: move.taskId,
			type: "CARD",
			source: { droppableId: move.fromColumnId, index: sourceIndex },
			destination: null,
			combine: null,
			mode: "FLUID",
			reason: "DROP",
		},
		move,
		board,
	);
}

/**
 * Pangea finishes an animated drop on the dragged element's `transitionend` for `transform`.
 * If the drop starts before the drag's transform was ever painted, that transition never runs,
 * the event never fires and the drag stays stuck in DROP_ANIMATING with the card in the drag
 * portal and `onDragEnd` never called. Dispatching the event pangea waits for completes the drop.
 * Returns whether the dragged element was found.
 */
export function nudgeStalledDropAnimation(taskId: string): boolean {
	const element = document.querySelector<HTMLElement>(`[data-rfd-draggable-id="${taskId}"]`);
	if (!element) {
		return false;
	}
	const event = new Event("transitionend", { bubbles: true });
	Object.defineProperty(event, "propertyName", { value: "transform" });
	element.dispatchEvent(event);
	return true;
}
