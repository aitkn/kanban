import type { BoardColumn, BoardColumnId, BoardData } from "@/types";

const columnOrder: Array<{ id: BoardColumnId; title: string }> = [
	{ id: "backlog", title: "Backlog" },
	{ id: "in_progress", title: "In Progress" },
	{ id: "review", title: "Review" },
	{ id: "trash", title: "Done" },
];

/** sked fork: a column's title on any board, for a card on a board this tab does not hold. */
export function getBoardColumnTitle(columnId: BoardColumnId): string {
	return columnOrder.find((column) => column.id === columnId)?.title ?? columnId;
}

function createEmptyColumn(id: BoardColumnId, title: string): BoardColumn {
	return {
		id,
		title,
		cards: [],
	};
}

export function createInitialBoardData(): BoardData {
	return {
		columns: columnOrder.map((column) => createEmptyColumn(column.id, column.title)),
		dependencies: [],
	};
}
