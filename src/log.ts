// Minimal toggleable logger. Consult `setEnabled(true)` from the plugin's
// settings load/save, and every callsite uses `log()` instead of console.log.

let enabled = false;

export function setEnabled(value: boolean): void {
	enabled = value;
}

export function log(...args: unknown[]): void {
	if (!enabled) return;
	console.log(...args);
}
