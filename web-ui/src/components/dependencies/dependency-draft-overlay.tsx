import type { RefObject } from "react";
import { useEffect, useId, useState } from "react";

import type { DependencyLinkDraft } from "@/components/dependencies/use-dependency-linking";
import type { BoardColumnId } from "@/types";

// sked fork: the arrow drawn while the user drags a new link. Saved links are not drawn: they show
// as chips on both cards (`depends-on-chips.tsx`, `needed-by-chips.tsx`), so once a link is saved
// its arrow disappears.

interface TaskAnchor {
	left: number;
	right: number;
	top: number;
	bottom: number;
	centerX: number;
	centerY: number;
	columnId: BoardColumnId | null;
}

interface DraftLayout {
	width: number;
	height: number;
	/** The container's viewport position, to place the pointer end of the arrow. */
	left: number;
	top: number;
	source: TaskAnchor;
	target: TaskAnchor | null;
}

type AnchorSide = "left" | "right" | "top" | "bottom";

interface AnchorPoint {
	x: number;
	y: number;
	side: AnchorSide;
}

const SOURCE_CONNECTOR_PADDING = 2;
const TARGET_CONNECTOR_PADDING = 8;
const COLUMN_ORDER: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];
const SIDE_NORMALS: Record<AnchorSide, { x: number; y: number }> = {
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
	top: { x: 0, y: -1 },
	bottom: { x: 0, y: 1 },
};

