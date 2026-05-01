import { EventEmitter } from "node:events";
import type {
	AssistantMessage,
	ContentBlock,
	StreamMessage,
	ToolUseBlock,
	UserMessage,
} from "./types";
import { runTurn, type ClaudeTurn } from "./cli";
import type { PermissionMode } from "../settings";
import {
	PermissionServer,
	type Decision,
	type PermissionRequest,
} from "./permission-server";
import { log } from "../log";

export interface DisplayMessage {
	id: string;
	role: "user" | "assistant" | "system";
	blocks: ContentBlock[];
	streaming: boolean;
	timestamp: number;
}

export interface SessionOptions {
	binary: string;
	cwd: string;
	permissionMode: PermissionMode;
	model?: string;
	permissionServer: PermissionServer;
}

interface PendingApproval {
	requestId: string;
	toolUseId: string;
}

let displayMessageCounter = 0;
const nextId = (): string => `m${++displayMessageCounter}`;

export class Session extends EventEmitter {
	private opts: SessionOptions;
	private currentTurn: ClaudeTurn | null = null;
	private permissionServer: PermissionServer;
	private unmatchedRequests: PermissionRequest[] = [];
	private resolvedToolUseIds = new Set<string>();
	pendingApprovals = new Map<string, PendingApproval>();
	sessionId: string | null = null;
	messages: DisplayMessage[] = [];

	constructor(opts: SessionOptions) {
		super();
		this.opts = opts;
		this.permissionServer = opts.permissionServer;

		this.permissionServer.on("request", this.onApprovalRequest);
		this.permissionServer.on("cancel", this.onApprovalCancel);
	}

	dispose(): void {
		this.permissionServer.off("request", this.onApprovalRequest);
		this.permissionServer.off("cancel", this.onApprovalCancel);
		this.stop();
	}

	get busy(): boolean {
		return this.currentTurn !== null;
	}

