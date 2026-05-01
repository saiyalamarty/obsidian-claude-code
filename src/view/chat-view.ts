import { ItemView, MarkdownRenderer, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeCodePlugin from "../main";
import { Session, type DisplayMessage } from "../claude/session";
import type { ContentBlock, ResultMessage } from "../claude/types";
import { EFFORT_OPTIONS, MODEL_OPTIONS } from "../settings";
import {
	renderToolUse,
	renderInlineToolResult,
	type ApprovalState,
	type ToolBlockContext,
} from "./tool-blocks";
import type { ToolResultBlock } from "../claude/types";
import type { Decision } from "../claude/permission-server";
import { log } from "../log";
import {
	listRecentSessions,
	loadSessionTitle,
	loadSessionTranscript,
	type RecentSession,
} from "../claude/sessions";
import { FileMentionSuggest } from "./file-suggest";
import { SlashCommandSuggest } from "./slash-suggest";
import { loadClaudeFileDefaults, type ClaudeFileDefaults } from "../claude/claude-config";

export const CLAUDE_CODE_VIEW_TYPE = "claude-code-chat";

const SCROLL_AT_BOTTOM_THRESHOLD = 80;

export class ChatView extends ItemView {
	plugin: ClaudeCodePlugin;
	session: Session | null = null;
	private scrollEl!: HTMLElement;
	private emptyStateEl: HTMLElement | null = null;
	private composerEl!: HTMLDivElement;
	private composerWrapEl!: HTMLElement;
	private composerCardEl!: HTMLElement;
	private fileInputEl!: HTMLInputElement;
	private attachmentsById = new Map<string, {
		kind: "image" | "document";
		mediaType: string;
		base64: string;
		previewUrl: string;
		filename: string;
		saveToVault: boolean;
	}>();
	private sendBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private newMessagesPill: HTMLElement | null = null;
	private messageEls = new Map<string, HTMLElement>();
	private approvalStates = new Map<string, ApprovalState>();
	private toolUseToMessage = new Map<string, string>();
	private toolCalloutContents = new Map<string, HTMLElement>();
	private toolResultsByUseId = new Map<string, ToolResultBlock>();
	private title = "Claude Code";
	private fileSuggest: FileMentionSuggest | null = null;
	private slashSuggest: SlashCommandSuggest | null = null;
	private modelPillBtn!: HTMLButtonElement;
	private currentModel = "";
	private currentEffort = "";
	private scrollDownBtn!: HTMLButtonElement;
	private claudeFileDefaults: ClaudeFileDefaults = {};
	private typingEl: HTMLElement | null = null;
	private earlierBtnEl: HTMLElement | null = null;
	private renderedHistoryFrom = 0;
	private suppressAutoScroll = false;
	private wasAtBottom = true;

	constructor(leaf: WorkspaceLeaf, plugin: ClaudeCodePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.addAction("plus", "New chat", () => void this.startNewChat());
		this.addAction("download", "Export chat to note", () => void this.exportChat());
	}

	getViewType(): string {
		return CLAUDE_CODE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.title;
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("claude-code-chat", "markdown-rendered", "markdown-preview-view");

		this.scrollEl = root.createDiv({ cls: "claude-code-scroll" });
		this.scrollEl.addEventListener("scroll", () => {
			this.wasAtBottom = this.isScrolledToBottom();
			if (this.wasAtBottom && this.newMessagesPill) {
				this.newMessagesPill.remove();
				this.newMessagesPill = null;
			}
			this.updateScrollDownButton();
		});

		this.composerWrapEl = root.createDiv({ cls: "claude-code-composer" });
		this.composerCardEl = this.composerWrapEl.createDiv({ cls: "claude-code-composer-card" });
		this.composerEl = this.composerCardEl.createDiv({
			cls: "claude-code-input",
			attr: {
				contenteditable: "true",
				role: "textbox",
				"aria-multiline": "true",
				"data-placeholder": "Ask Claude…  (paste, drop or attach images, @ for files, / for commands)",
			},
		}) as HTMLDivElement;

		this.fileInputEl = this.composerCardEl.createEl("input", {
			attr: {
				type: "file",
				multiple: "true",
				accept: "image/*,application/pdf",
				style: "display:none",
			},
		});
		this.fileInputEl.addEventListener("change", () => void this.handleFileInput());

		const bar = this.composerCardEl.createDiv({ cls: "claude-code-composer-bar" });

		const attachBtn = bar.createEl("button", {
			cls: "claude-code-attach-btn",
			attr: { "aria-label": "Attach image" },
		});
		setIcon(attachBtn, "paperclip");
		attachBtn.addEventListener("click", () => this.fileInputEl.click());

		this.modelPillBtn = bar.createEl("button", { cls: "claude-code-pill" });
		this.modelPillBtn.addEventListener("click", (e) => this.openModelEffortMenu(e));

		this.statusEl = bar.createDiv({ cls: "claude-code-status" });

		this.sendBtn = bar.createEl("button", {
			cls: "claude-code-send mod-cta",
			attr: { "aria-label": "Send" },
		});
		setIcon(this.sendBtn, "arrow-up");

		this.composerCardEl.addEventListener("dragover", (e) => {
			if (e.dataTransfer?.types.includes("Files")) {
				e.preventDefault();
				this.composerCardEl.addClass("is-dragging");
			}
		});
		this.composerCardEl.addEventListener("dragleave", (e) => {
			if (e.target === this.composerCardEl) this.composerCardEl.removeClass("is-dragging");
		});
		this.composerCardEl.addEventListener("drop", (e) => {
			e.preventDefault();
			this.composerCardEl.removeClass("is-dragging");
			void this.handleDrop(e);
		});

		this.scrollDownBtn = root.createEl("button", {
			cls: "claude-code-scroll-down-btn",
			attr: { "aria-label": "Scroll to latest" },
		});
		setIcon(this.scrollDownBtn, "arrow-down");
		this.scrollDownBtn.addEventListener("click", () => this.scrollToBottom());

		this.sendBtn.addEventListener("click", () => void this.handleSendOrStop());
		this.composerEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				if (this.fileSuggest?.isOpen() || this.slashSuggest?.isOpen()) return;
				e.preventDefault();
				void this.handleSendOrStop();
			}
		});
		this.composerEl.addEventListener("paste", (e) => void this.handlePaste(e));
		this.composerEl.addEventListener("input", () => this.syncAttachmentsFromDom());

		this.fileSuggest = new FileMentionSuggest(this.app, this.composerEl, this.composerWrapEl);
		const cwd = this.plugin.getWorkingDirectory();
		if (cwd) {
			this.slashSuggest = new SlashCommandSuggest(
				this.app,
				this.composerEl,
				this.composerWrapEl,
				cwd,
			);
			void loadClaudeFileDefaults(cwd).then((d) => {
				this.claudeFileDefaults = d;
				this.refreshDropdowns();
			});
		} else {
			this.refreshDropdowns();
		}

		this.ensureSession();
		void this.renderEmptyState();
	}

	private resolvedDefaultModel(): string {
		return this.plugin.settings.defaultModel || this.claudeFileDefaults.model || "";
	}

	private resolvedDefaultEffort(): string {
		return this.plugin.settings.defaultEffort || this.claudeFileDefaults.effort || "";
	}

	private refreshDropdowns(): void {
		this.currentModel = this.resolvedDefaultModel() || (MODEL_OPTIONS[0]?.value ?? "");
		this.currentEffort = this.resolvedDefaultEffort() || (EFFORT_OPTIONS[0]?.value ?? "");
		this.updatePillLabel();
	}

	private updatePillLabel(): void {
		this.modelPillBtn.empty();
		const iconEl = this.modelPillBtn.createSpan({ cls: "claude-code-pill-icon" });
		setIcon(iconEl, "zap");
		const modelLabel =
			MODEL_OPTIONS.find((m) => m.value === this.currentModel)?.label ??
			this.currentModel ??
			"";
		if (modelLabel) {
			this.modelPillBtn.createSpan({
				cls: "claude-code-pill-model",
				text: modelLabel,
			});
		}
		const effortLabel =
			EFFORT_OPTIONS.find((e) => e.value === this.currentEffort)?.label ??
			this.currentEffort ??
			"";
		if (effortLabel) {
			this.modelPillBtn.createSpan({
				cls: "claude-code-pill-effort",
				text: effortLabel,
			});
		}
		const chevronEl = this.modelPillBtn.createSpan({ cls: "claude-code-pill-chevron" });
		setIcon(chevronEl, "chevron-down");
	}

	private openModelEffortMenu(e: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle("Intelligence");
			item.setDisabled(true);
		});
		for (const opt of EFFORT_OPTIONS) {
			menu.addItem((item) => {
				item.setTitle(opt.label);
				item.setChecked(this.currentEffort === opt.value);
				item.onClick(() => {
					this.currentEffort = opt.value;
					this.updatePillLabel();
				});
			});
		}
		menu.addSeparator();
		menu.addItem((item) => {
			const currentLabel =
				MODEL_OPTIONS.find((m) => m.value === this.currentModel)?.label ??
				this.currentModel ??
				"Model";
			item.setTitle(currentLabel);
			item.setIcon("zap");
			const sub = (
				item as unknown as { setSubmenu: () => Menu }
			).setSubmenu();
			for (const opt of MODEL_OPTIONS) {
				sub.addItem((s) => {
					s.setTitle(opt.label);
					s.setChecked(this.currentModel === opt.value);
					s.onClick(() => {
						this.currentModel = opt.value;
						this.updatePillLabel();
					});
				});
			}
		});
		menu.showAtMouseEvent(e);
	}

	async onClose(): Promise<void> {
		this.fileSuggest?.dispose();
		this.fileSuggest = null;
		this.slashSuggest?.dispose();
		this.slashSuggest = null;
		this.session?.dispose();
		this.session = null;
		this.messageEls.clear();
		this.approvalStates.clear();
		this.toolUseToMessage.clear();
		this.toolCalloutContents.clear();
		this.toolResultsByUseId.clear();
		this.contentEl.empty();
	}

	private setTitle(title: string): void {
		const formatted = title === "Claude Code" || !title ? "Claude Code" : `Claude Code · ${title}`;
		if (this.title === formatted) return;
		this.title = formatted;

		const tabHeaderEl = (this.leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
		const tabTitleEl = tabHeaderEl?.querySelector<HTMLElement>(
			".workspace-tab-header-inner-title",
		);
		if (tabTitleEl) tabTitleEl.setText(formatted);
		if (tabHeaderEl) tabHeaderEl.setAttribute("aria-label", formatted);

		const leafContainer = (this.leaf as unknown as { containerEl?: HTMLElement }).containerEl;
		const viewHeader = leafContainer?.querySelector<HTMLElement>(".view-header-title");
		if (viewHeader) viewHeader.setText(formatted);

		// eslint-disable-next-line no-console
		console.log("[claude-code:title]", formatted, {
			tabFound: !!tabTitleEl,
			viewHeaderFound: !!viewHeader,
		});
	}

	private async exportChat(): Promise<void> {
		if (!this.session || this.session.messages.length === 0) {
			new Notice("Nothing to export.");
			return;
		}
		const sessionId = this.session.sessionId ?? "no-session";
		const title = this.title.replace(/^Claude Code · /, "").trim() || "Untitled chat";
		const safeTitle = sanitizeFilename(title);
		const stamp = formatTimestampId(Date.now());
		const filename = `${safeTitle || "chat"}-${stamp}.md`;
		const folder = "claude-code-chats";
		const path = `${folder}/${filename}`;
		try {
			if (!(await this.app.vault.adapter.exists(folder))) {
				await this.app.vault.createFolder(folder);
			}
			const md = renderChatToMarkdown(this.session.messages, {
				title,
				sessionId,
				exportedAt: new Date().toISOString(),
			});
			await this.app.vault.create(path, md);
			new Notice(`Exported to ${path}`);
			void this.app.workspace.openLinkText(path, "", false);
		} catch (err) {
			console.error("[claude-code] export failed", err);
			new Notice(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async startNewChat(): Promise<void> {
		this.session?.dispose();
		this.session = null;
		this.messageEls.clear();
		this.approvalStates.clear();
		this.toolUseToMessage.clear();
		this.toolCalloutContents.clear();
		this.toolResultsByUseId.clear();
		this.earlierBtnEl?.remove();
		this.earlierBtnEl = null;
		this.renderedHistoryFrom = 0;
		this.typingEl?.remove();
		this.typingEl = null;
		this.scrollEl.empty();
		this.setTitle("Claude Code");
		this.clearComposer();
		this.setStatus("", false);
		this.refreshDropdowns();
		this.ensureSession();
		await this.renderEmptyState();
		this.composerEl.focus();
	}

	private async renderEmptyState(): Promise<void> {
		const cwd = this.plugin.getWorkingDirectory();
		if (!cwd) return;
		this.emptyStateEl?.remove();
		const empty = this.scrollEl.createDiv({ cls: "claude-code-empty" });
		this.emptyStateEl = empty;

		const sessions = await listRecentSessions(cwd, 5);
		if (!this.emptyStateEl || this.emptyStateEl !== empty) return;

		empty.createEl("h3", {
			text: "What are we building?",
			cls: "claude-code-empty-title",
		});
		empty.createEl("p", {
			text: "Type below to start a new conversation, or pick up a recent thread.",
			cls: "claude-code-empty-hint",
		});

		if (sessions.length === 0) return;
		empty.createEl("h4", { text: "Recent sessions", cls: "claude-code-recent-title" });
		const list = empty.createDiv({ cls: "claude-code-recent-list" });

		const titlePromises = sessions.map((s) => loadSessionTitle(cwd, s.id));
		const titles = await Promise.all(titlePromises);

		sessions.forEach((s, i) => {
			const row = list.createDiv({ cls: "claude-code-recent-row" });
			const title = titles[i] ?? null;
			row.createDiv({
				cls: "claude-code-recent-preview",
				text: title ?? s.preview,
			});
			row.createDiv({ cls: "claude-code-recent-meta", text: relativeTime(s.mtimeMs) });
			row.addEventListener("click", () => this.resumeSession(s, title ?? null));
		});
	}

	private async resumeSession(s: RecentSession, knownTitle: string | null): Promise<void> {
		const session = this.ensureSession();
		const cwd = this.plugin.getWorkingDirectory();
		if (!cwd) return;

		session.sessionId = s.id;
		this.emptyStateEl?.remove();
		this.emptyStateEl = null;

		const banner = this.scrollEl.createDiv({ cls: "claude-code-resume-banner" });
		banner.createSpan({ text: "Loading session…" });

		try {
			const [history, title] = await Promise.all([
				loadSessionTranscript(cwd, s.id),
				knownTitle !== null ? Promise.resolve(knownTitle) : loadSessionTitle(cwd, s.id),
			]);
			this.seedHistoricalApprovals(history);
			session.loadHistory(history);
			banner.empty();
			banner.createSpan({ text: `Resumed · ${history.length} messages — ` });
			const display = title ?? truncate(s.preview, 50);
			banner.createSpan({
				cls: "claude-code-recent-preview",
				text: display,
			});
			this.setTitle(display);
		} catch (err) {
			console.error("[claude-code] failed to load transcript", err);
			banner.empty();
			banner.createSpan({ text: "Resumed (could not load history)" });
		}
		this.composerEl.focus();
	}

	private hideEmptyState(): void {
		this.emptyStateEl?.remove();
		this.emptyStateEl = null;
	}

	private seedHistoricalApprovals(
		history: { role: "user" | "assistant"; blocks: ContentBlock[] }[],
	): void {
		for (const m of history) {
			if (m.role !== "user") continue;
			for (const block of m.blocks) {
				if (block.type !== "tool_result") continue;
				this.approvalStates.set(
					block.tool_use_id,
					block.is_error
						? { kind: "denied", reason: "(error in history)" }
						: { kind: "approved" },
				);
			}
		}
	}

	private ensureSession(): Session {
		if (this.session) return this.session;
		const cwd = this.plugin.getWorkingDirectory();
		if (!cwd) {
			new Notice("Claude Code: no working directory resolved.");
			throw new Error("no working directory");
		}
		const session = new Session({
			binary: this.plugin.settings.claudeBinaryPath,
			cwd,
			permissionMode: this.plugin.settings.permissionMode,
			model: this.plugin.settings.defaultModel,
			permissionServer: this.plugin.permissionServer,
		});
		session.on("message-added", (m: DisplayMessage) => this.renderMessage(m));
		session.on("message-updated", (m: DisplayMessage) => this.renderMessage(m));
		session.on("turn-start", () => {
			this.setStatus("thinking…", true);
		});
		session.on("turn-end", (code: number | null) => {
			session.finalizeStreamingMessage();
			this.setStatus(code === 0 || code === null ? "" : `exited ${code}`, false);
		});
		session.on("session-id", (id: string) => {
			this.statusEl.setAttribute("aria-label", `session: ${id}`);
			void this.maybeUpdateTitleFromSession(id);
		});
		session.on("stderr", (line: string) => log("[claude-code:cli]", line));
		session.on("result", (r: ResultMessage) => {
			if (r.is_error) this.setStatus(`error: ${r.subtype ?? "unknown"}`, false);
			void this.maybeUpdateTitleFromSession(session.sessionId);
		});
		session.on("error", (err: Error) => {
			console.error("[claude-code]", err);
			new Notice(`Claude Code: ${err.message}`);
			this.setStatus(`error: ${err.message}`, false);
		});
		session.on("history-loaded", (count: number) => {
			void this.batchRenderHistory(count);
		});
		session.on("approval-needed", (e: { toolUseId: string }) => {
			this.approvalStates.set(e.toolUseId, { kind: "pending" });
			this.rerenderForToolUse(e.toolUseId);
		});
		session.on(
			"approval-resolved",
			(e: { toolUseId: string; decision: Decision | { kind: "cancelled" } }) => {
				this.approvalStates.set(e.toolUseId, this.decisionToState(e.decision));
				this.rerenderForToolUse(e.toolUseId);
			},
		);
		this.session = session;
		return session;
	}

	private async maybeUpdateTitleFromSession(sessionId: string | null): Promise<void> {
		if (!sessionId) return;
		const cwd = this.plugin.getWorkingDirectory();
		if (!cwd) return;
		const title = await loadSessionTitle(cwd, sessionId);
		if (title) this.setTitle(title);
	}

	private decisionToState(decision: Decision | { kind: "cancelled" }): ApprovalState {
		if (decision.kind === "approve") return { kind: "approved" };
		if (decision.kind === "deny") return { kind: "denied", reason: decision.reason };
		if (decision.kind === "cancelled") return { kind: "cancelled" };
		return { kind: "none" };
	}

	private rerenderForToolUse(toolUseId: string): void {
		const messageId = this.toolUseToMessage.get(toolUseId);
		if (!messageId || !this.session) return;
		const message = this.session.messages.find((m) => m.id === messageId);
		if (message) this.renderMessage(message);
	}

	private async handleSendOrStop(): Promise<void> {
		const session = this.ensureSession();
		if (session.busy) {
			session.stop();
			return;
		}

		const blocks: ContentBlock[] = [];
		let textBuf = "";
		const flushText = () => {
			if (textBuf.length === 0) return;
			blocks.push({ type: "text", text: textBuf });
			textBuf = "";
		};

		let savedCount = 0;
		let inlineImageCount = 0;

		const walk = async (node: Node): Promise<void> => {
			if (node.nodeType === Node.TEXT_NODE) {
				textBuf += node.textContent ?? "";
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const el = node as HTMLElement;
			if (el.classList.contains("claude-code-img-pill")) {
				const id = el.dataset.attId;
				const att = id ? this.attachmentsById.get(id) : null;
				if (!att) return;
				if (att.saveToVault) {
					const path = await this.saveAttachmentToVault(att);
					if (path) {
						const prefix = att.kind === "image" ? "!" : "";
						textBuf += `${prefix}[[${path}]]`;
						savedCount++;
					}
				} else {
					flushText();
					blocks.push({
						type: att.kind,
						source: {
							type: "base64",
							media_type: att.mediaType,
							data: att.base64,
						},
					});
					inlineImageCount++;
				}
				return;
			}
			if (el.classList.contains("claude-code-file-pill")) {
				const link = el.dataset.link;
				if (link) textBuf += `[[${link}]]`;
				return;
			}
			if (el.classList.contains("claude-code-cmd-pill")) {
				const cmd = el.dataset.cmd;
				if (cmd) textBuf += `/${cmd}`;
				return;
			}
			if (el.tagName === "BR") {
				textBuf += "\n";
				return;
			}
			const isBlock = el.tagName === "DIV" || el.tagName === "P";
			if (isBlock && textBuf.length > 0 && !textBuf.endsWith("\n")) {
				textBuf += "\n";
			}
			for (const child of Array.from(el.childNodes)) await walk(child);
		};

		for (const child of Array.from(this.composerEl.childNodes)) await walk(child);
		flushText();

		const hasContent = blocks.some(
			(b) => (b.type === "text" && b.text.trim().length > 0) || b.type === "image",
		);
		if (!hasContent) return;

		this.clearComposer();
		this.hideEmptyState();
		const model = this.currentModel || undefined;
		const effort = this.currentEffort || undefined;
		log(
			"[claude-code:resolve]",
			`model=${model ?? "(none)"} effort=${effort ?? "(none)"} inline=${inlineImageCount} saved=${savedCount}`,
		);
		try {
			session.sendBlocks(blocks, { model, effort });
		} catch (err) {
			new Notice(`Claude Code: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async handlePaste(e: ClipboardEvent): Promise<void> {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const item of Array.from(items)) {
			if (item.kind !== "file") continue;
			const f = item.getAsFile();
			if (f && isAcceptedAttachment(f)) files.push(f);
		}
		if (files.length === 0) return;
		e.preventDefault();
		for (const file of files) await this.addAttachmentFile(file);
	}

	private async handleDrop(e: DragEvent): Promise<void> {
		const files = Array.from(e.dataTransfer?.files ?? []).filter(isAcceptedAttachment);
		for (const file of files) await this.addAttachmentFile(file);
		this.composerEl.focus();
	}

	private async handleFileInput(): Promise<void> {
		const files = Array.from(this.fileInputEl.files ?? []).filter(isAcceptedAttachment);
		for (const file of files) await this.addAttachmentFile(file);
		this.fileInputEl.value = "";
		this.composerEl.focus();
	}

	private async addAttachmentFile(file: File): Promise<void> {
		const kind: "image" | "document" = file.type.startsWith("image/") ? "image" : "document";
		const base64 = await blobToBase64(file);
		const previewUrl = kind === "image" ? URL.createObjectURL(file) : "";
		const ext = mediaTypeToExt(file.type);
		const prefix = kind === "image" ? "image" : "doc";
		const fallbackName = `${prefix}-${formatTimestampId(Date.now())}-${randomSuffix(4)}.${ext}`;
		const filename = file.name && file.name.length > 0 ? file.name : fallbackName;
		const id = `att-${Date.now()}-${randomSuffix(6)}`;
		this.attachmentsById.set(id, {
			kind,
			mediaType: file.type,
			base64,
			previewUrl,
			filename,
			saveToVault: false,
		});
		this.insertPillAtCursor(id);
	}

	private insertPillAtCursor(id: string): void {
		const att = this.attachmentsById.get(id);
		if (!att) return;
		const pill = this.createPillElement(id, att);
		const sel = window.getSelection();
		const space = document.createTextNode(" ");
		if (sel && sel.rangeCount > 0 && this.composerEl.contains(sel.anchorNode)) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			range.insertNode(space);
			range.insertNode(pill);
			range.setStartAfter(space);
			range.setEndAfter(space);
			sel.removeAllRanges();
			sel.addRange(range);
		} else {
			this.composerEl.appendChild(pill);
			this.composerEl.appendChild(space);
		}
	}

	private createPillElement(
		id: string,
		att: {
			kind: "image" | "document";
			mediaType: string;
			previewUrl: string;
			filename: string;
			saveToVault: boolean;
		},
	): HTMLSpanElement {
		const pill = createSpan({
			cls: `claude-code-img-pill${att.saveToVault ? " is-save" : ""}`,
			attr: {
				contenteditable: "false",
				"data-att-id": id,
				"data-pill-kind": att.kind,
			},
		});
		const thumb = pill.createSpan({ cls: "claude-code-img-pill-thumb" });
		if (att.kind === "image" && att.previewUrl) {
			thumb.createEl("img", { attr: { src: att.previewUrl, alt: att.filename } });
		} else {
			setIcon(thumb, att.mediaType === "application/pdf" ? "file-text" : "file");
		}
		pill.createSpan({ cls: "claude-code-img-pill-name", text: att.filename });
		const saveBtn = pill.createSpan({
			cls: "claude-code-img-pill-save",
			attr: { role: "button", "aria-label": "Save to vault on send" },
		});
		setIcon(saveBtn, "download");
		saveBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const current = this.attachmentsById.get(id);
			if (!current) return;
			current.saveToVault = !current.saveToVault;
			pill.toggleClass("is-save", current.saveToVault);
		});
		return pill;
	}

	private syncAttachmentsFromDom(): void {
		const present = new Set<string>();
		this.composerEl.querySelectorAll<HTMLElement>(".claude-code-img-pill").forEach((p) => {
			const id = p.dataset.attId;
			if (id) present.add(id);
		});
		for (const [id, att] of this.attachmentsById) {
			if (!present.has(id)) {
				URL.revokeObjectURL(att.previewUrl);
				this.attachmentsById.delete(id);
			}
		}
	}

	private async saveAttachmentToVault(att: {
		mediaType: string;
		base64: string;
		filename?: string;
	}): Promise<string | null> {
		const ext = mediaTypeToExt(att.mediaType);
		const filename =
			att.filename && att.filename.length > 0
				? att.filename
				: `image-${formatTimestampId(Date.now())}.${ext}`;
		try {
			const path = await this.app.fileManager.getAvailablePathForAttachment(filename);
			const bytes = base64ToBytes(att.base64);
			await this.app.vault.createBinary(path, bytes.buffer);
			new Notice(`Saved to ${path}`);
			return path;
		} catch (err) {
			console.error("[claude-code] save attachment failed", err);
			new Notice(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	private clearComposer(): void {
		this.composerEl.empty();
		for (const att of this.attachmentsById.values()) URL.revokeObjectURL(att.previewUrl);
		this.attachmentsById.clear();
	}

	private setStatus(text: string, busy: boolean): void {
		this.statusEl.empty();
		if (text && !busy) this.statusEl.setText(text);

		this.sendBtn.empty();
		this.sendBtn.toggleClass("is-busy", busy);
		this.sendBtn.toggleClass("mod-warning", busy);
		this.sendBtn.toggleClass("mod-cta", !busy);
		setIcon(this.sendBtn, busy ? "square" : "arrow-up");
		this.sendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");

		this.setTypingVisible(busy);
		this.setTitleShimmer(busy);
	}

	private setTitleShimmer(busy: boolean): void {
		const tabHeaderEl = (this.leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
		const tabTitleEl = tabHeaderEl?.querySelector<HTMLElement>(
			".workspace-tab-header-inner-title",
		);
		const leafContainer = (this.leaf as unknown as { containerEl?: HTMLElement }).containerEl;
		const viewTitle = leafContainer?.querySelector<HTMLElement>(".view-header-title");
		tabTitleEl?.toggleClass("claude-code-busy-title", busy);
		viewTitle?.toggleClass("claude-code-busy-title", busy);
	}

	private async batchRenderHistory(totalCount: number): Promise<void> {
		if (!this.session) return;
		const initialWindow = 30;
		const start = Math.max(0, totalCount - initialWindow);
		this.renderedHistoryFrom = start;

		this.refreshEarlierButton();
		this.suppressAutoScroll = true;
		try {
			await this.renderRange(start, totalCount);
		} finally {
			this.suppressAutoScroll = false;
		}
		this.scrollToBottom();
	}

	private async renderRange(startIdx: number, endIdx: number): Promise<void> {
		if (!this.session) return;
		const batchSize = 4;
		for (let i = startIdx; i < endIdx; i++) {
			const m = this.session.messages[i];
			if (m) this.renderMessage(m);
			if ((i - startIdx + 1) % batchSize === 0) {
				await new Promise<void>((resolve) =>
					window.requestAnimationFrame(() => resolve()),
				);
			}
		}
	}

	private refreshEarlierButton(): void {
		this.earlierBtnEl?.remove();
		this.earlierBtnEl = null;
		if (this.renderedHistoryFrom <= 0) return;

		const btn = createDiv({ cls: "claude-code-show-earlier" });
		const remaining = this.renderedHistoryFrom;
		btn.setText(`Show ${remaining} earlier message${remaining === 1 ? "" : "s"}`);
		btn.addEventListener("click", () => void this.expandHistory());
		this.earlierBtnEl = btn;
		this.scrollEl.prepend(btn);
	}

	private async expandHistory(): Promise<void> {
		if (!this.session || this.renderedHistoryFrom <= 0) return;
		const chunk = 30;
		const newStart = Math.max(0, this.renderedHistoryFrom - chunk);
		const oldStart = this.renderedHistoryFrom;
		const previousScrollHeight = this.scrollEl.scrollHeight;
		const previousScrollTop = this.scrollEl.scrollTop;

		this.suppressAutoScroll = true;
		const inserted: HTMLElement[] = [];
		try {
			for (let i = newStart; i < oldStart; i++) {
				const m = this.session.messages[i];
				if (!m) continue;
				this.renderMessage(m);
				const el = this.messageEls.get(m.id);
				if (el) inserted.push(el);
				if ((i - newStart + 1) % 4 === 0) {
					await new Promise<void>((resolve) =>
						window.requestAnimationFrame(() => resolve()),
					);
				}
			}
		} finally {
			this.suppressAutoScroll = false;
		}
		for (let i = inserted.length - 1; i >= 0; i--) {
			this.scrollEl.prepend(inserted[i]!);
		}

		this.renderedHistoryFrom = newStart;
		this.refreshEarlierButton();

		const delta = this.scrollEl.scrollHeight - previousScrollHeight;
		this.scrollEl.scrollTop = previousScrollTop + delta;
	}

	private setTypingVisible(visible: boolean): void {
		if (visible) {
			if (!this.typingEl) {
				this.typingEl = this.scrollEl.createDiv({ cls: "claude-code-typing-row" });
				this.typingEl.createSpan({ cls: "claude-code-typing", text: "thinking" });
			}
			this.scrollEl.appendChild(this.typingEl);
			if (this.wasAtBottom) this.scrollToBottom();
		} else if (this.typingEl) {
			this.typingEl.remove();
			this.typingEl = null;
		}
	}

	private renderMessage(m: DisplayMessage): void {
		const kind = messageKind(m);

		if (kind === "tool-result") {
			for (const block of m.blocks) {
				if (block.type === "tool_result") {
					this.toolResultsByUseId.set(block.tool_use_id, block);
					const content = this.toolCalloutContents.get(block.tool_use_id);
					if (content) renderInlineToolResult(content, block);
				}
			}
			this.messageEls.get(m.id)?.remove();
			this.messageEls.delete(m.id);
			return;
		}

		const visibleBlocks = m.blocks.filter((b) => {
			if (b.type === "thinking") return b.thinking.trim().length > 0;
			if (b.type === "text") return b.text.trim().length > 0;
			return true;
		});
		if (visibleBlocks.length === 0) {
			this.messageEls.get(m.id)?.remove();
			this.messageEls.delete(m.id);
			return;
		}

		const wasAtBottom = this.wasAtBottom;
		let el = this.messageEls.get(m.id);
		const isNew = !el;
		if (!el) {
			el = this.scrollEl.createDiv({
				cls: `claude-code-msg claude-code-msg-${m.role} claude-code-msg-${kind}`,
			});
			this.messageEls.set(m.id, el);
		} else {
			el.className = `claude-code-msg claude-code-msg-${m.role} claude-code-msg-${kind}`;
		}
		el.empty();

		if (kind === "user-prompt") {
			this.renderUserPromptBubble(el, visibleBlocks);
		} else {
			for (const block of visibleBlocks) {
				if (block.type === "tool_use") this.toolUseToMessage.set(block.id, m.id);
				this.renderBlock(el, block);
			}
		}

		this.renderMetaRow(el, m, kind);

		if (this.typingEl) this.scrollEl.appendChild(this.typingEl);

		if (this.suppressAutoScroll) return;

		if (wasAtBottom) {
			this.scrollToBottom();
		} else if (isNew && m.role === "assistant") {
			this.showNewMessagesPill();
		}
	}

	private renderMetaRow(host: HTMLElement, m: DisplayMessage, kind: string): void {
		const isUserPrompt = kind === "user-prompt";
		const isFinalAssistantText =
			kind === "assistant" &&
			hasUserVisibleText(m) &&
			!m.blocks.some((b) => b.type === "tool_use");

		if (!isUserPrompt && !isFinalAssistantText) return;

		const meta = host.createDiv({ cls: "claude-code-msg-meta" });
		meta.createSpan({
			cls: "claude-code-msg-time",
			text: formatTimestamp(m.timestamp),
		});

		if (isFinalAssistantText) {
			const btn = meta.createEl("button", {
				cls: "claude-code-copy-btn",
				attr: { "aria-label": "Copy message" },
			});
			setIcon(btn, "copy");
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const text = m.blocks
					.filter((b) => b.type === "text")
					.map((b) => (b.type === "text" ? b.text : ""))
					.join("\n\n");
				try {
					await navigator.clipboard.writeText(text);
					btn.empty();
					setIcon(btn, "check");
					btn.addClass("is-copied");
					window.setTimeout(() => {
						btn.empty();
						setIcon(btn, "copy");
						btn.removeClass("is-copied");
					}, 1200);
				} catch (err) {
					console.error("[claude-code] clipboard write failed", err);
				}
			});
		}
	}

	private renderUserPromptBubble(host: HTMLElement, blocks: ContentBlock[]): void {
		const bubble = host.createDiv({ cls: "claude-code-text" });
		let combined = "";
		for (const block of blocks) {
			if (block.type === "text") {
				combined += block.text;
			} else if (block.type === "image") {
				const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
				combined += `\n\n![](${dataUrl})\n\n`;
			} else if (block.type === "document") {
				combined += `\n\n📎 *attached document (${block.source.media_type})*\n\n`;
			}
		}
		void MarkdownRenderer.render(this.app, combined, bubble, "", this);
	}

	private renderBlock(host: HTMLElement, block: ContentBlock): void {
		if (block.type === "text") {
			const md = host.createDiv({ cls: "claude-code-text" });
			void MarkdownRenderer.render(this.app, block.text, md, "", this);
			return;
		}
		if (block.type === "image") {
			const wrap = host.createDiv({ cls: "claude-code-msg-image" });
			wrap.createEl("img", {
				attr: {
					src: `data:${block.source.media_type};base64,${block.source.data}`,
					alt: "image",
				},
			});
			return;
		}
		if (block.type === "thinking") {
			const det = host.createEl("details", { cls: "claude-code-thinking" });
			det.createEl("summary", { text: "thinking" });
			det.createEl("pre", { text: block.thinking });
			return;
		}
		const ctx: ToolBlockContext = {
			app: this.app,
			component: this,
			settings: this.plugin.settings,
			approvalState: (id) => this.approvalStates.get(id) ?? { kind: "none" },
			onApprove: (id) => this.session?.decide(id, { kind: "approve" }),
			onDeny: (id, reason) =>
				this.session?.decide(id, { kind: "deny", reason: reason ?? "User denied" }),
			onToolCalloutMounted: (toolUseId, contentEl) => {
				this.toolCalloutContents.set(toolUseId, contentEl);
				const cached = this.toolResultsByUseId.get(toolUseId);
				if (cached) renderInlineToolResult(contentEl, cached);
			},
		};
		if (block.type === "tool_use") {
			renderToolUse(host, block, ctx);
		}
	}

	private isScrolledToBottom(): boolean {
		const el = this.scrollEl;
		return el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_AT_BOTTOM_THRESHOLD;
	}

	private scrollToBottom(): void {
		this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
		this.wasAtBottom = true;
		this.updateScrollDownButton();
	}

	private updateScrollDownButton(): void {
		if (!this.scrollDownBtn) return;
		this.scrollDownBtn.toggleClass("is-visible", !this.isScrolledToBottom());
	}

	private showNewMessagesPill(): void {
		if (this.newMessagesPill) return;
		const pill = this.scrollEl.parentElement?.createDiv({
			cls: "claude-code-new-messages-pill",
			text: "↓ New messages",
		});
		if (!pill) return;
		pill.addEventListener("click", () => {
			this.scrollToBottom();
			pill.remove();
			this.newMessagesPill = null;
		});
		this.newMessagesPill = pill;
	}
}

function mediaTypeToExt(type: string): string {
	switch (type) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		case "image/svg+xml":
			return "svg";
		case "application/pdf":
			return "pdf";
		default:
			return "bin";
	}
}

function isAcceptedAttachment(file: File): boolean {
	return file.type.startsWith("image/") || file.type === "application/pdf";
}

function sanitizeFilename(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function renderChatToMarkdown(
	messages: DisplayMessage[],
	meta: { title: string; sessionId: string; exportedAt: string },
): string {
	const lines: string[] = [];
	lines.push("---");
	lines.push("plugin: claude-code");
	lines.push(`session_id: ${meta.sessionId}`);
	lines.push(`exported: ${meta.exportedAt}`);
	lines.push(`title: ${JSON.stringify(meta.title)}`);
	lines.push("---");
	lines.push("");
	lines.push(`# ${meta.title}`);
	lines.push("");

	let lastHeaderRole: string | null = null;
	for (const m of messages) {
		const time = new Date(m.timestamp).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		const kind = (m.role === "user" &&
			m.blocks.length > 0 &&
			m.blocks.every((b) => b.type === "tool_result"))
			? "tool-result"
			: m.role;

		if (kind === "tool-result") continue; // tool results are merged into the prior tool call below

		if (m.role !== lastHeaderRole) {
			lines.push(`## ${m.role === "user" ? "You" : "Claude"} · ${time}`);
			lines.push("");
			lastHeaderRole = m.role;
		}

		for (const block of m.blocks) {
			if (block.type === "text") {
				lines.push(block.text);
				lines.push("");
			} else if (block.type === "thinking") {
				if (block.thinking.trim().length > 0) {
					lines.push("> [!quote]- thinking");
					for (const ln of block.thinking.split("\n")) lines.push(`> ${ln}`);
					lines.push("");
				}
			} else if (block.type === "image") {
				const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
				lines.push(`![](${dataUrl})`);
				lines.push("");
			} else if (block.type === "document") {
				lines.push(`📎 *attached document (${block.source.media_type})*`);
				lines.push("");
			} else if (block.type === "tool_use") {
				const meta = exportToolMeta(block);
				const inputJson = JSON.stringify(block.input, null, 2);
				lines.push(`> [!${meta.callout}]- ${meta.title}`);
				lines.push("> ```json");
				for (const ln of inputJson.split("\n")) lines.push(`> ${ln}`);
				lines.push("> ```");
				const result = findToolResultFor(messages, block.id);
				if (result) {
					const text =
						typeof result.content === "string"
							? result.content
							: result.content
									.map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
									.join("\n");
					lines.push(">");
					lines.push("> ---");
					lines.push(">");
					if (result.is_error) lines.push("> **Error**");
					lines.push("> ```");
					for (const ln of text.split("\n")) lines.push(`> ${ln}`);
					lines.push("> ```");
				}
				lines.push("");
			}
		}
	}
	return lines.join("\n");
}

function exportToolMeta(block: { name: string; input: Record<string, unknown> }): {
	callout: string;
	title: string;
} {
	const fileBase = (p: unknown): string => {
		const s = String(p ?? "");
		const i = s.lastIndexOf("/");
		return i >= 0 ? s.slice(i + 1) : s;
	};
	switch (block.name) {
		case "Edit":
			return { callout: "tool-edit", title: `Edit · ${fileBase(block.input.file_path)}` };
		case "Write":
			return { callout: "tool-edit", title: `Write · ${fileBase(block.input.file_path)}` };
		case "Read":
			return { callout: "tool-read", title: `Read · ${fileBase(block.input.file_path)}` };
		case "Bash":
			return { callout: "tool-bash", title: "Bash" };
		case "BashOutput":
			return { callout: "tool-bash", title: "Bash output" };
		case "KillShell":
			return { callout: "tool-bash", title: "Kill shell" };
		case "Grep":
			return { callout: "tool-search", title: "Grep" };
		case "Glob":
			return { callout: "tool-search", title: "Glob" };
		case "WebSearch":
			return { callout: "tool-search", title: "Web search" };
		case "WebFetch":
			return { callout: "tool-search", title: "Web fetch" };
		case "TodoWrite":
			return { callout: "tool-todo", title: "Todos" };
		case "Task":
			return { callout: "tool-task", title: "Subagent task" };
	}
	if (block.name.startsWith("mcp__")) {
		const rest = block.name.slice(5).replace(/^claude_ai_/, "").replace(/_/g, " ");
		return { callout: "tool-mcp", title: rest };
	}
	return { callout: "tool-generic", title: block.name };
}

function findToolResultFor(messages: DisplayMessage[], toolUseId: string) {
	for (const m of messages) {
		if (m.role !== "user") continue;
		for (const b of m.blocks) {
			if (b.type === "tool_result" && b.tool_use_id === toolUseId) return b;
		}
	}
	return null;
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function formatTimestampId(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
		`-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
	);
}

function randomSuffix(len: number): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
	return s;
}

function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => {
			const result = reader.result as string;
			const idx = result.indexOf(",");
			resolve(idx >= 0 ? result.slice(idx + 1) : result);
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

function relativeTime(mtimeMs: number): string {
	const diff = Date.now() - mtimeMs;
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (diff < minute) return "just now";
	if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
	if (diff < day) return `${Math.floor(diff / hour)}h ago`;
	if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
	return new Date(mtimeMs).toLocaleDateString();
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	if (sameDay) {
		return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}
	return d.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function hasUserVisibleText(m: { blocks: { type: string }[] }): boolean {
	return m.blocks.some((b) => b.type === "text");
}

function truncate(s: string, n: number): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

function messageKind(m: DisplayMessage): "user-prompt" | "tool-result" | "assistant" {
	if (m.role === "assistant") return "assistant";
	const onlyToolResults = m.blocks.length > 0 && m.blocks.every((b) => b.type === "tool_result");
	return onlyToolResults ? "tool-result" : "user-prompt";
}
