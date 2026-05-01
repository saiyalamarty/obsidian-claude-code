import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
	ClaudeCodeSettings,
	ClaudeCodeSettingTab,
	DEFAULT_SETTINGS,
	ViewLocation,
} from "./settings";
import { CLAUDE_CODE_VIEW_TYPE, ChatView } from "./view/chat-view";
import { PermissionServer } from "./claude/permission-server";
import { setEnabled as setLoggingEnabled } from "./log";

export default class ClaudeCodePlugin extends Plugin {
	settings!: ClaudeCodeSettings;
	permissionServer!: PermissionServer;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.permissionServer = new PermissionServer();
		try {
			await this.permissionServer.start();
		} catch (err) {
			console.error("[claude-code] permission server failed to start", err);
			new Notice("Permission server failed to start; tool approval will not work.");
		}

		this.registerView(CLAUDE_CODE_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

		this.addRibbonIcon("bot", "Open chat", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open",
			name: "Open chat",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "open-here",
			name: "Open chat in current pane",
			callback: () => {
				void this.activateView("center");
			},
		});

		this.addSettingTab(new ClaudeCodeSettingTab(this.app, this));
	}

	onunload(): void {
		this.permissionServer?.stop();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ClaudeCodeSettings>,
		);
		if (this.settings.permissionMode !== "default") {
			this.settings.permissionMode = "default";
		}
		setLoggingEnabled(this.settings.debugLogging);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		setLoggingEnabled(this.settings.debugLogging);
	}

	getWorkingDirectory(): string | null {
		if (this.settings.workingDirectory === "custom") {
			return this.settings.customWorkingDirectory || null;
		}
		const adapter = this.app.vault.adapter as {
			basePath?: string;
			getBasePath?: () => string;
		};
		if (typeof adapter.getBasePath === "function") return adapter.getBasePath();
		if (typeof adapter.basePath === "string") return adapter.basePath;
		return null;
	}

	async activateView(locationOverride?: ViewLocation): Promise<void> {
		const location = locationOverride ?? this.settings.viewLocation;
		const existing = this.app.workspace.getLeavesOfType(CLAUDE_CODE_VIEW_TYPE)[0];

		let leaf: WorkspaceLeaf | null;
		if (existing) {
			leaf = existing;
		} else {
			leaf = this.leafForLocation(location);
			if (!leaf) {
				new Notice(`Claude Code: could not open ${location} leaf.`);
				return;
			}
			await leaf.setViewState({ type: CLAUDE_CODE_VIEW_TYPE, active: true });
		}
		void this.app.workspace.revealLeaf(leaf);
	}

	private leafForLocation(location: ViewLocation): WorkspaceLeaf | null {
		switch (location) {
			case "right":
				return this.app.workspace.getRightLeaf(false);
			case "left":
				return this.app.workspace.getLeftLeaf(false);
			case "center":
			default:
				return this.app.workspace.getLeaf("tab");
		}
	}
}
