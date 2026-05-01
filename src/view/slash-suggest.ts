import { App, prepareFuzzySearch, setIcon } from "obsidian";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface SlashItem {
	name: string;
	scope: "project" | "user";
	kind: "command" | "skill";
}

interface ScoredMatch {
	score: number;
}

export class SlashCommandSuggest {
	private app: App;
	private input: HTMLElement;
	private container: HTMLElement;
	private cwd: string;
	private popup: HTMLElement | null = null;
	private items: SlashItem[] = [];
	private results: SlashItem[] = [];
	private activeIdx = 0;
	private active = false;
	private loaded = false;

	constructor(app: App, input: HTMLElement, container: HTMLElement, cwd: string) {
		this.app = app;
		this.input = input;
		this.container = container;
		this.cwd = cwd;

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

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.items = await collectSlashItems(this.cwd);
		this.loaded = true;
	}

	private onBlur = (): void => {
		setTimeout(() => this.close(), 100);
	};

	private onInput = (): void => {
		const value = this.input.textContent ?? "";
		if (!value.startsWith("/")) {
			this.close();
			return;
		}
		const firstSpace = value.indexOf(" ");
		const cmdEnd = firstSpace === -1 ? value.length : firstSpace;
		this.active = true;
		const query = value.slice(1, cmdEnd);
		void this.refresh(query);
	};

	private async refresh(query: string): Promise<void> {
		await this.ensureLoaded();
		if (!this.active) return;
		this.results = filterItems(this.items, query).slice(0, 8);
		this.activeIdx = 0;
		this.openOrUpdatePopup();
	}

	private onKeyDown = (e: KeyboardEvent): void => {
		if (!this.popup) return;
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
		this.results.forEach((item, i) => {
			const row = this.popup!.createDiv({
				cls: `claude-code-mention-row${i === this.activeIdx ? " is-active" : ""}`,
			});
			row.createDiv({ cls: "claude-code-mention-name", text: `/${item.name}` });
			row.createDiv({
				cls: "claude-code-mention-path",
				text: `${item.kind} · ${item.scope}`,
			});
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
		const item = this.results[this.activeIdx];
		if (!item) return;
		const value = this.input.textContent ?? "";
		const firstSpace = value.indexOf(" ");
		const rest = firstSpace === -1 ? "" : value.slice(firstSpace + 1);

		this.input.empty();

		const pill = createSpan({
			cls: "claude-code-pill-chip claude-code-cmd-pill",
			attr: {
				contenteditable: "false",
				"data-pill-type": "command",
				"data-cmd": item.name,
			},
		});
		setIcon(
			pill.createSpan({ cls: "claude-code-pill-icon" }),
			item.kind === "skill" ? "sparkles" : "terminal",
		);
		pill.createSpan({ cls: "claude-code-pill-text", text: `/${item.name}` });

		this.input.appendChild(pill);
		const afterNode = document.createTextNode(" " + rest);
		this.input.appendChild(afterNode);

		const range = document.createRange();
		range.setStart(afterNode, 1);
		range.setEnd(afterNode, 1);
		const s = window.getSelection();
		s?.removeAllRanges();
		s?.addRange(range);

		this.input.focus();
		this.close();
	}

	private close(): void {
		this.popup?.remove();
		this.popup = null;
		this.active = false;
		this.results = [];
		this.activeIdx = 0;
	}
}

async function collectSlashItems(cwd: string): Promise<SlashItem[]> {
	const out: SlashItem[] = [];
	const seen = new Set<string>();

	const sources = [
		{ scope: "project" as const, base: join(cwd, ".claude") },
		{ scope: "user" as const, base: join(homedir(), ".claude") },
	];

	for (const src of sources) {
		for (const entry of await safeReaddir(join(src.base, "commands"))) {
			if (!entry.endsWith(".md")) continue;
			const name = entry.replace(/\.md$/, "");
			const key = `cmd:${name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ name, scope: src.scope, kind: "command" });
		}
		for (const entry of await safeReaddir(join(src.base, "skills"))) {
			const path = join(src.base, "skills", entry);
			try {
				const s = await stat(path);
				if (!s.isDirectory()) continue;
			} catch {
				continue;
			}
			const key = `skill:${entry}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ name: entry, scope: src.scope, kind: "skill" });
		}
	}

	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

async function safeReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

function filterItems(items: SlashItem[], query: string): SlashItem[] {
	if (!query) return items;
	const search = prepareFuzzySearch(query);
	const scored: Array<{ item: SlashItem; score: number }> = [];
	for (const item of items) {
		const m = search(item.name) as ScoredMatch | null;
		if (m) scored.push({ item, score: m.score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.map((s) => s.item);
}
