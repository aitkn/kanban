import type { MouseEvent } from "react";

/** sked fork: keeps a click on a control inside a card from opening, selecting or dragging the card. */
export function stopEvent(event: MouseEvent<HTMLElement>): void {
	event.preventDefault();
	event.stopPropagation();
}
