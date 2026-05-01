import { App, prepareFuzzySearch, setIcon } from "obsidian";

interface ScoredMatch {
	score: number;
}

interface SuggestState {
	textNode: Text;
	triggerOffset: number; // position of "@" in textNode
	query: string;
}

interface Match {
	path: string;
	score: number;
}

export class FileMentionSuggest {
	private app: App;
	private input: HTMLElement;
	private container: HTMLElement;
	private popup: HTMLElement | null = null;
	private state: SuggestState | null = null;
	private results: Match[] = [];
	private activeIdx = 0;

	constructor(app: App, input: HTMLElement, container: HTMLElement) {
		this.app = app;
		this.input = input;
		this.container = container;

		this.input.addEventListener("input", this.onInput);
		this.input.addEventListener("keydown", this.onKeyDown);
		this.input.addEventListener("blur", this.onBlur);
	}

	isOpen(): boolean {
		return this.popup !== null;
	}

	dispose(): void {
		this.input.removeEventListener("input", this.onInput);
		this.input.removeEventListener("keydown", this.onKeyDown);
		this.input.removeEventListener("blur", this.onBlur);
		this.close();
	}

	private onBlur = (): void => {
		setTimeout(() => this.close(), 100);
	};

	private onInput = (): void => {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) {
			this.close();
			return;
		}
		const node = sel.anchorNode;
		if (!node || !this.input.contains(node) || node.nodeType !== Node.TEXT_NODE) {
			this.close();
			return;
		}
		const textNode = node as Text;
		const offset = sel.anchorOffset;
		const before = (textNode.textContent ?? "").slice(0, offset);
		const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
		if (!match) {
			this.close();
			return;
		}
		const query = match[1] ?? "";
		const triggerOffset = offset - query.length - 1;
		this.state = { textNode, triggerOffset, query };
		this.refreshResults();
		this.openOrUpdatePopup();
	};

	private onKeyDown = (e: KeyboardEvent): void => {
		if (!this.popup || !this.state) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			this.activeIdx = Math.min(this.results.length - 1, this.activeIdx + 1);
			this.renderResults();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			this.activeIdx = Math.max(0, this.activeIdx - 1);
			this.renderResults();
		} else if (e.key === "Enter" || e.key === "Tab") {
			if (this.results.length > 0) {
				e.preventDefault();
				e.stopPropagation();
				this.applyActive();
			}
		} else if (e.key === "Escape") {
			e.preventDefault();
			this.close();
		}
	};

	private refreshResults(): void {
		if (!this.state) return;
		const search = prepareFuzzySearch(this.state.query);
		const files = this.app.vault.getMarkdownFiles();
		const limit = 8;
		const matches: Match[] = [];

		if (this.state.query.length === 0) {
			for (const f of files.slice(0, limit)) {
				matches.push({ path: f.path, score: 0 });
			}
		} else {
			const scored: Array<{ path: string; score: number }> = [];
			for (const f of files) {
				const m = search(f.path) as ScoredMatch | null;
				if (m) scored.push({ path: f.path, score: m.score });
			}
			scored.sort((a, b) => b.score - a.score);
			for (const s of scored.slice(0, limit)) {
				matches.push({ path: s.path, score: s.score });
			}
		}

		this.results = matches;
		this.activeIdx = 0;
	}

	private openOrUpdatePopup(): void {
		if (this.results.length === 0) {
			this.close();
			return;
		}
		if (!this.popup) {
			this.popup = this.container.createDiv({ cls: "claude-code-mention-popup" });
		}
		this.renderResults();
	}

	private renderResults(): void {
		if (!this.popup) return;
		this.popup.empty();
		let activeRow: HTMLElement | null = null;
		this.results.forEach((r, i) => {
			const row = this.popup!.createDiv({
				cls: `claude-code-mention-row${i === this.activeIdx ? " is-active" : ""}`,
			});
			row.createDiv({ cls: "claude-code-mention-name", text: basename(r.path) });
			row.createDiv({ cls: "claude-code-mention-path", text: dirOnly(r.path) });
			row.addEventListener("mousemove", () => {
				if (this.activeIdx !== i) {
					this.activeIdx = i;
					this.renderResults();
				}
			});
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.activeIdx = i;
				this.applyActive();
			});
			if (i === this.activeIdx) activeRow = row;
		});
		if (activeRow) (activeRow as HTMLElement).scrollIntoView({ block: "nearest" });
	}

	private applyActive(): void {
		if (!this.state) return;
		const r = this.results[this.activeIdx];
		if (!r) return;

		const sel = window.getSelection();
		const cursorOffset = sel?.anchorOffset ?? 0;
		const textNode = this.state.textNode;
		const text = textNode.textContent ?? "";
		const before = text.slice(0, this.state.triggerOffset);
		const after = text.slice(cursorOffset);

		textNode.textContent = before;

		const link = r.path.replace(/\.md$/, "");
		const pill = createSpan({
			cls: "claude-code-pill-chip claude-code-file-pill",
			attr: {
				contenteditable: "false",
				"data-pill-type": "file",
				"data-link": link,
			},
		});
		setIcon(pill.createSpan({ cls: "claude-code-pill-icon" }), "file-text");
		pill.createSpan({ cls: "claude-code-pill-text", text: basename(r.path) });

		const parent = textNode.parentNode;
		if (parent) {
			const afterNode = document.createTextNode(" " + after);
			parent.insertBefore(pill, textNode.nextSibling);
			parent.insertBefore(afterNode, pill.nextSibling);
			const range = document.createRange();
			range.setStart(afterNode, 1);
			range.setEnd(afterNode, 1);
			const s = window.getSelection();
			s?.removeAllRanges();
			s?.addRange(range);
		}

		this.input.focus();
		this.close();
	}

	private close(): void {
		this.popup?.remove();
		this.popup = null;
		this.state = null;
		this.results = [];
		this.activeIdx = 0;
	}
}

function basename(p: string): string {
	const idx = p.lastIndexOf("/");
	const name = idx >= 0 ? p.slice(idx + 1) : p;
	return name.replace(/\.md$/, "");
}

function dirOnly(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx >= 0 ? p.slice(0, idx) : "";
}