function getColumnOrder(columnId: BoardColumnId | null): number | null {
	if (!columnId) {
		return null;
	}
	const index = COLUMN_ORDER.indexOf(columnId);
	return index === -1 ? null : index;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function normalizeColumnId(value: string | undefined): BoardColumnId | null {
	if (value === "backlog" || value === "in_progress" || value === "review" || value === "trash") {
		return value;
	}
	return null;
}

function dot(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return a.x * b.x + a.y * b.y;
}

function getAnchorPoint(anchor: TaskAnchor, side: AnchorSide, laneOffset: number, padding: number): AnchorPoint {
	if (side === "left") {
		return {
			x: anchor.left - padding,
			y: anchor.centerY + laneOffset,
			side,
		};
	}
	if (side === "right") {
		return {
			x: anchor.right + padding,
			y: anchor.centerY + laneOffset,
			side,
		};
	}
	if (side === "top") {
		return {
			x: anchor.centerX + laneOffset,
			y: anchor.top - padding,
			side,
		};
	}
	return {
		x: anchor.centerX + laneOffset,
		y: anchor.bottom + padding,
		side,
	};
}

function chooseConnection(
	firstAnchor: TaskAnchor,
	secondAnchor: TaskAnchor,
	firstLaneOffset: number,
	secondLaneOffset: number,
	firstPadding: number,
	secondPadding: number,
): { start: AnchorPoint; end: AnchorPoint } {
	// sked fork: only the link being dragged is drawn; saved links show as chips on the cards.
	// The draft may target free pointer space (a null column) while the user is dragging.
	// Routing rules:
	// 1) If both cards are in backlog, connect right -> right.
	// 2) If cards are in different columns, preserve first -> second direction while preferring
	//    right -> left for forward links and left -> right for backward links.
	// 3) Otherwise fall back to the cheapest side-pairing based on geometry.
	const firstColumnId = firstAnchor.columnId;
	const secondColumnId = secondAnchor.columnId;
	const firstColumnOrder = getColumnOrder(firstColumnId);
	const secondColumnOrder = getColumnOrder(secondColumnId);

	if (secondColumnId === null) {
		const sourceSide: AnchorSide =
			firstColumnId === "backlog"
				? "right"
				: firstColumnId === "in_progress" || firstColumnId === "review"
					? "left"
					: "left";
		const targetSide: AnchorSide = sourceSide === "right" ? "left" : "right";
		return {
			start: getAnchorPoint(firstAnchor, sourceSide, firstLaneOffset, firstPadding),
			end: getAnchorPoint(secondAnchor, targetSide, secondLaneOffset, secondPadding),
		};
	}

	if (firstColumnId === null) {
		const targetSide: AnchorSide =
			secondColumnId === "backlog" || secondColumnId === "in_progress" || secondColumnId === "review"
				? "right"
				: "left";
		const sourceSide: AnchorSide = targetSide === "right" ? "left" : "right";
		return {
			start: getAnchorPoint(firstAnchor, sourceSide, firstLaneOffset, firstPadding),
			end: getAnchorPoint(secondAnchor, targetSide, secondLaneOffset, secondPadding),
		};
	}

	if (
		firstColumnId &&
		secondColumnId &&
		firstColumnId === secondColumnId &&
		(firstColumnId === "backlog" || firstColumnId === "in_progress" || firstColumnId === "review")
	) {
		return {
			start: getAnchorPoint(firstAnchor, "right", firstLaneOffset, firstPadding),
			end: getAnchorPoint(secondAnchor, "right", secondLaneOffset, secondPadding),
		};
	}

	if (firstColumnOrder !== null && secondColumnOrder !== null && firstColumnOrder !== secondColumnOrder) {
		if (firstColumnOrder < secondColumnOrder) {
			return {
				start: getAnchorPoint(firstAnchor, "right", firstLaneOffset, firstPadding),
				end: getAnchorPoint(secondAnchor, "left", secondLaneOffset, secondPadding),
			};
		}
		return {
			start: getAnchorPoint(firstAnchor, "left", firstLaneOffset, firstPadding),
			end: getAnchorPoint(secondAnchor, "right", secondLaneOffset, secondPadding),
		};
	}

	const firstSides: AnchorSide[] = ["left", "right", "top", "bottom"];
	const secondSides: AnchorSide[] = ["left", "right", "top", "bottom"];
	let best: {
		cost: number;
		start: AnchorPoint;
		end: AnchorPoint;
	} | null = null;

	for (const firstSide of firstSides) {
		for (const secondSide of secondSides) {
			const start = getAnchorPoint(firstAnchor, firstSide, firstLaneOffset, firstPadding);
			const end = getAnchorPoint(secondAnchor, secondSide, secondLaneOffset, secondPadding);
			const vector = { x: end.x - start.x, y: end.y - start.y };
			const distance = Math.hypot(vector.x, vector.y);
			const startFacing = dot(SIDE_NORMALS[firstSide], vector);
			const endFacing = dot(SIDE_NORMALS[secondSide], { x: -vector.x, y: -vector.y });
			const startFacingPenalty = startFacing < 0 ? 140 + Math.abs(startFacing) * 0.6 : 0;
			const endFacingPenalty = endFacing < 0 ? 140 + Math.abs(endFacing) * 0.6 : 0;
			const cost = distance + startFacingPenalty + endFacingPenalty;
			if (!best || cost < best.cost) {
				best = {
					cost,
					start,
					end,
				};
			}
		}
	}

	if (best) {
		return {
			start: best.start,
			end: best.end,
		};
	}

	return {
		start: getAnchorPoint(firstAnchor, "right", firstLaneOffset, firstPadding),
		end: getAnchorPoint(secondAnchor, "left", secondLaneOffset, secondPadding),
	};
}

function computeDraftPath(
	sourceAnchor: TaskAnchor,
	targetAnchor: TaskAnchor,
	bounds: { width: number; height: number },
): string {
	const connection = chooseConnection(
		sourceAnchor,
		targetAnchor,
		0,
		0,
		SOURCE_CONNECTOR_PADDING,
		TARGET_CONNECTOR_PADDING,
	);
	const minX = 2;
	const maxX = bounds.width - 2;
	const minY = 2;
	const maxY = bounds.height - 2;
	const startX = clamp(connection.start.x, minX, maxX);
	const startY = clamp(connection.start.y, minY, maxY);
	const endX = clamp(connection.end.x, minX, maxX);
	const endY = clamp(connection.end.y, minY, maxY);
	const distance = Math.hypot(endX - startX, endY - startY);
	const curvePull = clamp(distance * 0.35, 42, 220);
	const sourceNormal = SIDE_NORMALS[connection.start.side];
	const targetNormal = SIDE_NORMALS[connection.end.side];
	const controlPoint1X = clamp(startX + sourceNormal.x * curvePull, minX, maxX);
	const controlPoint1Y = clamp(startY + sourceNormal.y * curvePull, minY, maxY);
	const controlPoint2X = clamp(endX + targetNormal.x * curvePull, minX, maxX);
	const controlPoint2Y = clamp(endY + targetNormal.y * curvePull, minY, maxY);
	return `M ${startX} ${startY} C ${controlPoint1X} ${controlPoint1Y} ${controlPoint2X} ${controlPoint2Y} ${endX} ${endY}`;
}

function measureTaskAnchor(container: HTMLElement, containerRect: DOMRect, taskId: string): TaskAnchor | null {
	const cardElement = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]")).find(
		(element) => element.dataset.taskId === taskId,
	);
	if (!cardElement) {
		return null;
	}
	const rect = cardElement.getBoundingClientRect();
	const left = rect.left - containerRect.left;
	const right = rect.right - containerRect.left;
	const top = rect.top - containerRect.top;
	const bottom = rect.bottom - containerRect.top;
	return {
		left,
		right,
		top,
		bottom,
		centerX: (left + right) / 2,
		centerY: (top + bottom) / 2,
		columnId: normalizeColumnId(
			cardElement.dataset.columnId ?? cardElement.closest<HTMLElement>("[data-column-id]")?.dataset.columnId,
		),
	};
}

