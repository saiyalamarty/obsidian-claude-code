import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
	".local/bin/claude",
	"bin/claude",
];

const SYSTEM_PATHS = [
	"/usr/local/bin/claude",
	"/opt/homebrew/bin/claude",
	"/usr/bin/claude",
];

let cached: string | null = null;

export function resolveBinary(userPath: string): string {
	if (userPath && userPath !== "claude" && existsSync(userPath)) return userPath;

	if (cached) return cached;

	const home = homedir();
	for (const rel of CANDIDATES) {
		const p = join(home, rel);
		if (existsSync(p)) return (cached = p);
	}
	for (const p of SYSTEM_PATHS) {
		if (existsSync(p)) return (cached = p);
	}

	try {
		const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-l", "-c", "command -v claude"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (out && existsSync(out)) return (cached = out);
	} catch {
		// fallthrough
	}

	return userPath || "claude";
}
