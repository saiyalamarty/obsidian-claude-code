import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudeCodePlugin from "./main";
import { loadClaudeFileDefaults } from "./claude/claude-config";

export type ViewLocation = "center" | "right" | "left";
export type WorkingDirMode = "vault" | "custom";
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";
export type DiffStyle = "unified" | "split";
export type DiffOverflow = "scroll" | "wrap";
export type EffortLevel = "" | "low" | "medium" | "high" | "xhigh" | "max";

export const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "opus", label: "Opus" },
	{ value: "sonnet", label: "Sonnet" },
	{ value: "haiku", label: "Haiku" },
];

export const EFFORT_OPTIONS: Array<{ value: EffortLevel; label: string }> = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "Extra high" },
	{ value: "max", label: "Max" },
];

export interface ClaudeCodeSettings {
	claudeBinaryPath: string;
	workingDirectory: WorkingDirMode;
	customWorkingDirectory: string;
	viewLocation: ViewLocation;
	permissionMode: PermissionMode;
	defaultModel: string;
	defaultEffort: EffortLevel;
	diffStyle: DiffStyle;
	diffOverflow: DiffOverflow;
	largeFileThresholdBytes: number;
	debugLogging: boolean;
}

export const DEFAULT_SETTINGS: ClaudeCodeSettings = {
	claudeBinaryPath: "claude",
	workingDirectory: "vault",
	customWorkingDirectory: "",
	viewLocation: "center",
	permissionMode: "default",
	defaultModel: "",
	defaultEffort: "",
	diffStyle: "unified",
	diffOverflow: "scroll",
	largeFileThresholdBytes: 500_000,
	debugLogging: false,
};

export class ClaudeCodeSettingTab extends PluginSettingTab {
	plugin: ClaudeCodePlugin;

	constructor(app: App, plugin: ClaudeCodePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Process").setHeading();

		new Setting(containerEl)
			.setName("Claude binary path")
			.setDesc("Path to the claude executable. Use just 'claude' if it's on PATH.")
			.addText((text) =>
				text
					.setPlaceholder("claude")
					.setValue(this.plugin.settings.claudeBinaryPath)
					.onChange(async (value) => {
						this.plugin.settings.claudeBinaryPath = value.trim() || "claude";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Working directory")
			.setDesc("Where claude is spawned. Vault root is the default.")
			.addDropdown((dd) =>
				dd
					.addOption("vault", "Vault root")
					.addOption("custom", "Custom path")
					.setValue(this.plugin.settings.workingDirectory)
					.onChange(async (value) => {
						this.plugin.settings.workingDirectory = value as WorkingDirMode;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.workingDirectory === "custom") {
			new Setting(containerEl)
				.setName("Custom working directory")
				.setDesc("Absolute path used when 'Custom path' is selected.")
				.addText((text) =>
					text
						.setPlaceholder("/Users/you/code/project")
						.setValue(this.plugin.settings.customWorkingDirectory)
						.onChange(async (value) => {
							this.plugin.settings.customWorkingDirectory = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Permission mode")
			.setDesc(
				"Locked to Default while the in-panel approval UI is being built. Other modes will be enabled once the gate ships.",
			)
			.addDropdown((dd) => {
				dd.addOption("default", "Default (prompt per tool)")
					.addOption("acceptEdits", "Auto-accept edits")
					.addOption("bypassPermissions", "Bypass all (dangerous)")
					.addOption("plan", "Plan mode (read-only)")
					.setValue("default")
					.setDisabled(true);
				if (this.plugin.settings.permissionMode !== "default") {
					this.plugin.settings.permissionMode = "default";
					void this.plugin.saveSettings();
				}
				return dd;
			});

		const modelTextSetting = new Setting(containerEl)
			.setName("Default model")
			.setDesc("Used as the per-chat default. Leave blank to inherit from claude config.")
			.addText((text) =>
				text
					.setPlaceholder("opus, sonnet, haiku, or claude-opus-4-7")
					.setValue(this.plugin.settings.defaultModel)
					.onChange(async (value) => {
						this.plugin.settings.defaultModel = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		let effortDropdownEl: HTMLSelectElement | null = null;
		new Setting(containerEl)
			.setName("Default effort")
			.setDesc("Used as the per-chat default.")
			.addDropdown((dd) => {
				for (const opt of EFFORT_OPTIONS) dd.addOption(opt.value, opt.label);
				dd.setValue(this.plugin.settings.defaultEffort || "medium");
				dd.onChange(async (value) => {
					this.plugin.settings.defaultEffort = value as EffortLevel;
					await this.plugin.saveSettings();
				});
				effortDropdownEl = dd.selectEl;
			});

		const cwd = this.plugin.getWorkingDirectory();
		if (cwd) {
			void loadClaudeFileDefaults(cwd).then((claudeDefaults) => {
				if (claudeDefaults.model) {
					const input = modelTextSetting.controlEl.querySelector(
						"input",
					) as HTMLInputElement | null;
					if (input) {
						input.placeholder = `inherit from claude config: ${claudeDefaults.model}`;
					}
				}
				if (effortDropdownEl && !this.plugin.settings.defaultEffort && claudeDefaults.effort) {
					effortDropdownEl.value = claudeDefaults.effort;
				}
			});
		}

		new Setting(containerEl).setName("View").setHeading();

		new Setting(containerEl)
			.setName("Default view location")
			.setDesc("Where the chat opens when invoked from the command palette or ribbon.")
			.addDropdown((dd) =>
				dd
					.addOption("center", "Center (new tab)")
					.addOption("right", "Right sidebar")
					.addOption("left", "Left sidebar")
					.setValue(this.plugin.settings.viewLocation)
					.onChange(async (value) => {
						this.plugin.settings.viewLocation = value as ViewLocation;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Diffs").setHeading();

		new Setting(containerEl)
			.setName("Default diff style")
			.setDesc("Layout for inline tool-call diffs.")
			.addDropdown((dd) =>
				dd
					.addOption("unified", "Unified")
					.addOption("split", "Split")
					.setValue(this.plugin.settings.diffStyle)
					.onChange(async (value) => {
						this.plugin.settings.diffStyle = value as DiffStyle;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Line overflow")
			.setDesc("How long lines are handled in diffs.")
			.addDropdown((dd) =>
				dd
					.addOption("scroll", "Scroll")
					.addOption("wrap", "Wrap")
					.setValue(this.plugin.settings.diffOverflow)
					.onChange(async (value) => {
						this.plugin.settings.diffOverflow = value as DiffOverflow;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Large file threshold (bytes)")
			.setDesc(
				"Files larger than this show a click-to-load placeholder instead of auto-rendering.",
			)
			.addText((text) =>
				text
					.setPlaceholder("500000")
					.setValue(String(this.plugin.settings.largeFileThresholdBytes))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.largeFileThresholdBytes =
							Number.isFinite(n) && n >= 0 ? n : 500_000;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Debug").setHeading();

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Print stream events, hook traffic, and approval routing to the dev console.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}
