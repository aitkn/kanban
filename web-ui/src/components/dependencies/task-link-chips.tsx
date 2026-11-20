import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";

import { stopEvent } from "@/components/dependencies/stop-event";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { BoardColumnId } from "@/types";

// sked fork: a linked card's colour follows the column it is in right now.
const CHIP_CLASS_BY_COLUMN: Record<BoardColumnId, string> = {
	backlog: "border-status-red/40 bg-status-red/10 text-status-red",
	in_progress: "border-status-orange/40 bg-status-orange/10 text-status-orange",
	review: "border-status-gold/40 bg-status-gold/10 text-status-gold",
	trash: "border-status-green/40 bg-status-green/10 text-status-green",
};

const DELETED_CHIP_CLASS = "border-border bg-surface-1 text-text-tertiary line-through";

export interface TaskLinkChipModel {
	key: string;
	label: string;
	/** Null when the card (or its project) no longer exists. */
	columnId: BoardColumnId | null;
	tooltip: string;
	ariaLabel: string;
	onOpen: () => void;
	/** Removes the link this chip shows; null when the view cannot. */
	remove: { ariaLabel: string; onRemove: () => void } | null;
}

/**
 * sked fork: one row of link chips on a card. Each chip opens the card it names; its "x",
 * shown on hover or keyboard focus, removes the link without opening anything.
 */
export function TaskLinkChipRow({
	icon: Icon,
	title,
	chips,
}: {
	icon: LucideIcon;
	/** Names the direction, for the group and the icon's tooltip ("Depends on", "Needed by"). */
	title: string;
	chips: TaskLinkChipModel[];
}): React.ReactElement | null {
	if (chips.length === 0) {
		return null;
	}
	return (
		<div role="group" aria-label={title} className="mt-1.5 flex flex-wrap items-center gap-1">
			<Tooltip side="bottom" content={title}>
				<Icon size={12} className="shrink-0 text-text-tertiary" aria-hidden />
			</Tooltip>
			{chips.map((chip) => (
				<span key={chip.key} className="group/chip relative inline-flex">
					<Tooltip side="bottom" content={chip.tooltip}>
						<button
							type="button"
							data-reference-state={chip.columnId ?? "deleted"}
							aria-label={chip.ariaLabel}
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								chip.onOpen();
							}}
							className={cn(
								"cursor-pointer rounded-sm border px-1 font-mono text-[11px] leading-4 hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
								chip.columnId ? CHIP_CLASS_BY_COLUMN[chip.columnId] : DELETED_CHIP_CLASS,
							)}
						>
							{chip.label}
						</button>
					</Tooltip>
					{chip.remove ? (
						<button
							type="button"
							aria-label={chip.remove.ariaLabel}
							title="Remove link"
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								chip.remove?.onRemove();
							}}
							// While hidden it takes no clicks: it overhangs the next chip's corner, and a click
							// there must open that chip, not silently remove this link.
							className="pointer-events-none absolute -top-1.5 -right-1.5 z-10 flex size-3.5 cursor-pointer items-center justify-center rounded-full border border-border-bright bg-surface-3 text-text-secondary opacity-0 hover:bg-status-red hover:text-text-primary focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent group-hover/chip:pointer-events-auto group-hover/chip:opacity-100 group-focus-within/chip:pointer-events-auto group-focus-within/chip:opacity-100"
						>
							<X size={9} aria-hidden />
						</button>
					) : null}
				</span>
			))}
		</div>
	);
}
