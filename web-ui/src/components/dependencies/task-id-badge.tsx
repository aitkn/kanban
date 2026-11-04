import type { MouseEvent } from "react";
import { useEffect } from "react";

import { showAppToast } from "@/components/app-toaster";
import { cn } from "@/components/ui/cn";
import { useCopyToClipboard } from "@/utils/react-use";

function stopEvent(event: MouseEvent<HTMLElement>): void {
	event.preventDefault();
	event.stopPropagation();
}

/** sked fork: the card's own id; clicking copies it without opening or dragging the card. */
export function TaskIdBadge({ taskId, muted = false }: { taskId: string; muted?: boolean }): React.ReactElement {
	const [copyState, copyToClipboard] = useCopyToClipboard();

	useEffect(() => {
		if (copyState.error) {
			showAppToast({ intent: "warning", message: `Could not copy ${taskId}.`, timeout: 3000 });
			return;
		}
		if (copyState.value !== undefined) {
			showAppToast({ intent: "success", message: `Copied ${copyState.value}`, timeout: 1500 });
		}
	}, [copyState, taskId]);

	return (
		<button
			type="button"
			aria-label={`Copy task id ${taskId}`}
			title="Copy task id"
			onMouseDown={stopEvent}
			onClick={(event) => {
				stopEvent(event);
				copyToClipboard(taskId);
			}}
			className={cn(
				"shrink-0 cursor-pointer rounded-sm px-1 font-mono text-[11px] leading-4 hover:bg-surface-4 hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
				muted ? "text-text-tertiary/70" : "text-text-tertiary",
			)}
		>
			{taskId}
		</button>
	);
}
