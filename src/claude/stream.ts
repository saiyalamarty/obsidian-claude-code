import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import type { StreamMessage } from "./types";

export type StreamHandler = (msg: StreamMessage) => void;
export type StreamErrorHandler = (line: string, err: unknown) => void;

export function readNdjson(
	stream: Readable,
	onMessage: StreamHandler,
	onError?: StreamErrorHandler,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const rl = createInterface({ input: stream, crlfDelay: Infinity });
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			try {
				const parsed = JSON.parse(trimmed) as StreamMessage;
				onMessage(parsed);
			} catch (err) {
				if (onError) onError(trimmed, err);
				else console.error("[claude-code] failed to parse line", trimmed, err);
			}
		});
		rl.on("close", () => resolve());
		rl.on("error", reject);
	});
}
