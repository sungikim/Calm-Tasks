import { App, MarkdownView, Notice } from "obsidian";
import type { TaskStore } from "../task-store";
import type { CalmTasksSettings } from "../types";
import { MicrosoftAuth } from "./auth";
import { GraphClient } from "./graph";
import { normalizePath } from "./markdown";
import { SyncEngine } from "./sync-engine";
import { DEFAULT_SETTINGS, type PluginSettings, type TokenSet } from "./types";

export class MicrosoftSyncCoordinator {
  private auth?: MicrosoftAuth;
  private engine?: SyncEngine;
  private autoSyncTimer?: number;

  constructor(
    private readonly app: App,
    private readonly store: TaskStore,
    private readonly getSettings: () => CalmTasksSettings,
    private readonly persist: () => Promise<void>
  ) {}

  get settings(): PluginSettings { return this.getSettings().microsoftSync; }

  async updateEnabled(): Promise<void> {
    this.stopRuntime();
    if (!this.settings.enabled) return;
    await this.migrateLegacySettings();
    this.initializeRuntime();
  }

  unload(): void { this.stopRuntime(); }

  async login(onCode: (code: string, uri: string) => void): Promise<void> {
    if (!this.settings.enabled) throw new Error("Enable Microsoft To Do sync first.");
    this.initializeRuntime();
    await this.auth?.beginDeviceLogin(device => onCode(device.user_code, device.verification_uri));
    this.resetAutoSync();
  }

  async logout(): Promise<void> {
    this.auth?.cancelLogin();
    await this.setToken(null);
    this.resetAutoSync();
    new Notice("Microsoft login token removed from this device.");
  }

  async clearConflicts(): Promise<void> {
    this.settings.conflicts = [];
    await this.persist();
  }

  async syncWithNotice(showStart = true): Promise<void> {
    if (!this.settings.enabled) {
      if (showStart) new Notice("Microsoft To Do sync is disabled.");
      return;
    }
    if (!this.settings.token) {
      if (showStart) new Notice("Sign in to Microsoft in Calm Tasks settings first.");
      return;
    }
    this.initializeRuntime();
    if (showStart) new Notice("Microsoft To Do sync started…");
    try {
      await this.engine?.sync();
      if (showStart) this.resetAutoSync();
    } catch (error) {
      console.error("Calm Tasks Microsoft sync failed", error);
      new Notice(`Sync failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }

  applyVisualSettings(): void {
    if (!this.settings.enabled) {
      document.documentElement.style.removeProperty("--ms-todo-child-opacity");
      document.documentElement.style.removeProperty("--ms-todo-child-font-weight");
      return;
    }
    document.documentElement.style.setProperty("--ms-todo-child-opacity", String(this.settings.childOpacity));
    document.documentElement.style.setProperty("--ms-todo-child-font-weight", String(this.settings.childFontWeight));
  }

  private initializeRuntime(): void {
    if (!this.settings.enabled || this.auth || this.engine) return;
    this.auth = new MicrosoftAuth(() => this.settings, token => this.setToken(token));
    this.engine = new SyncEngine(
      this.app.vault,
      this.store,
      () => this.getSettings(),
      new GraphClient(() => (this.auth as MicrosoftAuth).getAccessToken()),
      () => this.settings,
      this.persist
    );
    this.applyVisualSettings();
    this.resetAutoSync();
  }

  private stopRuntime(): void {
    this.auth?.cancelLogin();
    this.auth = undefined;
    this.engine = undefined;
    if (this.autoSyncTimer !== undefined) window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = undefined;
    this.applyVisualSettings();
  }

  private resetAutoSync(): void {
    if (this.autoSyncTimer !== undefined) window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = undefined;
    if (!this.settings.enabled || !this.settings.token) return;
    this.settings.autoSyncMinutes = 15;
    this.autoSyncTimer = window.setInterval(() => {
      if (!this.isManagedFileBeingEdited()) void this.syncWithNotice(false);
    }, 15 * 60_000);
  }

  private isManagedFileBeingEdited(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return Boolean(view?.file
      && view.getMode() === "source"
      && view.editor.hasFocus()
      && view.file.path === normalizePath(this.settings.markdownPath));
  }

  private async setToken(token: TokenSet | null): Promise<void> {
    this.settings.token = token;
    await this.persist();
  }

  private async migrateLegacySettings(): Promise<void> {
    if (this.settings.legacyMigrated) return;
    const path = `${this.app.vault.configDir}/plugins/ms-todo-markdown-sync/data.json`;
    try {
      if (await this.app.vault.adapter.exists(path)) {
        const legacy = JSON.parse(await this.app.vault.adapter.read(path)) as Partial<PluginSettings>;
        Object.assign(this.settings, DEFAULT_SETTINGS, legacy, {
          enabled: true,
          legacyMigrated: true,
          autoSyncMinutes: 15,
          snapshots: legacy.snapshots ?? {},
          conflicts: legacy.conflicts ?? [],
          calmImports: legacy.calmImports ?? {},
          deletions: legacy.deletions ?? {}
        });
      } else {
        this.settings.legacyMigrated = true;
      }
    } catch (error) {
      console.warn("Could not migrate the previous Calm To Do Sync settings", error);
      this.settings.legacyMigrated = true;
    }
    await this.persist();
  }
}
