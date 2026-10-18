import { useEffect, useRef, useState } from "react";
import type {
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
	RuntimeWorkspaceStateSaveRequest,
} from "@/runtime/types";
import { WorkspaceStateConflictError } from "@/runtime/workspace-state-query";
import { recordConfirmedBoard } from "@/stores/board-persistence-confirmations";
import type { BoardData } from "@/types";

const WORKSPACE_STATE_PERSIST_DEBOUNCE_MS = 120;

export interface UseWorkspacePersistenceParams {
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	currentProjectId: string | null;
	workspaceRevision: number | null;
	hydrationNonce: number;
	canPersistWorkspaceState: boolean;
	isDocumentVisible: boolean;
	isWorkspaceStateRefreshing: boolean;
	persistWorkspaceState: (input: {
		workspaceId: string;
		payload: RuntimeWorkspaceStateSaveRequest;
	}) => Promise<RuntimeWorkspaceStateResponse>;
	refetchWorkspaceState: () => Promise<unknown>;
	onWorkspaceRevisionChange: (revision: number) => void;
	onWorkspaceStateConflict?: (input: { workspaceId: string; currentRevision: number }) => void;
}

export function useWorkspacePersistence({
	board,
	sessions,
	currentProjectId,
	workspaceRevision,
	hydrationNonce,
	canPersistWorkspaceState,
	isDocumentVisible,
	isWorkspaceStateRefreshing,
	persistWorkspaceState,
	refetchWorkspaceState,
	onWorkspaceRevisionChange,
	onWorkspaceStateConflict,
}: UseWorkspacePersistenceParams): void {
	const [persistCycle, setPersistCycle] = useState(0);
	const skipNextPersistRef = useRef(false);
	const latestHydrationNonceRef = useRef(hydrationNonce);
	const latestPersistRequestIdRef = useRef(0);
	const persistInFlightRef = useRef(false);
	const persistQueuedRef = useRef(false);
	const currentProjectIdRef = useRef<string | null>(currentProjectId);
	const sessionsRef = useRef(sessions);
	const lastPersistedBoardRef = useRef<BoardData | null>(null);
	const lastPersistedWorkspaceIdRef = useRef<string | null>(null);

	useEffect(() => {
		currentProjectIdRef.current = currentProjectId;
		if (lastPersistedWorkspaceIdRef.current !== currentProjectId) {
			lastPersistedWorkspaceIdRef.current = currentProjectId;
			lastPersistedBoardRef.current = null;
		}
	}, [currentProjectId]);

	useEffect(() => {
		sessionsRef.current = sessions;
	}, [sessions]);

	useEffect(() => {
		if (latestHydrationNonceRef.current === hydrationNonce) {
			return;
		}
		latestHydrationNonceRef.current = hydrationNonce;
		skipNextPersistRef.current = true;
		lastPersistedWorkspaceIdRef.current = currentProjectId;
		lastPersistedBoardRef.current = board;
	}, [board, currentProjectId, hydrationNonce]);

	useEffect(() => {
		if (!canPersistWorkspaceState || !isDocumentVisible || isWorkspaceStateRefreshing || workspaceRevision == null) {
			return;
		}
		if (persistInFlightRef.current) {
			persistQueuedRef.current = true;
			return;
		}
		if (skipNextPersistRef.current) {
			skipNextPersistRef.current = false;
			return;
		}
		if (
			currentProjectId != null &&
			lastPersistedWorkspaceIdRef.current === currentProjectId &&
			lastPersistedBoardRef.current === board
		) {
			return;
		}
		const timeoutId = window.setTimeout(() => {
			const requestId = latestPersistRequestIdRef.current + 1;
			latestPersistRequestIdRef.current = requestId;
			const persistWorkspaceId = currentProjectId;
			if (!persistWorkspaceId) {
				return;
			}
			const payload: RuntimeWorkspaceStateSaveRequest = {
				board,
				sessions: sessionsRef.current,
				expectedRevision: workspaceRevision,
			};
			void (async () => {
				persistInFlightRef.current = true;
				try {
					const saved = await persistWorkspaceState({
						workspaceId: persistWorkspaceId,
						payload,
					});
					recordConfirmedBoard(board, "saved");
					if (
						requestId !== latestPersistRequestIdRef.current ||
						currentProjectIdRef.current !== persistWorkspaceId
					) {
						return;
					}
					lastPersistedWorkspaceIdRef.current = persistWorkspaceId;
					lastPersistedBoardRef.current = board;
					onWorkspaceRevisionChange(saved.revision);
				} catch (error) {
					if (error instanceof WorkspaceStateConflictError) {
						// sked fork: do not adopt error.currentRevision here (sked_ai#4951, cline/kanban#674).
						// The refetch below reloads the board only when the fetched revision differs from
						// ours. Adopting it first made the reload a no-op, and the next save then wrote this
						// stale board over the server's newer one. The local edit is dropped instead, and
						// the conflict toast says so.
						if (
							requestId === latestPersistRequestIdRef.current &&
							currentProjectIdRef.current === persistWorkspaceId
						) {
							onWorkspaceStateConflict?.({
								workspaceId: persistWorkspaceId,
								currentRevision: error.currentRevision,
							});
						}
						if (currentProjectIdRef.current !== persistWorkspaceId) {
							return;
						}
						await refetchWorkspaceState();
						return;
					}
					// Keep the UI usable even if persistence is temporarily unavailable.
				} finally {
					persistInFlightRef.current = false;
					if (persistQueuedRef.current) {
						persistQueuedRef.current = false;
						setPersistCycle((current) => current + 1);
					}
				}
			})();
		}, WORKSPACE_STATE_PERSIST_DEBOUNCE_MS);
		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [
		board,
		canPersistWorkspaceState,
		currentProjectId,
		isDocumentVisible,
		isWorkspaceStateRefreshing,
		onWorkspaceRevisionChange,
		persistCycle,
		persistWorkspaceState,
		refetchWorkspaceState,
		onWorkspaceStateConflict,
		workspaceRevision,
	]);
}