	send(
		prompt: string,
		overrides?: {
			model?: string;
			effort?: string;
			attachments?: Array<{ mediaType: string; base64: string }>;
		},
	): void {
		const blocks: ContentBlock[] = [];
		if (prompt.trim().length > 0) blocks.push({ type: "text", text: prompt });
		for (const att of overrides?.attachments ?? []) {
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: att.mediaType, data: att.base64 },
			});
		}
		this.sendBlocks(blocks, overrides);
	}

	sendBlocks(
		blocks: ContentBlock[],
		overrides?: { model?: string; effort?: string },
	): void {
		if (this.busy) throw new Error("turn already in progress");
		if (blocks.length === 0) return;

		const userMsg: DisplayMessage = {
			id: nextId(),
			role: "user",
			blocks,
			streaming: false,
			timestamp: Date.now(),
		};
		this.messages.push(userMsg);
		this.emit("message-added", userMsg);

		const model = overrides?.model || this.opts.model || undefined;
		const effort = overrides?.effort || undefined;

		const turn = runTurn({
			binary: this.opts.binary,
			cwd: this.opts.cwd,
			contentBlocks: blocks,
			resumeSessionId: this.sessionId ?? undefined,
			permissionMode: this.opts.permissionMode,
			model,
			effort,
			approvalPort: this.permissionServer.getPort(),
		});
		this.currentTurn = turn;

		turn.on("message", (msg) => this.handleStreamMessage(msg));
		turn.on("stderr", (line) => this.emit("stderr", line));
		turn.on("error", (err) => {
			this.emit("error", err);
			this.currentTurn = null;
			this.emit("turn-end");
		});
		turn.on("exit", (code) => {
			this.currentTurn = null;
			this.emit("turn-end", code);
		});

		this.emit("turn-start");
	}

	stop(): void {
		this.currentTurn?.kill();
	}

	loadHistory(
		history: { role: "user" | "assistant"; blocks: ContentBlock[]; timestamp?: number }[],
	): void {
		for (const m of history) {
			const dm: DisplayMessage = {
				id: nextId(),
				role: m.role,
				blocks: m.blocks,
				streaming: false,
				timestamp: m.timestamp ?? Date.now(),
			};
			this.messages.push(dm);
		}
		this.emit("history-loaded", history.length);
	}

	decide(toolUseId: string, decision: Decision): boolean {
		const pending = this.pendingApprovals.get(toolUseId);
		if (!pending) return false;
		this.pendingApprovals.delete(toolUseId);
		this.resolvedToolUseIds.add(toolUseId);
		this.emit("approval-resolved", { toolUseId, decision });
		return this.permissionServer.resolve(pending.requestId, decision);
	}

	private handleStreamMessage(msg: StreamMessage): void {
		log("[claude-code:stream]", msg.type, summarizeMsg(msg));
		if (msg.session_id && !this.sessionId) {
			this.sessionId = msg.session_id;
			this.emit("session-id", this.sessionId);
		}

		if (msg.type === "system") {
			return;
		}
		if (msg.type === "result") {
			this.emit("result", msg);
			return;
		}
		if (msg.type === "assistant") {
			this.appendAssistant(msg);
			return;
		}
		if (msg.type === "user") {
			this.appendToolResults(msg);
			return;
		}
	}

	private appendAssistant(msg: AssistantMessage): void {
		const dm: DisplayMessage = {
			id: nextId(),
			role: "assistant",
			blocks: msg.message.content,
			streaming: false,
			timestamp: Date.now(),
		};
		this.messages.push(dm);
		this.emit("message-added", dm);
		this.retryUnmatchedRequests();
	}

	private appendToolResults(msg: UserMessage): void {
		const dm: DisplayMessage = {
			id: nextId(),
			role: "user",
			blocks: msg.message.content,
			streaming: false,
			timestamp: Date.now(),
		};
		this.messages.push(dm);
		this.emit("message-added", dm);
	}

	finalizeStreamingMessage(): void {
		const last = this.messages[this.messages.length - 1];
		if (last && last.role === "assistant" && last.streaming) {
			last.streaming = false;
			this.emit("message-updated", last);
		}
	}

	private onApprovalRequest = (req: PermissionRequest): void => {
		const matched = this.tryMatch(req);
		log(
			"[claude-code:session] approval request",
			req.id,
			req.payload.tool_name,
			matched ? "matched" : "queued",
		);
		if (!matched) {
			this.unmatchedRequests.push(req);
		}
	};

	private onApprovalCancel = (requestId: string): void => {
		this.unmatchedRequests = this.unmatchedRequests.filter((r) => r.id !== requestId);
		for (const [toolUseId, pending] of this.pendingApprovals) {
			if (pending.requestId === requestId) {
				this.pendingApprovals.delete(toolUseId);
				this.emit("approval-resolved", { toolUseId, decision: { kind: "cancelled" } });
				break;
			}
		}
	};

	private retryUnmatchedRequests(): void {
		if (this.unmatchedRequests.length === 0) return;
		const remaining: PermissionRequest[] = [];
		for (const req of this.unmatchedRequests) {
			if (!this.tryMatch(req)) remaining.push(req);
		}
		this.unmatchedRequests = remaining;
	}

	private tryMatch(req: PermissionRequest): boolean {
		const reqSessionId = typeof req.payload.session_id === "string" ? req.payload.session_id : null;
		if (this.sessionId && reqSessionId && reqSessionId !== this.sessionId) {
			return false;
		}
		const toolName = req.payload.tool_name;
		const inputKey = stableStringify(req.payload.tool_input ?? {});

		for (let i = this.messages.length - 1; i >= 0; i--) {
			const m = this.messages[i];
			if (!m || m.role !== "assistant") continue;
			for (let j = m.blocks.length - 1; j >= 0; j--) {
				const b = m.blocks[j];
				if (!b || b.type !== "tool_use") continue;
				if (b.name !== toolName) continue;
				if (this.pendingApprovals.has(b.id)) continue;
				if (this.resolvedToolUseIds.has(b.id)) continue;
				if (stableStringify(b.input) !== inputKey) continue;

				this.pendingApprovals.set(b.id, { requestId: req.id, toolUseId: b.id });
				this.emit("approval-needed", { toolUseId: b.id, requestId: req.id });
				return true;
			}
		}
		return false;
	}

	pendingToolUses(): ToolUseBlock[] {
		const out: ToolUseBlock[] = [];
		for (const m of this.messages) {
			if (m.role !== "assistant") continue;
			for (const b of m.blocks) {
				if (b.type === "tool_use") out.push(b);
			}
		}
		return out;
	}
}

function summarizeMsg(msg: StreamMessage): string {
	if (msg.type === "assistant") {
		const blocks = msg.message.content.map((b) => {
			if (b.type === "text") return `text(${b.text.length}c)`;
			if (b.type === "thinking") return `thinking(${b.thinking.length}c)`;
			if (b.type === "tool_use") return `tool_use(${b.name})`;
			if (b.type === "tool_result") return `tool_result`;
			return "?";
		});
		return blocks.join("+");
	}
	if (msg.type === "user") {
		const blocks = msg.message.content.map((b) =>
			b.type === "tool_result" ? "tool_result" : b.type,
		);
		return blocks.join("+");
	}
	if (msg.type === "result") return `${msg.subtype ?? ""} err=${msg.is_error ?? false}`;
	if (msg.type === "system") return msg.subtype ?? "";
	return "";
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const parts = keys.map(
		(k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
	);
	return `{${parts.join(",")}}`;
}
