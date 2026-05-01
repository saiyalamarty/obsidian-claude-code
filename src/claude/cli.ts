import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode } from "../settings";
import { readNdjson } from "./stream";
import { resolveBinary } from "./resolve-binary";
import type { ContentBlock, StreamMessage } from "./types";
import { log } from "../log";

export interface RunTurnOptions {
	binary: string;
	cwd: string;
	prompt?: string;
	contentBlocks?: ContentBlock[];
	resumeSessionId?: string;
	permissionMode?: PermissionMode;
	model?: string;
	effort?: string;
	approvalPort?: number;
}

export interface ClaudeTurn extends EventEmitter {
	on(event: "message", cb: (msg: StreamMessage) => void): this;
	on(event: "stderr", cb: (line: string) => void): this;
	on(event: "exit", cb: (code: number | null) => void): this;
	on(event: "error", cb: (err: Error) => void): this;
	kill(signal?: NodeJS.Signals): void;
}

type ClaudeChild =
	| ChildProcessByStdio<null, Readable, Readable>
	| ChildProcessByStdio<Writable, Readable, Readable>;

class ClaudeTurnImpl extends EventEmitter implements ClaudeTurn {
	private child: ClaudeChild;
	private settingsFile: string | null;

	constructor(child: ClaudeChild, settingsFile: string | null) {
		super();
		this.child = child;
		this.settingsFile = settingsFile;

		readNdjson(
			child.stdout,
			(msg) => this.emit("message", msg),
			(line, err) => this.emit("stderr", `[parse-error] ${line}: ${String(err)}`),
		).catch((err) => this.emit("error", err instanceof Error ? err : new Error(String(err))));

		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (line.trim()) this.emit("stderr", line);
			}
		});

		child.on("error", (err) => this.emit("error", err));
		child.on("exit", (code) => {
			this.emit("exit", code);
			this.cleanup();
		});
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (!this.child.killed) this.child.kill(signal);
	}

	private cleanup(): void {
		if (this.settingsFile) {
			try {
				unlinkSync(this.settingsFile);
			} catch {
				/* noop */
			}
			this.settingsFile = null;
		}
	}
}

export function runTurn(opts: RunTurnOptions): ClaudeTurn {
	const useStreamInput = !!opts.contentBlocks && opts.contentBlocks.length > 0;

	const args: string[] = ["-p"];
	if (useStreamInput) {
		args.push("--input-format", "stream-json");
	} else if (opts.prompt !== undefined) {
		args.push(opts.prompt);
	}
	args.push("--output-format", "stream-json", "--verbose");

	if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
	if (opts.permissionMode && opts.permissionMode !== "default") {
		args.push("--permission-mode", opts.permissionMode);
	}
	if (opts.model) args.push("--model", opts.model);
	if (opts.effort) args.push("--effort", opts.effort);

	let settingsFile: string | null = null;
	if (opts.approvalPort) {
		settingsFile = writeApprovalSettings(opts.approvalPort);
		args.push("--settings", settingsFile);
	}

	const binary = resolveBinary(opts.binary);
	log("[claude-code:spawn]", binary, ...args.map((a) => (a.includes(" ") ? `"${a}"` : a)));
	const child = spawn(binary, args, {
		cwd: opts.cwd,
		env: process.env,
		stdio: useStreamInput ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
	});

	if (useStreamInput && opts.contentBlocks) {
		const message = {
			type: "user",
			message: {
				role: "user",
				content: opts.contentBlocks,
			},
		};
		const stdin = (child as ChildProcessByStdio<Writable, Readable, Readable>).stdin;
		stdin.write(JSON.stringify(message) + "\n");
		stdin.end();
	}

	return new ClaudeTurnImpl(child as ClaudeChild, settingsFile);
}

function writeApprovalSettings(port: number): string {
	const settings = {
		hooks: {
			PreToolUse: [
				{
					matcher: ".*",
					hooks: [
						{
							type: "command",
							command: `curl -s -X POST -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:${port}/approve`,
							timeout: 600,
						},
					],
				},
			],
		},
	};
	const path = join(tmpdir(), `claude-code-obsidian-${port}-${Date.now()}.json`);
	writeFileSync(path, JSON.stringify(settings), "utf-8");
	return path;
}
