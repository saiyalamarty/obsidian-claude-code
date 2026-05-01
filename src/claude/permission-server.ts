import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { log } from "../log";

export interface HookPayload {
	session_id?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	transcript_path?: string;
	cwd?: string;
	[key: string]: unknown;
}

export interface PermissionRequest {
	id: string;
	payload: HookPayload;
}

export type Decision =
	| { kind: "approve" }
	| { kind: "deny"; reason: string }
	| { kind: "ask" };

const SAFE_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
	"BashOutput",
	"KillShell",
	"TodoWrite",
	"ExitPlanMode",
	"SlashCommand",
	"AskUserQuestion",
]);

export class PermissionServer extends EventEmitter {
	private server: Server | null = null;
	private port: number | null = null;
	private pending = new Map<string, ServerResponse>();
	private nextId = 1;

	getPort(): number {
		if (this.port === null) throw new Error("server not started");
		return this.port;
	}

	async start(): Promise<number> {
		if (this.server) return this.port!;
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => {
				void this.handle(req, res);
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (!addr || typeof addr === "string") {
					reject(new Error("could not bind port"));
					return;
				}
				this.server = server;
				this.port = addr.port;
				resolve(addr.port);
			});
		});
	}

	stop(): void {
		for (const res of this.pending.values()) {
			try {
				this.writeDecision(res, { kind: "deny", reason: "Plugin shutting down" });
			} catch {
				/* noop */
			}
		}
		this.pending.clear();
		this.server?.close();
		this.server = null;
		this.port = null;
	}

	resolve(id: string, decision: Decision): boolean {
		const res = this.pending.get(id);
		if (!res) return false;
		this.pending.delete(id);
		this.writeDecision(res, decision);
		return true;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== "POST" || req.url !== "/approve") {
			res.statusCode = 404;
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}
		let payload: HookPayload;
		try {
			payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as HookPayload;
		} catch {
			res.statusCode = 400;
			res.end();
			return;
		}

		const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
		log("[claude-code:perm] hook arrived", {
			tool: toolName,
			input: payload.tool_input,
		});
		if (SAFE_TOOLS.has(toolName)) {
			log("[claude-code:perm] auto-approving safe tool", toolName);
			this.writeDecision(res, { kind: "approve" });
			return;
		}

		const id = `req-${this.nextId++}`;
		this.pending.set(id, res);
		req.on("close", () => {
			if (this.pending.delete(id)) {
				log("[claude-code:perm] hook curl disconnected before decision", id);
				this.emit("cancel", id);
			}
		});
		this.emit("request", { id, payload } as PermissionRequest);
	}

	private writeDecision(res: ServerResponse, decision: Decision): void {
		const body = renderHookOutput(decision);
		log("[claude-code:perm] writing decision", body);
		res.setHeader("content-type", "application/json");
		res.statusCode = 200;
		res.end(JSON.stringify(body));
	}
}

function renderHookOutput(decision: Decision): Record<string, unknown> {
	if (decision.kind === "approve") {
		return {
			decision: "approve",
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
			},
		};
	}
	if (decision.kind === "deny") {
		return {
			decision: "block",
			reason: decision.reason,
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: decision.reason,
			},
		};
	}
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "ask",
		},
	};
}