function measureDraftLayout(
	container: HTMLElement | null,
	sourceTaskId: string,
	targetTaskId: string | null,
): DraftLayout | null {
	if (!container) {
		return null;
	}
	const containerRect = container.getBoundingClientRect();
	const source = measureTaskAnchor(container, containerRect, sourceTaskId);
	if (!source || containerRect.width <= 0 || containerRect.height <= 0) {
		return null;
	}
	return {
		width: containerRect.width,
		height: containerRect.height,
		left: containerRect.left,
		top: containerRect.top,
		source,
		target: targetTaskId ? measureTaskAnchor(container, containerRect, targetTaskId) : null,
	};
}

function areAnchorsEqual(a: TaskAnchor | null, b: TaskAnchor | null): boolean {
	if (!a || !b) {
		return a === b;
	}
	return (
		a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom && a.columnId === b.columnId
	);
}

function areDraftLayoutsEqual(a: DraftLayout | null, b: DraftLayout | null): boolean {
	if (!a || !b) {
		return a === b;
	}
	return (
		a.width === b.width &&
		a.height === b.height &&
		a.left === b.left &&
		a.top === b.top &&
		areAnchorsEqual(a.source, b.source) &&
		areAnchorsEqual(a.target, b.target)
	);
}

export function DependencyDraftOverlay({
	containerRef,
	draft,
}: {
	containerRef: RefObject<HTMLElement>;
	draft: DependencyLinkDraft | null;
}): React.ReactElement | null {
	const [layout, setLayout] = useState<DraftLayout | null>(null);
	const markerId = useId().replaceAll(":", "");
	const sourceTaskId = draft?.sourceTaskId ?? null;
	const targetTaskId = draft?.targetTaskId ?? null;

	// Cards scroll and reflow while the user drags, so re-measure the two endpoints every frame.
	useEffect(() => {
		if (!sourceTaskId) {
			setLayout(null);
			return;
		}
		let animationFrameId = 0;
		const tick = () => {
			const next = measureDraftLayout(containerRef.current, sourceTaskId, targetTaskId);
			setLayout((current) => (areDraftLayoutsEqual(current, next) ? current : next));
			animationFrameId = window.requestAnimationFrame(tick);
		};
		tick();
		return () => {
			window.cancelAnimationFrame(animationFrameId);
		};
	}, [containerRef, sourceTaskId, targetTaskId]);

	if (!draft || !layout) {
		return null;
	}
	const pointerX = draft.pointerClientX - layout.left;
	const pointerY = draft.pointerClientY - layout.top;
	const pointerTarget: TaskAnchor = {
		left: pointerX,
		right: pointerX,
		top: pointerY,
		bottom: pointerY,
		centerX: pointerX,
		centerY: pointerY,
		columnId: null,
	};
	const path = computeDraftPath(layout.source, layout.target ?? pointerTarget, layout);

	return (
		<svg
			className="kb-dependency-draft-overlay"
			width={layout.width}
			height={layout.height}
			viewBox={`0 0 ${layout.width} ${layout.height}`}
		>
			<defs>
				<marker
					id={`${markerId}-draft-arrow`}
					viewBox="0 0 10 10"
					refX="7"
					refY="5"
					markerWidth="5"
					markerHeight="5"
					orient="auto-start-reverse"
				>
					<path
						d="M 0 0 L 10 5 L 0 10 z"
						fill="var(--color-accent)"
						stroke="var(--color-accent)"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
				</marker>
			</defs>
			<path d={path} className="kb-dependency-draft-path" markerEnd={`url(#${markerId}-draft-arrow)`} />
		</svg>
	);
}
