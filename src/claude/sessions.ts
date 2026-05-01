import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "./types";

export interface RecentSession {
	id: string;
	mtimeMs: number;
	preview: string;
}

export interface ReplayMessage {
	role: "user" | "assistant";
	blocks: ContentBlock[];
	timestamp?: number;
}

export async function listRecentSessions(
	cwd: string,
	limit: number,
): Promise<RecentSession[]> {
	const dir = join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}

	const jsonlFiles = entries.filter((n) => n.endsWith(".jsonl"));
	const stats = await Promise.all(
		jsonlFiles.map(async (name) => {
			const path = join(dir, name);
			try {
				const s = await stat(path);
				return { name, path, mtimeMs: s.mtimeMs };
			} catch {
				return null;
			}
		}),
	);

	const ordered = stats
		.filter((s): s is { name: string; path: string; mtimeMs: number } => s !== null)
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, limit);

	return Promise.all(
		ordered.map(async (s): Promise<RecentSession> => {
			return {
				id: s.name.replace(/\.jsonl$/, ""),
				mtimeMs: s.mtimeMs,
				preview: await firstUserPrompt(s.path),
			};
		}),
	);
}

function encodeProjectDir(cwd: string): string {
	return cwd.replace(/\//g, "-");
}

async function firstUserPrompt(path: string): Promise<string> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return "(could not read session)";
	}
	const lines = raw.split("\n");
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as {
				type?: string;
				isMeta?: boolean;
				message?: { role?: string; content?: unknown };
			};
			if (parsed.type !== "user" || parsed.isMeta) continue;
			const content = parsed.message?.content;
			let text = "";
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) {
				for (const c of content as Array<{ type?: string; text?: string }>) {
					if (c?.type === "text" && typeof c.text === "string") {
						text = c.text;
						break;
					}
				}
			}
			if (text && !text.startsWith("<")) {
				return truncate(text, 100);
			}
		} catch {
			// skip unparseable lines
		}
	}
	return "(no user prompt found)";
}

function truncate(s: string, n: number): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > n ? `${oneLine.slice(0, n - 1)}…` : oneLine;
}

export async function loadSessionTranscript(
	cwd: string,
	sessionId: string,
): Promise<ReplayMessage[]> {
	const path = join(homedir(), ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return [];
	}

	const out: ReplayMessage[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let parsed: {
			type?: string;
			isMeta?: boolean;
			timestamp?: string;
			message?: { role?: "user" | "assistant"; content?: unknown };
		};
		try {
			parsed = JSON.parse(line) as typeof parsed;
		} catch {
			continue;
		}
		if (parsed.isMeta) continue;
		if (parsed.type !== "user" && parsed.type !== "assistant") continue;
		const role = parsed.message?.role;
		if (role !== "user" && role !== "assistant") continue;

		const blocks = normalizeContent(parsed.message?.content);
		if (blocks.length === 0) continue;
		if (role === "user" && isMetaUserContent(blocks)) continue;

		const timestamp = parsed.timestamp ? Date.parse(parsed.timestamp) : undefined;
		out.push({ role, blocks, timestamp: Number.isFinite(timestamp) ? timestamp : undefined });
	}
	return out;
}

function normalizeContent(content: unknown): ContentBlock[] {
	if (typeof content === "string") {
		return content.length > 0 ? [{ type: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) return [];
	const out: ContentBlock[] = [];
	for (const c of content as Array<Record<string, unknown>>) {
		if (!c || typeof c !== "object") continue;
		const t = c.type;
		if (t === "text" && typeof c.text === "string") {
			out.push({ type: "text", text: c.text });
		} else if (t === "thinking" && typeof c.thinking === "string") {
			out.push({ type: "thinking", thinking: c.thinking });
		} else if (
			t === "tool_use" &&
			typeof c.id === "string" &&
			typeof c.name === "string" &&
			c.input &&
			typeof c.input === "object"
		) {
			out.push({
				type: "tool_use",
				id: c.id,
				name: c.name,
				input: c.input as Record<string, unknown>,
			});
		} else if (t === "tool_result" && typeof c.tool_use_id === "string") {
			out.push({
				type: "tool_result",
				tool_use_id: c.tool_use_id,
				content: (c.content as ContentBlock[] | string) ?? "",
				is_error: Boolean(c.is_error),
			});
		} else if (
			(t === "image" || t === "document") &&
			c.source &&
			typeof c.source === "object"
		) {
			const src = c.source as Record<string, unknown>;
			if (
				src.type === "base64" &&
				typeof src.media_type === "string" &&
				typeof src.data === "string"
			) {
				out.push({
					type: t,
					source: {
						type: "base64",
						media_type: src.media_type,
						data: src.data,
					},
				});
			}
		}
	}
	return out;
}

function isMetaUserContent(blocks: ContentBlock[]): boolean {
	if (blocks.length !== 1) return false;
	const b = blocks[0];
	if (!b || b.type !== "text") return false;
	return b.text.startsWith("<");
}

export async function loadSessionTitle(cwd: string, sessionId: string): Promise<string | null> {
	const path = join(homedir(), ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		return null;
	}
	let custom: string | null = null;
	let ai: string | null = null;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as {
				type?: string;
				customTitle?: string;
				aiTitle?: string;
			};
			if (parsed.type === "custom-title" && typeof parsed.customTitle === "string") {
				custom = parsed.customTitle;
			} else if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string") {
				ai = parsed.aiTitle;
			}
		} catch {
			/* skip */
		}
	}
	return custom ?? ai;
}
