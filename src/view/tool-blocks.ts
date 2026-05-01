import { MarkdownRenderer, type App, type Component } from "obsidian";
import type { FileContents } from "@pierre/diffs";
import { renderDiff, type FileRenderSpec } from "../diff/render";
import type { ToolUseBlock, ToolResultBlock } from "../claude/types";
import type { ClaudeCodeSettings } from "../settings";

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
	return typeof v === "number" ? v : fallback;
}

export type ApprovalState =
	| { kind: "none" }
	| { kind: "pending" }
	| { kind: "approved" }
	| { kind: "denied"; reason?: string }
	| { kind: "cancelled" };

export interface ToolBlockContext {
	app: App;
	component: Component;
	settings: ClaudeCodeSettings;
	approvalState?: (toolUseId: string) => ApprovalState;
	onApprove?: (toolUseId: string) => void;
	onDeny?: (toolUseId: string, reason?: string) => void;
	onToolCalloutMounted?: (toolUseId: string, contentEl: HTMLElement) => void;
}

export function renderToolUse(
	host: HTMLElement,
	block: ToolUseBlock,
	ctx: ToolBlockContext,
): void {
	const state = ctx.approvalState?.(block.id) ?? { kind: "none" };
	const meta = toolMetadata(block);
	const wrap = host.createDiv({ cls: "claude-code-tool-wrap" });
	const calloutHost = wrap.createDiv({ cls: "claude-code-tool-callout-host" });

	const collapsed = state.kind === "approved" || state.kind === "denied";

	void mountCallout(calloutHost, ctx, {
		type: meta.callout,
		title: meta.title,
		collapsible: true,
		collapsedByDefault: collapsed,
		extraClasses: [
			"claude-code-tool",
			`claude-code-tool-${meta.kind}`,
			`claude-code-approval-${state.kind}`,
		],
		titleSuffix: state.kind !== "none" ? approvalTagText(state) : undefined,
		titleSuffixClass:
			state.kind !== "none" ? `claude-code-approval-tag-${state.kind}` : undefined,
		onContentReady: (content) => ctx.onToolCalloutMounted?.(block.id, content),
		fill: (content) => {
			switch (meta.kind) {
				case "edit":
					renderEditDiff(content, block, ctx);
					break;
				case "write":
					renderWriteDiff(content, block, ctx);
					break;
				case "read":
					renderReadBlock(content, block, ctx);
					break;
				case "bash":
					renderBashBlock(content, block);
					break;
				case "search":
					renderSearchBlock(content, block);
					break;
				case "todo":
					renderTodoBlock(content, block);
					break;
				case "task":
					renderTaskBlock(content, block);
					break;
				case "mcp":
				case "generic":
				default:
					renderGenericBlock(content, block);
			}
		},
	});

	if (state.kind === "pending" && ctx.onApprove && ctx.onDeny) {
		const approvalHost = wrap.createDiv({ cls: "claude-code-tool-approval-host" });
		renderApprovalControls(approvalHost, block, ctx);
	}
}

export function renderInlineToolResult(host: HTMLElement, block: ToolResultBlock): void {
	host.querySelector(":scope > .claude-code-inline-result")?.remove();
	const wrap = host.createDiv({
		cls: `claude-code-inline-result${block.is_error ? " is-error" : ""}`,
	});
	const text =
		typeof block.content === "string"
			? block.content
			: block.content
					.map((b) => (b.type === "text" ? b.text : JSON.stringify(b, null, 2)))
					.join("\n");
	wrap.createEl("pre", { text });
}


// ---- callout helper (uses MarkdownRenderer for native shell) ----

interface MountCalloutOptions {
	type: string;
	title: string;
	collapsible: boolean;
	collapsedByDefault?: boolean;
	extraClasses?: string[];
	titleSuffix?: string;
	titleSuffixClass?: string;
	fill: (content: HTMLElement) => void;
	onContentReady?: (content: HTMLElement) => void;
}

async function mountCallout(
	wrap: HTMLElement,
	ctx: ToolBlockContext,
	opts: MountCalloutOptions,
): Promise<void> {
	const fold = opts.collapsible ? (opts.collapsedByDefault ? "-" : "+") : "";
	const safeTitle = opts.title.replace(/\r?\n/g, " ").trim();
	// Include a placeholder body line so MarkdownRenderer creates a `.callout-content` div.
	const md = `> [!${opts.type}]${fold} ${safeTitle}\n> \u200B`;

	const scratch = createDiv();
	try {
		await MarkdownRenderer.render(ctx.app, md, scratch, "", ctx.component);
	} catch (err) {
		console.error("[claude-code] callout render failed", err);
		wrap.createEl("pre", { text: `${opts.title}\n${String(err)}` });
		return;
	}

	if (!wrap.isConnected) return;

	const callout = scratch.querySelector<HTMLElement>(".callout");
	if (!callout) {
		wrap.appendChild(scratch);
		return;
	}
	wrap.empty();
	wrap.appendChild(callout);

	if (opts.extraClasses) {
		for (const c of opts.extraClasses) if (c) callout.addClass(c);
	}

	if (opts.titleSuffix && opts.titleSuffix.trim().length > 0) {
		const titleEl = callout.querySelector(".callout-title");
		if (titleEl) {
			const titleInner = titleEl.querySelector(".callout-title-inner");
			const suffix = createSpan({
				cls: `claude-code-tool-suffix ${opts.titleSuffixClass ?? ""}`,
				text: opts.titleSuffix,
			});
			if (titleInner && titleInner.nextSibling) {
				titleEl.insertBefore(suffix, titleInner.nextSibling);
			} else {
				titleEl.appendChild(suffix);
			}
		}
	}

	let content = callout.querySelector<HTMLElement>(".callout-content");
	if (!content) {
		content = callout.createDiv({ cls: "callout-content" });
	}
	content.empty();
	opts.fill(content);
	opts.onContentReady?.(content);
}

