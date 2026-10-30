// sked fork: wire protocol between the Kanban runtime and its detached PTY host.
// A frame is [u32 header length][u32 payload length][JSON header][raw payload bytes].
// Terminal output and input travel as the raw payload so they are never re-encoded.

export const PTY_HOST_PROTOCOL_VERSION = 1;

const FRAME_PREFIX_BYTES = 8;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface PtyHostExit {
	exitCode: number;
	signal?: number;
}

export interface PtyHostSessionInfo {
	id: string;
	namespace: string;
	taskId: string;
	pid: number;
	cols: number;
	rows: number;
	exit: PtyHostExit | null;
	meta: unknown;
}

export interface PtyHostSpawnFields {
	namespace: string;
	taskId: string;
	binary: string;
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	cols: number;
	rows: number;
	meta: unknown;
}

export type PtyHostClientMessage =
	| { type: "hello"; version: number }
	| ({ type: "spawn"; requestId: number } & PtyHostSpawnFields)
	| { type: "write"; id: string }
	| { type: "resize"; id: string; cols: number; rows: number; pixelWidth?: number; pixelHeight?: number }
	| { type: "pause"; id: string }
	| { type: "resume"; id: string }
	| { type: "kill"; id: string }
	| { type: "list"; requestId: number; namespace: string | null }
	| { type: "attach"; requestId: number; id: string };

export type PtyHostServerMessage =
	| { type: "hello"; version: number; pid: number }
	| { type: "spawned"; requestId: number; id: string; pid: number }
	| { type: "listed"; requestId: number; sessions: PtyHostSessionInfo[] }
	| {
			type: "attached";
			requestId: number;
			id: string;
			pid: number;
			snapshot: string;
			cols: number;
			rows: number;
	  }
	| { type: "error"; requestId: number; message: string }
	| { type: "data"; id: string }
	| { type: "exit"; id: string; exit: PtyHostExit }
	| { type: "detached"; id: string };

export function encodePtyHostFrame(header: object, payload?: Buffer | Uint8Array | string): Buffer {
	const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
	const payloadBytes =
		payload === undefined ? Buffer.alloc(0) : typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
	const prefix = Buffer.alloc(FRAME_PREFIX_BYTES);
	prefix.writeUInt32BE(headerBytes.byteLength, 0);
	prefix.writeUInt32BE(payloadBytes.byteLength, 4);
	return Buffer.concat([prefix, headerBytes, payloadBytes]);
}

export interface PtyHostFrame<T> {
	header: T;
	payload: Buffer;
}

// Accumulates socket chunks and yields every complete frame.
export class PtyHostFrameDecoder<T> {
	private buffered: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): Array<PtyHostFrame<T>> {
		this.buffered = this.buffered.byteLength === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
		const frames: Array<PtyHostFrame<T>> = [];
		while (this.buffered.byteLength >= FRAME_PREFIX_BYTES) {
			const headerLength = this.buffered.readUInt32BE(0);
			const payloadLength = this.buffered.readUInt32BE(4);
			const frameLength = FRAME_PREFIX_BYTES + headerLength + payloadLength;
			if (frameLength > MAX_FRAME_BYTES) {
				throw new Error(`PTY host frame of ${frameLength} bytes exceeds the ${MAX_FRAME_BYTES} byte limit.`);
			}
			if (this.buffered.byteLength < frameLength) {
				break;
			}
			const headerEnd = FRAME_PREFIX_BYTES + headerLength;
			const header = JSON.parse(this.buffered.subarray(FRAME_PREFIX_BYTES, headerEnd).toString("utf8")) as T;
			const payload = Buffer.from(this.buffered.subarray(headerEnd, frameLength));
			frames.push({ header, payload });
			this.buffered = this.buffered.subarray(frameLength);
		}
		return frames;
	}
}
