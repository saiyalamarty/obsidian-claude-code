import "@pierre/diffs/dist/components/web-components.js";
import {
	DIFFS_TAG_NAME,
	FileDiff,
	type FileContents,
	preloadHighlighter,
} from "@pierre/diffs";

export type DiffStyle = "unified" | "split";
export type Overflow = "scroll" | "wrap";

export interface FileRenderSpec {
	name: string;
	oldFile?: FileContents;
	newFile?: FileContents;
	/** If set, this file was skipped for auto-render (too large). */
	largeFile?: { oldSize: number; newSize: number };
}

export interface RenderDiffOptions {
	diffStyle: DiffStyle;
	overflow: Overflow;
	loadLargeFile(spec: FileRenderSpec): Promise<{ oldFile?: FileContents; newFile?: FileContents }>;
	onFileClick?(path: string): void;
}

let highlighterReady: Promise<void> | null = null;

function ensureHighlighter(): Promise<void> {
	if (!highlighterReady) {
		highlighterReady = preloadHighlighter({
			themes: ["pierre-dark", "pierre-light"],
			langs: ["markdown", "typescript", "javascript", "json", "yaml", "python", "bash"],
			preferredHighlighter: "shiki-js",
		}).catch((err) => {
			console.error("[git-diffs] highlighter failed", err);
			highlighterReady = null;
			throw err;
		});
	}
	return highlighterReady;
}

export interface DiffRenderHandle {
	cleanup(): void;
	setThemeType(themeType: "dark" | "light"): void;
	setDiffStyle(style: DiffStyle): void;
	setOverflow(overflow: Overflow): void;
	setAllCollapsed(collapsed: boolean): void;
	anyExpanded(): boolean;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export async function renderDiff(
	contentWrapper: HTMLElement,
	files: FileRenderSpec[],
	options: RenderDiffOptions,
): Promise<DiffRenderHandle> {
	await ensureHighlighter();

	if (files.length === 0) {
		contentWrapper.createEl("p", { text: "No files changed.", cls: "git-diffs-empty" });
		return {
			cleanup: () => {},
			setThemeType: () => {},
			setDiffStyle: () => {},
			setOverflow: () => {},
			setAllCollapsed: () => {},
			anyExpanded: () => false,
		};
	}

	const themeType = document.body.classList.contains("theme-dark") ? "dark" : "light";
	const fileDiffs: FileDiff[] = [];
	let currentDiffStyle = options.diffStyle;
	let currentOverflow = options.overflow;

	const headerUnsafeCSS = `
		[data-diffs-header] { cursor: pointer; }
		[data-title] { cursor: pointer; }
		[data-title]:hover { text-decoration: underline; }
	`;

	const wireHeaderInteractions = (
		node: HTMLElement,
		path: string,
		onToggleCollapse: () => void,
	): void => {
		const header = node.shadowRoot?.querySelector<HTMLElement>("[data-diffs-header]");
		if (!header) return;

		if (header.dataset.gitDiffsWired !== "1") {
			header.dataset.gitDiffsWired = "1";
			header.addEventListener("click", () => onToggleCollapse());
		}

		const title = header.querySelector<HTMLElement>("[data-title]");
		if (title && title.dataset.gitDiffsTitleWired !== "1") {
			title.dataset.gitDiffsTitleWired = "1";
			title.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				options.onFileClick?.(path);
			});
		}
	};

	const collapsedState = new Map<FileDiff, { value: boolean }>();

	const mountFileDiff = (
		host: HTMLElement,
		oldFile: FileContents | undefined,
		newFile: FileContents | undefined,
		path: string,
	): FileDiff | null => {
		const cs = { value: false };
		try {
			// Forward-declared so the closure below can reference it.
			let fileDiff: FileDiff;
			const toggleCollapse = () => {
				cs.value = !cs.value;
				fileDiff.setOptions({ ...fileDiff.options, collapsed: cs.value });
				fileDiff.rerender();
			};
			fileDiff = new FileDiff({
				diffStyle: currentDiffStyle,
				overflow: currentOverflow,
				themeType,
				theme: { dark: "pierre-dark", light: "pierre-light" },
				preferredHighlighter: "shiki-js",
				hunkSeparators: "line-info",
				expansionLineCount: 20,
				disableErrorHandling: true,
				collapsed: cs.value,
				unsafeCSS: headerUnsafeCSS,
				onPostRender: (node) => wireHeaderInteractions(node, path, toggleCollapse),
			});
			fileDiff.render({ oldFile, newFile, fileContainer: host });
			fileDiffs.push(fileDiff);
			collapsedState.set(fileDiff, cs);
			return fileDiff;
		} catch (err) {
			console.error("[git-diffs] FileDiff.render failed", err);
			const pre = document.createElement("pre");
			pre.textContent = `render error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
			pre.classList.add("git-diffs-render-error");
			host.appendChild(pre);
			return null;
		}
	};

	for (const spec of files) {
		if (spec.largeFile) {
			const placeholder = contentWrapper.createEl("div", { cls: "git-diffs-placeholder" });
			placeholder.createEl("div", { text: spec.name, cls: "git-diffs-placeholder-name" });
			const max = Math.max(spec.largeFile.oldSize, spec.largeFile.newSize);
			placeholder.createEl("div", {
				text: `Large file (${formatBytes(max)}). Not rendered automatically.`,
				cls: "git-diffs-placeholder-msg",
			});
			const btn = placeholder.createEl("button", {
				text: "Load diff",
				cls: "git-diffs-placeholder-btn",
			});
			btn.addEventListener("click", () => {
				void (async () => {
					btn.disabled = true;
					btn.textContent = "Loading…";
					try {
						const { oldFile, newFile } = await options.loadLargeFile(spec);
						const host = document.createElement(DIFFS_TAG_NAME);
						placeholder.replaceWith(host);
						mountFileDiff(host, oldFile, newFile, spec.name);
					} catch (err) {
						btn.disabled = false;
						btn.textContent = "Load diff";
						placeholder.createEl("pre", {
							text: `Load failed: ${err instanceof Error ? err.message : String(err)}`,
							cls: "git-diffs-placeholder-err",
						});
					}
				})();
			});
			continue;
		}

		const host = document.createElement(DIFFS_TAG_NAME);
		contentWrapper.appendChild(host);
		mountFileDiff(host, spec.oldFile, spec.newFile, spec.name);
	}

	return {
		cleanup() {
			for (const fd of fileDiffs) fd.cleanUp();
		},
		setThemeType(next) {
			for (const fd of fileDiffs) fd.setThemeType(next);
		},
		setDiffStyle(style) {
			if (style === currentDiffStyle) return;
			currentDiffStyle = style;
			for (const fd of fileDiffs) {
				fd.setOptions({ ...fd.options, diffStyle: style });
				fd.rerender();
			}
		},
		setOverflow(overflow) {
			if (overflow === currentOverflow) return;
			currentOverflow = overflow;
			for (const fd of fileDiffs) {
				fd.setOptions({ ...fd.options, overflow });
				fd.rerender();
			}
		},
		setAllCollapsed(collapsed) {
			for (const fd of fileDiffs) {
				const cs = collapsedState.get(fd);
				if (!cs || cs.value === collapsed) continue;
				cs.value = collapsed;
				fd.setOptions({ ...fd.options, collapsed });
				fd.rerender();
			}
		},
		anyExpanded() {
			for (const cs of collapsedState.values()) {
				if (!cs.value) return true;
			}
			return false;
		},
	};
}