// ---- tool name resolution ----

interface ToolMeta {
	kind:
		| "edit"
		| "write"
		| "read"
		| "bash"
		| "search"
		| "todo"
		| "task"
		| "mcp"
		| "generic";
	title: string;
	callout: string;
}

function toolMetadata(block: ToolUseBlock): ToolMeta {
	const make = (kind: ToolMeta["kind"], title: string): ToolMeta => ({
		kind,
		title,
		callout: `tool-${kind === "edit" || kind === "write" ? "edit" : kind}`,
	});
	switch (block.name) {
		case "Edit":
			return make("edit", `Edit · ${basename(asString(block.input.file_path))}`);
		case "Write":
			return make("write", `Write · ${basename(asString(block.input.file_path))}`);
		case "Read":
			return make("read", `Read · ${basename(asString(block.input.file_path))}`);
		case "Bash":
			return make("bash", "Bash");
		case "BashOutput":
			return make("bash", "Bash output");
		case "KillShell":
			return make("bash", "Kill shell");
		case "Grep":
			return make("search", "Grep");
		case "Glob":
			return make("search", "Glob");
		case "WebSearch":
			return make("search", "Web search");
		case "WebFetch":
			return make("search", "Web fetch");
		case "TodoWrite":
			return make("todo", "Todos");
		case "Task":
			return make("task", "Subagent task");
		case "ExitPlanMode":
			return make("generic", "Exit plan mode");
		case "AskUserQuestion":
			return make("generic", "Ask user");
		case "SlashCommand":
			return make("generic", `Slash: ${asString(block.input.command)}`);
	}
	if (block.name.startsWith("mcp__")) {
		return make("mcp", prettyMcpName(block.name));
	}
	return make("generic", block.name);
}

function prettyMcpName(name: string): string {
	const rest = name.slice("mcp__".length);
	const parts = rest.split("__");
	if (parts.length < 2) return name;
	const server = humanize(parts[0] ?? "");
	const tool = humanize(parts.slice(1).join("__"));
	return `${server} · ${tool}`;
}

function humanize(s: string): string {
	return s.replace(/^claude_ai_/, "").replace(/_/g, " ");
}

function basename(p: string): string {
	if (!p) return "";
	const idx = p.lastIndexOf("/");
	return idx >= 0 ? p.slice(idx + 1) : p;
}

// ---- approval ----

function approvalTagText(state: ApprovalState): string {
	switch (state.kind) {
		case "pending":
			return "approval needed";
		case "approved":
			return "approved";
		case "denied":
			return "rejected";
		case "cancelled":
			return "cancelled";
		default:
			return "";
	}
}

function renderApprovalControls(
	host: HTMLElement,
	block: ToolUseBlock,
	ctx: ToolBlockContext,
): void {
	const controls = host.createDiv({ cls: "claude-code-approval-controls" });
	const denyBtn = controls.createEl("button", {
		text: "REJECT",
		cls: "claude-code-approval-deny",
	});
	const approveBtn = controls.createEl("button", {
		text: "APPROVE",
		cls: "claude-code-approval-approve",
	});
	approveBtn.addEventListener("click", () => ctx.onApprove?.(block.id));
	denyBtn.addEventListener("click", () => ctx.onDeny?.(block.id));
}

// ---- block-specific renderers ----

function renderEditDiff(host: HTMLElement, block: ToolUseBlock, ctx: ToolBlockContext): void {
	const filePath = asString(block.input.file_path);
	const oldString = asString(block.input.old_string);
	const newString = asString(block.input.new_string);

	renderFilePath(host, ctx, filePath);
	const diffHost = host.createDiv({ cls: "claude-code-diff-host" });
	const spec: FileRenderSpec = {
		name: filePath,
		oldFile: { name: filePath, contents: oldString } as FileContents,
		newFile: { name: filePath, contents: newString } as FileContents,
	};
	mountDiff(diffHost, [spec], ctx);
}

