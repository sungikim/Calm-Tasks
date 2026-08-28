import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { TaskStore } from "./task-store";
import { CalmTasksView, VIEW_TYPE_CALM_TASKS } from "./task-view";
import { CalmTasksSettings } from "./types";
import { calmTaskEditorExtension, decorateRenderedTaskMetadata } from "./editor-decorations";

const DEFAULT_SETTINGS: CalmTasksSettings = {
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
  showDetailPanel: true,
  detailPanelPosition: "bottom",
  groups: [],
  groupAssignments: {},
  fileGroupAssignments: {},
  taskOrder: {},
  smartFilters: []
};

export default class CalmTasksPlugin extends Plugin {
  override settings: CalmTasksSettings = DEFAULT_SETTINGS;
  private store!: TaskStore;

  override async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<CalmTasksSettings>);
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
    this.applyMarkdownCompletedStyleSetting();
    this.registerEditorExtension(calmTaskEditorExtension);
    this.registerMarkdownPostProcessor(element => decorateRenderedTaskMetadata(element));
    this.registerView(VIEW_TYPE_CALM_TASKS, leaf => new CalmTasksView(leaf, this.store, () => this.settings, () => this.saveSettings()));
    this.addRibbonIcon("circle-check-big", "Open Calm Tasks", () => void this.activateView());
    this.addCommand({ id: "open-task-workspace", name: "Open task workspace", callback: () => void this.activateView() });
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
  }

  override onunload(): void {
    this.store.stop();
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
    await this.saveData(this.settings);
    if (refreshStore) await this.store.updateSettings(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE_CALM_TASKS).forEach(leaf => {
      if (leaf.view instanceof CalmTasksView) leaf.view.applyAppearanceSettings();
    });
  }
}

class CalmTasksSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CalmTasksPlugin) { super(app, plugin); }

  override display(): void {
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
  }
}
