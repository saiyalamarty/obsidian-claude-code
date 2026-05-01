import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeFileDefaults {
	effort?: string;
	model?: string;
}

export async function loadClaudeFileDefaults(cwd: string): Promise<ClaudeFileDefaults> {
	const [project, user] = await Promise.all([
		readSettings(join(cwd, ".claude", "settings.json")),
		readSettings(join(homedir(), ".claude", "settings.json")),
	]);
	return {
		effort: project.effortLevel ?? user.effortLevel,
		model: project.model ?? user.model,
	};
}

async function readSettings(
	path: string,
): Promise<{ effortLevel?: string; model?: string }> {
	try {
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			effortLevel:
				typeof parsed.effortLevel === "string" ? parsed.effortLevel : undefined,
			model: typeof parsed.model === "string" ? parsed.model : undefined,
		};
	} catch {
		return {};
	}
}
