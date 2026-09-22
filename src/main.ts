import { App, Notice, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import { TaskStore } from "./task-store";
import { CalmTasksView, VIEW_TYPE_CALM_TASKS } from "./task-view";
import { CalmTasksSettings } from "./types";
import { calmTaskEditorExtension, decorateRenderedTaskMetadata } from "./editor-decorations";
import { DEFAULT_SETTINGS as DEFAULT_SYNC_SETTINGS } from "./sync/types";
import { MicrosoftSyncCoordinator } from "./sync/coordinator";

function normalizeDailyNotesBaseFolder(value: string): string {
  return value.trim().replace(/^\/+|\/+$/gu, "").replace(/\/(?:19|20)\d{2}\/(?:0[1-9]|1[0-2])$/u, "");
}

const DEFAULT_SETTINGS: CalmTasksSettings = {
  showPxdTodoFile: true,
  upcomingDays: 14,
  excludedFolders: [".trash"],
  newTaskFile: "Calm Tasks.md",
  taskSpacingPx: 3,
  taskLineHeightPx: 15,
  subtaskCircleOpacityPercent: 40,
  highlightTaskMetadataInMarkdown: true,
  dimCompletedTasksInMarkdown: true,
  completedMetadataOpacityPercent: 50,
  dailyCompletionArchiveEnabled: true,
  dailyCompletionArchiveTime: "04:00",
  preserveDailyNoteTaskPlacement: false,
  moveTasksToDailyNoteEnabled: false,
  dailyNotesFolder: "",
  dailyNoteTaskHeading: "# 오늘의 할 일",
  showDetailPanel: true,
  detailPanelPosition: "bottom",
  groups: [],
  groupAssignments: {},
  fileGroupAssignments: {},
  taskOrder: {},
  smartFilters: [],
  microsoftSync: { ...DEFAULT_SYNC_SETTINGS }
};

export default class CalmTasksPlugin extends Plugin {
  override settings: CalmTasksSettings = DEFAULT_SETTINGS;
  private store!: TaskStore;
  syncCoordinator!: MicrosoftSyncCoordinator;
  private settingsSaveQueue: Promise<void> = Promise.resolve();

  override async onload(): Promise<void> {
    const loaded = await this.loadData() as Partial<CalmTasksSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {}, {
      microsoftSync: { ...DEFAULT_SYNC_SETTINGS, ...(loaded?.microsoftSync ?? {}), enabled: loaded?.microsoftSync?.enabled ?? false }
    });
    this.settings.dailyNotesFolder = normalizeDailyNotesBaseFolder(this.settings.dailyNotesFolder);
    this.settings.smartFilters.forEach(filter => {
      const savedMode = String(filter.mode);
      if (["calendar", "today", "upcoming"].includes(savedMode)) filter.mode = "agenda";
      if (savedMode === "completed") {
        filter.mode = "all";
        filter.filters.status = "done";
      }
      if (!["all", "3days", "7days", "30days"].includes(filter.completedRange)) filter.completedRange = "all";
    });
    this.store = new TaskStore(this.app, this.settings);
    this.syncCoordinator = new MicrosoftSyncCoordinator(this.app, this.store, () => this.settings, () => this.saveSettings());
    this.applyMarkdownCompletedStyleSetting();
    this.registerEditorExtension(calmTaskEditorExtension);
    this.registerMarkdownPostProcessor(element => decorateRenderedTaskMetadata(element));
    this.registerView(VIEW_TYPE_CALM_TASKS, leaf => new CalmTasksView(leaf, this.store, () => this.settings, () => this.saveSettings()));
    this.addRibbonIcon("circle-check-big", "Open Calm Tasks", () => void this.activateView());
    this.addCommand({ id: "open-task-workspace", name: "Open task workspace", callback: () => void this.activateView() });
    this.addCommand({ id: "sync-microsoft-todo-now", name: "Sync Microsoft To Do now", callback: () => void this.syncCoordinator.syncWithNotice() });
    this.addCommand({
      id: "move-selected-task-up",
      name: "Move selected task up",
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(CalmTasksView);
        if (!view?.canMoveSelection()) return false;
        if (!checking) view.moveSelection(-1);
        return true;
      }
    });
    this.addCommand({
      id: "move-selected-task-down",
      name: "Move selected task down",
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(CalmTasksView);
        if (!view?.canMoveSelection()) return false;
        if (!checking) view.moveSelection(1);
        return true;
      }
    });
    this.addSettingTab(new CalmTasksSettingTab(this.app, this));
    await this.store.start();
    await this.syncCoordinator.updateEnabled();
  }

  override onunload(): void {
    this.store.stop();
    this.syncCoordinator.unload();
    document.body.removeClass("calm-highlight-task-metadata-in-notes");
    document.body.removeClass("calm-dim-completed-markdown-tasks");
    document.body.style.removeProperty("--calm-completed-metadata-opacity");
    document.body.style.removeProperty("--calm-completed-metadata-opacity-percent");
  }

  applyMarkdownCompletedStyleSetting(): void {
    document.body.toggleClass("calm-highlight-task-metadata-in-notes", this.settings.highlightTaskMetadataInMarkdown);
    document.body.toggleClass("calm-dim-completed-markdown-tasks", this.settings.dimCompletedTasksInMarkdown);
    document.body.setCssProps({
      "--calm-completed-metadata-opacity": String(this.settings.completedMetadataOpacityPercent / 100),
      "--calm-completed-metadata-opacity-percent": `${this.settings.completedMetadataOpacityPercent}%`
    });
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CALM_TASKS)[0];
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE_CALM_TASKS, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async saveSettings(refreshStore = false): Promise<void> {
    const operation = this.settingsSaveQueue.then(async () => {
      await this.saveData(this.settings);
      if (refreshStore) await this.store.updateSettings(this.settings);
      this.app.workspace.getLeavesOfType(VIEW_TYPE_CALM_TASKS).forEach(leaf => {
        if (leaf.view instanceof CalmTasksView) leaf.view.applyAppearanceSettings();
      });
    });
    this.settingsSaveQueue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

class CalmTasksSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CalmTasksPlugin) { super(app, plugin); }

  override display(): void { this.renderSettings(); }

  private renderSettings(): void {
    this.containerEl.empty();
    this.containerEl.addClass("calm-settings");
    const createGroup = (title: string, description: string): HTMLElement => {
      const section = this.containerEl.createDiv({ cls: "calm-settings-section" });
      new Setting(section).setName(title).setDesc(description).setHeading();
      return section.createDiv({ cls: "calm-settings-card" });
    };
    const appearance = createGroup("Appearance", "Adjust the density and visual weight of task rows.");
    const details = createGroup("Details", "Choose when and where the selected task's details appear.");
    const behavior = createGroup("Task behavior", "Configure task ranges, storage, and Vault scanning.");

    new Setting(appearance).setName("Task vertical spacing").setDesc("Extra space above and below each task row, in pixels (0–20).").addText(text => text
      .setPlaceholder("3").setValue(String(this.plugin.settings.taskSpacingPx)).onChange(async value => {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
          this.plugin.settings.taskSpacingPx = Math.max(0, Math.min(20, parsed));
          await this.plugin.saveSettings();
        }
      }));
    new Setting(appearance).setName("Task text line height").setDesc("Line height for wrapped task titles, in pixels (12–32).").addText(text => text
      .setPlaceholder("15").setValue(String(this.plugin.settings.taskLineHeightPx)).onChange(async value => {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
          this.plugin.settings.taskLineHeightPx = Math.max(12, Math.min(32, parsed));
          await this.plugin.saveSettings();
        }
      }));
    new Setting(appearance).setName("Subtask circle opacity").setDesc("Opacity of incomplete subtask circles, as a percentage (0–100).").addText(text => text
      .setPlaceholder("40").setValue(String(this.plugin.settings.subtaskCircleOpacityPercent)).onChange(async value => {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
          this.plugin.settings.subtaskCircleOpacityPercent = Math.max(0, Math.min(100, parsed));
          await this.plugin.saveSettings();
        }
      }));
    new Setting(appearance).setName("Highlight task metadata in notes").setDesc("Color dates and priorities in tasks shown in ordinary Markdown notes.").addToggle(toggle => toggle
      .setValue(this.plugin.settings.highlightTaskMetadataInMarkdown).onChange(async value => {
        this.plugin.settings.highlightTaskMetadataInMarkdown = value;
        this.plugin.applyMarkdownCompletedStyleSetting();
        await this.plugin.saveSettings();
      }));
    new Setting(appearance).setName("Dim completed tasks in notes").setDesc("In ordinary Markdown notes, remove date and priority highlights from completed tasks and show their text in a darker tone.").addToggle(toggle => toggle
      .setValue(this.plugin.settings.dimCompletedTasksInMarkdown).onChange(async value => {
        this.plugin.settings.dimCompletedTasksInMarkdown = value;
        this.plugin.applyMarkdownCompletedStyleSetting();
        await this.plugin.saveSettings();
      }));
    new Setting(appearance).setName("Completed metadata opacity").setDesc("Opacity of dates, priorities, and their dividers on completed tasks in ordinary Markdown notes, as a percentage (0–100).").addText(text => text
      .setPlaceholder("50").setValue(String(this.plugin.settings.completedMetadataOpacityPercent)).onChange(async value => {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
          this.plugin.settings.completedMetadataOpacityPercent = Math.max(0, Math.min(100, parsed));
          this.plugin.applyMarkdownCompletedStyleSetting();
          await this.plugin.saveSettings();
        }
      }));
    new Setting(details).setName("Show detail panel").setDesc("Show task details when a task is selected.").addToggle(toggle => toggle
      .setValue(this.plugin.settings.showDetailPanel).onChange(async value => {
        this.plugin.settings.showDetailPanel = value;
        await this.plugin.saveSettings();
        this.app.workspace.getLeavesOfType(VIEW_TYPE_CALM_TASKS).forEach(leaf => {
          if (leaf.view instanceof CalmTasksView) leaf.view.setDetailPanelEnabled(value);
        });
      }));
    new Setting(details).setName("Detail panel position").setDesc("Place task details on the right or below the task list.").addDropdown(dropdown => dropdown
      .addOption("right", "Right")
      .addOption("bottom", "Bottom")
      .setValue(this.plugin.settings.detailPanelPosition)
      .onChange(async value => {
        this.plugin.settings.detailPanelPosition = value as "right" | "bottom";
        await this.plugin.saveSettings();
        this.app.workspace.getLeavesOfType(VIEW_TYPE_CALM_TASKS).forEach(leaf => {
          if (leaf.view instanceof CalmTasksView) leaf.view.setDetailPanelPosition();
        });
      }));
    new Setting(behavior).setName("Upcoming range").setDesc("Number of days shown in upcoming.").addText(text => text
      .setPlaceholder("14").setValue(String(this.plugin.settings.upcomingDays)).onChange(async value => {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          this.plugin.settings.upcomingDays = parsed;
          await this.plugin.saveSettings();
          this.app.workspace.getLeavesOfType(VIEW_TYPE_CALM_TASKS).forEach(leaf => {
            if (leaf.view instanceof CalmTasksView) leaf.view.refreshWorkspace();
          });
        }
      }));
    new Setting(behavior).setName("Daily completion archive").setDesc("At the scheduled local time, stop retaining tasks completed during the current session so they follow the normal completed-task filters.").addToggle(toggle => toggle
      .setValue(this.plugin.settings.dailyCompletionArchiveEnabled).onChange(async value => {
        this.plugin.settings.dailyCompletionArchiveEnabled = value;
        await this.plugin.saveSettings();
        this.app.workspace.getLeavesOfType(VIEW_TYPE_CALM_TASKS).forEach(leaf => {
          if (leaf.view instanceof CalmTasksView) leaf.view.applyCompletionArchiveSettings();
        });
      }));
    new Setting(behavior).setName("Daily archive time").setDesc("Computer-local time used for the daily completion archive.").addText(text => {
      text.inputEl.inputMode = "numeric";
      text.inputEl.maxLength = 5;
      text.inputEl.pattern = "(?:[01]\\d|2[0-3]):[0-5]\\d";
      text.inputEl.addClass("calm-time-input");
      text.setPlaceholder("04:00").setValue(this.plugin.settings.dailyCompletionArchiveTime).onChange(async value => {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) return;
        this.plugin.settings.dailyCompletionArchiveTime = value;
        await this.plugin.saveSettings();
        this.app.workspace.getLeavesOfType(VIEW_TYPE_CALM_TASKS).forEach(leaf => {
          if (leaf.view instanceof CalmTasksView) leaf.view.applyCompletionArchiveSettings();
        });
      });
    });
    new Setting(behavior).setName("Preserve daily note placement").setDesc("When an unchanged task moves between dated daily notes in either direction, preserve its all-view group and order.").addToggle(toggle => toggle
      .setValue(this.plugin.settings.preserveDailyNoteTaskPlacement).onChange(async value => {
        this.plugin.settings.preserveDailyNoteTaskPlacement = value;
        await this.plugin.saveSettings();
        this.app.workspace.getLeavesOfType(VIEW_TYPE_CALM_TASKS).forEach(leaf => {
          if (leaf.view instanceof CalmTasksView) leaf.view.refreshWorkspace();
        });
      }));
    new Setting(behavior).setClass("calm-setting-wide").setName("New task file").setDesc("Vault-relative Markdown file used for tasks created in Calm Tasks.").addText(text => text
      .setPlaceholder("Tasks/Calm Tasks.md").setValue(this.plugin.settings.newTaskFile).onChange(async value => {
        this.plugin.settings.newTaskFile = value.trim();
        await this.plugin.saveSettings(true);
      }));
    new Setting(behavior).setName("Excluded folders").setDesc("Comma-separated vault folders that Calm Tasks should ignore.").addText(text => text
      .setPlaceholder(".trash, templates").setValue(this.plugin.settings.excludedFolders.join(", ")).onChange(async value => {
        this.plugin.settings.excludedFolders = value.split(",").map(item => item.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
        await this.plugin.saveSettings(true);
      }));
    const supportCard = createGroup("Support", "If Calm Tasks helps you stay organized, a small coffee helps keep its development going.");
    const support = supportCard.createDiv({ cls: "calm-settings-support" });
    support.createDiv({
      cls: "calm-settings-support-copy",
      text: "Thank you for supporting the continued development of Calm Tasks."
    });
    const supportLink = support.createEl("a", {
      cls: "calm-settings-support-link",
      href: "https://buymeacoffee.com/sungikimi",
      attr: {
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": "Support Calm Tasks on Buy Me a Coffee"
      }
    });
    supportLink.createEl("img", {
      attr: {
        src: "https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png",
        alt: "Buy Me a Coffee"
      }
    });

    const sync = createGroup("Microsoft To Do sync", "Optional two-way sync. It uses no timer, authentication, or network resources while disabled.");
    new Setting(sync).setName("Enable Microsoft To Do sync").setDesc("Keep this off unless you want to connect Calm Tasks to Microsoft To Do.").addToggle(toggle => toggle
      .setValue(this.plugin.settings.microsoftSync.enabled).onChange(async value => {
        this.plugin.settings.microsoftSync.enabled = value;
        await this.plugin.saveSettings();
        await this.plugin.syncCoordinator.updateEnabled();
        this.redisplayPreservingScroll();
      }));
    if (this.plugin.settings.microsoftSync.enabled) {

    const syncSettings = this.plugin.settings.microsoftSync;
    new Setting(sync).setClass("calm-setting-wide").setName("Managed Markdown file").setDesc("Vault-relative mirror file for Microsoft To Do lists. The .md extension is added automatically.").addText(text => text
      .setPlaceholder("Tasks/MS-ToDo").setValue(syncSettings.markdownPath).onChange(async value => {
        syncSettings.markdownPath = value.trim();
        await this.plugin.saveSettings();
      }));
    new Setting(sync).setClass("calm-setting-wide").setName("Microsoft Entra client ID").setDesc("Application (client) ID for a public client app. Calm Tasks never uses a client secret.").addText(text => text
      .setPlaceholder("00000000-0000-0000-0000-000000000000").setValue(syncSettings.clientId).onChange(async value => {
        syncSettings.clientId = value.trim();
        await this.plugin.saveSettings();
      }));
    new Setting(sync).setName("Tenant / authority").setDesc("Use common, consumers, organizations, or a tenant ID.").addText(text => text
      .setValue(syncSettings.tenant).onChange(async value => {
        syncSettings.tenant = value.trim() || "common";
        await this.plugin.saveSettings();
      }));

    const status = sync.createDiv({ cls: "ms-todo-sync-status" });
    status.createEl("strong", { text: syncSettings.token ? "Status: signed in" : "Status: sign-in required" });
    if (syncSettings.lastSyncAt) status.createDiv({ text: `Last sync: ${new Date(syncSettings.lastSyncAt).toLocaleString()} · ${syncSettings.lastSyncMessage ?? ""}` });
    const auth = new Setting(sync).setName("Microsoft account").setDesc("Uses Microsoft device login with Tasks.ReadWrite permission.");
    if (syncSettings.token) {
      auth.addButton(button => {
        button.setButtonText("Sign out");
        button.buttonEl.addClass("mod-warning");
        button.onClick(async () => {
          await this.plugin.syncCoordinator.logout();
          this.renderSettings();
        });
      });
    } else {
      auth.addButton(button => button.setButtonText("Sign in").setCta().onClick(async () => {
        button.setDisabled(true).setButtonText("Waiting for sign-in…");
        try {
          await this.plugin.syncCoordinator.login((code, uri) => this.showDeviceCode(sync, code, uri));
          new Notice("Microsoft sign-in completed.");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 8000);
        }
        this.renderSettings();
      }));
    }

    new Setting(sync).setName("Automatic sync").setDesc("Runs at most once every 15 minutes. File changes and focus changes never trigger immediate network sync.");
    new Setting(sync).setName("Sync Calm Tasks items").setDesc("Treat Obsidian tasks as the source of truth, including completion, edits, grouping metadata, additions, and deletions.").addToggle(toggle => toggle
      .setValue(syncSettings.calmImportEnabled).onChange(async value => {
        syncSettings.calmImportEnabled = value;
        await this.plugin.saveSettings();
      }));
    new Setting(sync).setName("Microsoft target list").setDesc("Microsoft To Do list used for Calm Tasks items.").addText(text => text
      .setPlaceholder("Tasks").setValue(syncSettings.calmTargetListName).onChange(async value => {
        syncSettings.calmTargetListName = value.trim() || "Tasks";
        await this.plugin.saveSettings();
      }));
    new Setting(sync).setName("Nested content opacity").setDesc("Opacity of note and multiline content in the managed Markdown file.").addSlider(slider => slider
      .setLimits(0.1, 1, 0.05).setValue(syncSettings.childOpacity).onChange(async value => {
        syncSettings.childOpacity = value;
        this.plugin.syncCoordinator.applyVisualSettings();
        await this.plugin.saveSettings();
      }));
    new Setting(sync).setName("Nested content weight").setDesc("Font weight of note and multiline content in the managed Markdown file.").addSlider(slider => slider
      .setLimits(100, 900, 100).setValue(syncSettings.childFontWeight).onChange(async value => {
        syncSettings.childFontWeight = value;
        this.plugin.syncCoordinator.applyVisualSettings();
        await this.plugin.saveSettings();
      }));
    new Setting(sync).setName("Sync now").setDesc("Compare the committed Obsidian state with Microsoft To Do now.").addButton(button => button
      .setButtonText("Sync now").setCta().onClick(async () => {
        button.setDisabled(true);
        await this.plugin.syncCoordinator.syncWithNotice();
        button.setDisabled(false);
        this.renderSettings();
      }));
    new Setting(sync).setName("Clear conflict records").setDesc(`Remove ${syncSettings.conflicts.length} retained conflict copies.`).addButton(button => {
      button.setButtonText("Clear all").setDisabled(syncSettings.conflicts.length === 0);
      button.buttonEl.addClass("mod-warning");
      button.onClick(async () => {
          await this.plugin.syncCoordinator.clearConflicts();
          new Notice("Conflict records cleared. They will be removed from the mirror file on the next sync.");
          this.renderSettings();
        });
    });
    }

    const dailyNotes = createGroup("Daily note task moves", "Optionally move tasks from Calm Tasks into today's daily note.");
    new Setting(dailyNotes).setName("Move tasks to daily notes").setDesc("Add a context-menu action that moves tasks into today's daily note.").addToggle(toggle => toggle
      .setValue(this.plugin.settings.moveTasksToDailyNoteEnabled).onChange(async value => {
        this.plugin.settings.moveTasksToDailyNoteEnabled = value;
        await this.plugin.saveSettings();
        this.redisplayPreservingScroll();
      }));
    if (this.plugin.settings.moveTasksToDailyNoteEnabled) {
      const folderSetting = new Setting(dailyNotes).setClass("calm-setting-wide").setName("Daily notes folder").setDesc("Base folder for daily notes. Calm Tasks automatically adds the current YYYY/MM folders and YYYY-MM-DD.md filename.");
      folderSetting.addText(text => {
        const listId = "calm-daily-note-folders";
        text.inputEl.setAttr("list", listId);
        text.setPlaceholder("10 🙂 Life/93 ✉️ Daily note").setValue(this.plugin.settings.dailyNotesFolder).onChange(async value => {
          this.plugin.settings.dailyNotesFolder = normalizeDailyNotesBaseFolder(value);
          await this.plugin.saveSettings();
        });
        const choices = folderSetting.controlEl.createEl("datalist", { attr: { id: listId } });
        this.app.vault.getAllLoadedFiles()
          .filter((file): file is TFolder => file instanceof TFolder && Boolean(file.path)
            && !/\/(?:19|20)\d{2}(?:\/(?:0[1-9]|1[0-2]))?$/u.test(file.path))
          .sort((left, right) => left.path.localeCompare(right.path))
          .forEach(folder => choices.createEl("option", { value: folder.path }));
      });
      new Setting(dailyNotes).setClass("calm-setting-wide").setName("Daily note task heading").setDesc("Optional Markdown heading used as the destination section. If it is absent, tasks are appended to the end of the note.").addText(text => text
        .setPlaceholder("# 오늘의 할 일").setValue(this.plugin.settings.dailyNoteTaskHeading).onChange(async value => {
          this.plugin.settings.dailyNoteTaskHeading = value.trim();
          await this.plugin.saveSettings();
        }));
    }
  }

  private redisplayPreservingScroll(): void {
    const scrollContainer = this.containerEl.closest<HTMLElement>(".vertical-tab-content") ?? this.containerEl;
    const scrollTop = scrollContainer.scrollTop;
    this.renderSettings();
    window.requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollTop;
      window.requestAnimationFrame(() => { scrollContainer.scrollTop = scrollTop; });
    });
  }

  private showDeviceCode(container: HTMLElement, code: string, uri: string): void {
    const box = container.createDiv({ cls: "ms-todo-sync-status" });
    box.createDiv({ text: "Enter this code in the Microsoft sign-in page." });
    box.createDiv({ cls: "ms-todo-sync-code", text: code });
    const actions = box.createDiv({ cls: "ms-todo-sync-actions" });
    const open = actions.createEl("button", { text: "Open Microsoft sign-in" });
    open.addEventListener("click", () => window.open(uri));
    const copy = actions.createEl("button", { text: "Copy code" });
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(code);
      new Notice("Sign-in code copied.");
    });
  }
}