function renderWriteDiff(host: HTMLElement, block: ToolUseBlock, ctx: ToolBlockContext): void {
	const filePath = asString(block.input.file_path);
	const content = asString(block.input.content);

	renderFilePath(host, ctx, filePath);
	const diffHost = host.createDiv({ cls: "claude-code-diff-host" });
	const spec: FileRenderSpec = {
		name: filePath,
		oldFile: { name: filePath, contents: "" } as FileContents,
		newFile: { name: filePath, contents: content } as FileContents,
	};
	mountDiff(diffHost, [spec], ctx);
}

function renderReadBlock(host: HTMLElement, block: ToolUseBlock, ctx: ToolBlockContext): void {
	const filePath = asString(block.input.file_path);
	const offset = block.input.offset;
	const limit = block.input.limit;
	const range =
		offset !== undefined || limit !== undefined
			? ` (offset ${asNumber(offset)}${limit !== undefined ? `, limit ${asNumber(limit)}` : ""})`
			: "";
	renderFilePath(host, ctx, filePath, range);
}

function renderFilePath(
	host: HTMLElement,
	ctx: ToolBlockContext,
	filePath: string,
	suffix = "",
): void {
	if (!filePath) return;
	const wrap = host.createDiv({ cls: "claude-code-tool-path" });
	const link = wrap.createEl("a", {
		cls: "claude-code-tool-pathlink",
		text: filePath,
		attr: { href: "#" },
	});
	link.addEventListener("click", (e) => {
		e.preventDefault();
		void openPathInVault(ctx, filePath);
	});
	if (suffix) wrap.createSpan({ text: suffix, cls: "claude-code-tool-path-suffix" });
}

async function openPathInVault(ctx: ToolBlockContext, filePath: string): Promise<void> {
	const adapter = ctx.app.vault.adapter as {
		basePath?: string;
		getBasePath?: () => string;
	};
	const base =
		typeof adapter.getBasePath === "function"
			? adapter.getBasePath()
			: typeof adapter.basePath === "string"
				? adapter.basePath
				: null;
	let target = filePath;
	if (base && filePath.startsWith(base)) {
		target = filePath.slice(base.length).replace(/^\/+/, "");
	}
	await ctx.app.workspace.openLinkText(target, "", false);
}

function renderBashBlock(host: HTMLElement, block: ToolUseBlock): void {
	const command = asString(block.input.command);
	const description = asString(block.input.description);
	if (description) {
		host.createDiv({ cls: "claude-code-tool-desc", text: description });
	}
	const code = host.createEl("pre", { cls: "claude-code-tool-cmd" });
	code.createEl("code", { text: command });
	if (block.input.run_in_background) {
		host.createDiv({ cls: "claude-code-tool-tag", text: "background" });
	}
}

function renderSearchBlock(host: HTMLElement, block: ToolUseBlock): void {
	const pattern =
		asString(block.input.pattern) ||
		asString(block.input.query) ||
		asString(block.input.url);
	const path = asString(block.input.path);
	const suffix = path ? ` in ${path}` : "";
	host.createDiv({ cls: "claude-code-tool-query", text: `${pattern}${suffix}` });
}

function renderTodoBlock(host: HTMLElement, block: ToolUseBlock): void {
	const todos = (block.input.todos ?? []) as Array<{
		content: string;
		status: "pending" | "in_progress" | "completed";
		activeForm?: string;
	}>;
	const list = host.createEl("ul", { cls: "claude-code-todos" });
	for (const t of todos) {
		const li = list.createEl("li", { cls: `is-${t.status}` });
		const sym = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○";
		li.createSpan({ cls: "claude-code-todo-status", text: sym });
		li.createSpan({ cls: "claude-code-todo-text", text: t.content });
	}
}

function renderTaskBlock(host: HTMLElement, block: ToolUseBlock): void {
	const description = asString(block.input.description);
	const subagentType = asString(block.input.subagent_type);
	const subagent = subagentType ? ` (${subagentType})` : "";
	host.createDiv({ cls: "claude-code-tool-desc", text: `${description}${subagent}` });
	const prompt = asString(block.input.prompt);
	if (prompt) {
		host.createEl("pre", {
			cls: "claude-code-tool-json",
			text: prompt,
		});
	}
}

function renderGenericBlock(host: HTMLElement, block: ToolUseBlock): void {
	if (Object.keys(block.input).length === 0) return;
	host.createEl("pre", {
		cls: "claude-code-tool-json",
		text: JSON.stringify(block.input, null, 2),
	});
}

// ---- helpers ----

function mountDiff(host: HTMLElement, specs: FileRenderSpec[], ctx: ToolBlockContext): void {
	void renderDiff(host, specs, {
		diffStyle: ctx.settings.diffStyle,
		overflow: ctx.settings.diffOverflow,
		loadLargeFile: async () => ({}),
		onFileClick: (path) => void openPathInVault(ctx, path),
	}).catch((err) => {
		console.error("[claude-code] diff render failed", err);
		host.createEl("pre", { text: `diff render failed: ${String(err)}` });
	});
}

