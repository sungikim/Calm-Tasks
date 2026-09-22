import { App, ItemView, MarkdownRenderer, Menu, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { flattenTasks, parseTasks, taskDate } from "./parser";
import { TaskStore } from "./task-store";
import { CalmTasksSettings, SmartFilter, TaskFilters, TaskGroup, TaskItem, WorkspaceMode } from "./types";
import { normalizePath as normalizeSyncPath, syncMarker } from "./sync/markdown";

export const VIEW_TYPE_CALM_TASKS = "calm-tasks-workspace";
const OPTIONAL_TODO_FILENAME = "🔥 00_To-do.md";

function localDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function readableDate(value: string): string {
  const today = localDate();
  if (value === today) return "Today";
  if (value === addDays(today, 1)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", weekday: "short" }).format(new Date(`${value}T12:00:00`));
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDate(date) === value;
}

function dateVisualState(value: string): "is-past" | "is-today" | "is-soon" | "" {
  const today = localDate();
  if (value < today) return "is-past";
  if (value === today) return "is-today";
  if (value <= addDays(today, 3)) return "is-soon";
  return "";
}

function inlineMetadataOrder(task: TaskItem): Array<"due" | "priority"> {
  const available = new Set<"due" | "priority">();
  if (task.dates.due) available.add("due");
  if (task.priorityLabel) available.add("priority");
  const order = (task.inlineMetadataOrder ?? []).filter((kind, index, items) => available.has(kind) && items.indexOf(kind) === index);
  (["due", "priority"] as const).forEach(kind => { if (available.has(kind) && !order.includes(kind)) order.push(kind); });
  return order;
}

function inlineMetadataState(value: string): { due?: string; priority?: "A" | "B" | "C" | "D" } | undefined {
  const suffix = value.match(/((?:\s*\|\s*[^|]+)+)\s*$/u)?.[1];
  if (!suffix) return {};
  const tokens = suffix.split("|").slice(1).map(token => token.trim()).filter(Boolean);
  if (!tokens.length || tokens.some(token => !isValidIsoDate(token) && !/^[A-D]$/u.test(token))) return undefined;
  const due = tokens.find(isValidIsoDate);
  const priority = tokens.find(token => /^[A-D]$/u.test(token)) as "A" | "B" | "C" | "D" | undefined;
  return { due, priority };
}

function logicalInlineTitle(value: string): string {
  return value.replace(/(?:\s*\|\s*(?:\d{4}-\d{2}-\d{2}|[A-D]))+\s*$/gu, "").trim();
}

const TASK_HTML_COMMENT_RE = /<!--[\s\S]*?-->/gu;

function visibleTaskTitle(value: string): string {
  return value.replace(TASK_HTML_COMMENT_RE, " ").replace(/\s{2,}/gu, " ").trim();
}

function preserveTaskComments(previousTitle: string, nextTitle: string): string {
  const comments = previousTitle.match(TASK_HTML_COMMENT_RE) ?? [];
  if (!comments.length) return nextTitle;
  const inlineSuffix = nextTitle.match(/(?:\s*\|\s*(?:\d{4}-\d{2}-\d{2}|[A-D]))+\s*$/u)?.[0] ?? "";
  const visible = inlineSuffix ? nextTitle.slice(0, -inlineSuffix.length).trim() : nextTitle.trim();
  return `${visible}${visible ? " " : ""}${comments.join(" ")}${inlineSuffix}`.trim();
}

function isHTMLElement(target: EventTarget | Node | null): target is HTMLElement {
  return Boolean(target && typeof (target as Node).instanceOf === "function" && (target as Node).instanceOf(HTMLElement));
}

interface TaskDraft {
  id: string;
  afterTaskKey: string;
  orderScope: string;
  groupId?: string;
  mode: WorkspaceMode;
  due?: string;
  priority?: "A" | "B" | "C" | "D";
  title: string;
}

class ConfirmGroupDeleteModal extends Modal {
  constructor(app: App, private groupName: string, private onConfirm: () => void) { super(app); }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Delete group?" });
    this.contentEl.createEl("p", { text: `Tasks in “${this.groupName}” will move to Inbox. This cannot be undone.` });
    const actions = this.contentEl.createDiv({ cls: "calm-confirm-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const remove = actions.createEl("button", { cls: "mod-warning", text: "Delete group" });
    remove.addEventListener("click", () => { this.close(); this.onConfirm(); });
  }
}

class ConfirmTaskDeleteModal extends Modal {
  constructor(app: App, private count: number, private onConfirm: () => void) { super(app); }

  override onOpen(): void {
    this.modalEl.addClass("calm-task-delete-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: `Delete ${this.count} tasks?` });
    this.contentEl.createEl("p", { text: "The selected tasks will be removed from their source Markdown files. This cannot be undone." });
    const actions = this.contentEl.createDiv({ cls: "calm-confirm-actions" });
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const remove = actions.createEl("button", { cls: "mod-warning", text: `Delete ${this.count} tasks` });
    remove.addEventListener("click", () => { this.close(); this.onConfirm(); });
  }
}

function serializeInlineMarkdown(root: HTMLElement): string {
  const serialize = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!node.instanceOf(HTMLElement)) return "";
    const inner = Array.from(node.childNodes).map(serialize).join("");
    switch (node.tagName) {
      case "STRONG": case "B": return `**${inner}**`;
      case "EM": case "I": return `*${inner}*`;
      case "MARK": return `==${inner}==`;
      case "CODE": return `\`${inner}\``;
      case "BR": return " ";
      case "A": {
        if (node.hasClass("tag")) return node.textContent ?? inner;
        const href = node.getAttribute("data-href") ?? node.getAttribute("href") ?? "";
        if (node.hasClass("internal-link")) return inner === href ? `[[${href}]]` : `[[${href}|${inner}]]`;
        return href ? `[${inner}](${href})` : inner;
      }
      default: return inner;
    }
  };
  return Array.from(root.childNodes).map(serialize).join("").replace(/\s+/g, " ").trim();
}

function splitInlineMarkdownAtCaret(root: HTMLElement): { before: string; after: string } | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return undefined;
  const caret = selection.getRangeAt(0);
  if (!root.contains(caret.startContainer)) return undefined;

  const serializeRange = (range: Range): string => {
    const holder = createDiv();
    holder.append(range.cloneContents());
    return logicalInlineTitle(serializeInlineMarkdown(holder));
  };
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(caret.startContainer, caret.startOffset);
  const after = document.createRange();
  after.selectNodeContents(root);
  after.setStart(caret.startContainer, caret.startOffset);
  return { before: serializeRange(before), after: serializeRange(after) };
}

function pastedExternalUrl(event: ClipboardEvent): string | undefined {
  const value = event.clipboardData?.getData("text/plain").trim();
  if (!value || /\s/u.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export class CalmTasksView extends ItemView {
  private mode: WorkspaceMode = "agenda";
  private filters: TaskFilters = { status: "open", date: "any", tag: "", query: "" };
  private collapsed = new Set<string>();
  private unsubscribe?: () => void;
  private selectedTask?: { path: string; line: number; key?: string };
  private collapsedGroups = new Set<string>();
  private completedRange: "all" | "3days" | "7days" | "30days" = "all";
  private sessionCompleted = new Set<string>();
  private listScrollTop = 0;
  private renderVersion = 0;
  private selectedKeys = new Set<string>();
  private selectionAnchor?: string;
  private selectionScope?: string;
  private visibleTaskOrder: string[] = [];
  private activeSmartFilterId?: string;
  private focusTaskKey?: string;
  private restoreEditingCaret?: { taskKey: string; offset: number };
  private keyboardTargetKey?: string;
  private keyboardTargetScope?: string;
  private focusFilterField?: "tag" | "query";
  private filterSelectionStart = 0;
  private filterSelectionEnd = 0;
  private editingTaskKey?: string;
  private activeTitleCommit?: (renderAfter?: boolean) => Promise<void>;
  private pendingStoreRender = false;
  private taskMutationsInProgress = 0;
  private detailRenderVersion = 0;
  private taskDraft?: TaskDraft;
  private draftRendered = false;
  private taskDraftMoveInProgress = false;
  private taskDraftCompositionInProgress = false;
  private queuedTaskDraftMove?: -1 | 1;
  private pendingCreatedTasks: TaskItem[] = [];
  private optimisticallyDeletedTaskIds = new Set<string>();
  private draftDetailHidden = false;
  private renderPromise?: Promise<void>;
  private renderRequested = false;
  private taskKeyCache = new Map<string, string>();
  private lastViewShortcutMove?: { direction: -1 | 1; at: number };
  private lastCommandShortcutMove?: { direction: -1 | 1; at: number };
  private filterCompositionInProgress = false;
  private filterSearchTimer?: number;
  private completionArchiveTimer?: number;
  private completionArchiveBoundary?: number;
  private uiRevision = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private store: TaskStore,
    private getSettings: () => CalmTasksSettings,
    private saveSettings: () => Promise<void>
  ) { super(leaf); }

  getViewType(): string { return VIEW_TYPE_CALM_TASKS; }
  getDisplayText(): string { return "Calm Tasks"; }
  override getIcon(): string { return "circle-check-big"; }

  canMoveSelection(): boolean {
    if (this.taskDraft) return Boolean(this.contentEl.querySelector(".calm-task-draft-wrap"));
    return Boolean(this.keyboardTargetKey);
  }

  moveSelection(direction: -1 | 1): void {
    if (this.taskDraft && this.taskDraftCompositionInProgress) {
      this.queuedTaskDraftMove = direction;
      return;
    }
    const now = performance.now();
    if (this.lastViewShortcutMove?.direction === direction && now - this.lastViewShortcutMove.at < 150) return;
    this.lastCommandShortcutMove = { direction, at: now };
    this.captureEditingCaret();
    void this.activeTitleCommit?.(false);
    this.performSelectionMove(direction);
  }

  private moveSelectionFromViewShortcut(direction: -1 | 1): void {
    if (this.taskDraft && this.taskDraftCompositionInProgress) {
      this.queuedTaskDraftMove = direction;
      return;
    }
    const now = performance.now();
    if (this.lastCommandShortcutMove?.direction === direction && now - this.lastCommandShortcutMove.at < 30) return;
    this.lastViewShortcutMove = { direction, at: now };
    this.captureEditingCaret();
    void this.activeTitleCommit?.(false);
    this.performSelectionMove(direction);
  }

  private performSelectionMove(direction: -1 | 1): void {
    if (this.taskDraft) {
      this.moveTaskDraft(direction);
      return;
    }
    const key = this.keyboardTargetKey ?? this.selectionAnchor ?? Array.from(this.selectedKeys)[0];
    if (!key) return;
    const scope = this.keyboardTargetScope ?? this.groupIdForTaskKey(key);
    void this.reorderSelectedByKeyboard(scope, direction, key);
  }

  override async onOpen(): Promise<void> {
    this.unsubscribe = this.store.subscribe(change => {
      if (change === "optimistic") {
        if (this.taskMutationsInProgress > 0) {
          this.pendingStoreRender = true;
          return;
        }
        void this.render();
        return;
      }
      if (this.filterCompositionInProgress) {
        this.pendingStoreRender = true;
        return;
      }
      if (this.editingTaskKey || this.taskMutationsInProgress > 0) {
        this.pendingStoreRender = true;
        return;
      }
      void this.render();
    });
    this.registerDomEvent(window, "keydown", event => {
      const isUp = event.key === "ArrowUp" || event.code === "ArrowUp";
      const isDown = event.key === "ArrowDown" || event.code === "ArrowDown";
      if (!event.ctrlKey || !event.metaKey || (!isUp && !isDown)) return;
      if (this.app.workspace.getActiveViewOfType(CalmTasksView) !== this || !this.canMoveSelection()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const direction = isUp ? -1 : 1;
      if (this.taskDraft && (this.taskDraftCompositionInProgress || event.isComposing)) {
        this.taskDraftCompositionInProgress = true;
        this.queuedTaskDraftMove = direction;
        return;
      }
      this.moveSelectionFromViewShortcut(direction);
    }, { capture: true });
    this.registerDomEvent(window, "keydown", event => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (this.app.workspace.getActiveViewOfType(CalmTasksView) !== this || this.selectedKeys.size < 2) return;
      if (!isHTMLElement(event.target) || !this.contentEl.contains(event.target)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      if (event.target.closest("input, textarea, select, .calm-detail")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.requestDeleteTaskKeys(Array.from(this.selectedKeys));
    }, { capture: true });
    this.registerDomEvent(this.contentEl, "pointerdown", () => { this.uiRevision += 1; }, { capture: true });
    this.registerDomEvent(this.contentEl, "keydown", () => { this.uiRevision += 1; }, { capture: true });
    this.registerDomEvent(this.contentEl, "input", () => { this.uiRevision += 1; }, { capture: true });
    const dismissFromExternalTarget = (target: EventTarget | null): void => {
      if (!isHTMLElement(target)) return;
      if (target.closest(".calm-task, .calm-detail")) return;
      if (target.closest(".menu, .menu-item, .suggestion-container")) return;
      if (target.closest(".calm-task-delete-modal")) return;
      if (document.querySelector(".calm-task-delete-modal") && target.closest(".modal-bg")) return;
      this.dismissTaskFocus();
    };
    this.registerDomEvent(document, "pointerdown", event => dismissFromExternalTarget(event.target), { capture: true });
    this.registerDomEvent(document, "focusin", event => dismissFromExternalTarget(event.target), { capture: true });
    this.registerDomEvent(window, "focus", () => this.checkCompletionArchive());
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.checkCompletionArchive();
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      if (leaf === this.leaf) this.checkCompletionArchive();
    }));
    this.initializeCompletionArchive();
    await this.render();
  }

  override async onClose(): Promise<void> {
    this.unsubscribe?.();
    if (this.filterSearchTimer) window.clearTimeout(this.filterSearchTimer);
    if (this.completionArchiveTimer) window.clearTimeout(this.completionArchiveTimer);
  }

  applyAppearanceSettings(): void {
    const root = this.contentEl;
    root.setCssProps({
      "--calm-task-spacing": `${this.getSettings().taskSpacingPx}px`,
      "--calm-task-line-height": `${this.getSettings().taskLineHeightPx}px`,
      "--calm-subtask-circle-opacity": String(this.getSettings().subtaskCircleOpacityPercent / 100)
    });
  }

  setDetailPanelEnabled(enabled: boolean): void {
    if (!enabled) this.clearTaskSelection();
    void this.render();
  }

  setDetailPanelPosition(): void { void this.render(); }

  refreshWorkspace(): void { void this.render(); }

  applyCompletionArchiveSettings(): void {
    if (this.completionArchiveTimer) window.clearTimeout(this.completionArchiveTimer);
    this.completionArchiveTimer = undefined;
    if (!this.getSettings().dailyCompletionArchiveEnabled) {
      this.completionArchiveBoundary = undefined;
      return;
    }
    this.checkCompletionArchive();
  }

  private archiveTimeParts(): [number, number] {
    const match = this.getSettings().dailyCompletionArchiveTime.match(/^(\d{2}):(\d{2})$/u);
    if (!match) return [4, 0];
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59 ? [hours, minutes] : [4, 0];
  }

  private latestCompletionArchiveBoundary(now = new Date()): number {
    const [hours, minutes] = this.archiveTimeParts();
    const boundary = new Date(now);
    boundary.setHours(hours, minutes, 0, 0);
    if (now.getTime() < boundary.getTime()) boundary.setDate(boundary.getDate() - 1);
    return boundary.getTime();
  }

  private nextCompletionArchiveBoundary(now = new Date()): number {
    const [hours, minutes] = this.archiveTimeParts();
    const boundary = new Date(now);
    boundary.setHours(hours, minutes, 0, 0);
    if (now.getTime() >= boundary.getTime()) boundary.setDate(boundary.getDate() + 1);
    return boundary.getTime();
  }

  private initializeCompletionArchive(): void {
    if (!this.getSettings().dailyCompletionArchiveEnabled) return;
    this.completionArchiveBoundary = this.latestCompletionArchiveBoundary();
    this.scheduleCompletionArchive();
  }

  private checkCompletionArchive(): void {
    if (!this.getSettings().dailyCompletionArchiveEnabled) return;
    const latestBoundary = this.latestCompletionArchiveBoundary();
    if (this.completionArchiveBoundary === undefined) {
      this.completionArchiveBoundary = latestBoundary;
    } else if (latestBoundary !== this.completionArchiveBoundary) {
      this.completionArchiveBoundary = latestBoundary;
      if (this.sessionCompleted.size > 0) {
        this.sessionCompleted.clear();
        void this.render();
      }
    }
    this.scheduleCompletionArchive();
  }

  private scheduleCompletionArchive(): void {
    if (this.completionArchiveTimer) window.clearTimeout(this.completionArchiveTimer);
    if (!this.getSettings().dailyCompletionArchiveEnabled) {
      this.completionArchiveTimer = undefined;
      return;
    }
    const delay = Math.max(250, this.nextCompletionArchiveBoundary() - Date.now() + 100);
    this.completionArchiveTimer = window.setTimeout(() => {
      this.completionArchiveTimer = undefined;
      this.checkCompletionArchive();
    }, delay);
  }

  private clearTaskSelection(): void {
    this.uiRevision += 1;
    this.selectedTask = undefined;
    this.selectedKeys.clear();
    this.selectionAnchor = undefined;
    this.selectionScope = undefined;
    this.keyboardTargetKey = undefined;
    this.keyboardTargetScope = undefined;
  }

  private dismissTaskFocus(): void {
    if (!this.selectedTask && this.selectedKeys.size === 0) return;
    this.clearTaskSelection();
    this.syncSelectionClasses();
    void this.refreshDetailPanel();
  }

  private async refreshDetailPanel(): Promise<void> {
    const workspace = this.contentEl.querySelector<HTMLElement>(".calm-workspace");
    const detail = workspace?.querySelector<HTMLElement>(".calm-detail");
    if (!workspace || !detail) return;
    const selected = this.findSelectedTask();
    if (this.selectedTask && !selected) {
      this.clearTaskSelection();
      this.syncSelectionClasses();
    }
    const visible = this.getSettings().showDetailPanel && Boolean(selected || (this.taskDraft && !this.draftDetailHidden));
    workspace.toggleClass("has-selection", visible);
    if (!visible) {
      this.detailRenderVersion += 1;
      detail.empty();
      return;
    }
    await this.renderDetailInto(detail);
  }

  private async renderDetailInto(target: HTMLElement): Promise<void> {
    const version = ++this.detailRenderVersion;
    const staging = createDiv();
    await this.renderDetail(staging);
    if (version !== this.detailRenderVersion) return;
    target.replaceChildren(...Array.from(staging.childNodes));
    this.alignTaskControlsToFirstLine(target);
    window.requestAnimationFrame(() => {
      if (version === this.detailRenderVersion && target.isConnected) this.alignTaskControlsToFirstLine(target);
    });
  }

  private render(): Promise<void> {
    this.renderRequested = true;
    this.renderPromise ??= this.flushRenders();
    return this.renderPromise;
  }

  private async flushRenders(): Promise<void> {
    try {
      while (this.renderRequested) {
        this.renderRequested = false;
        await this.performRender();
      }
    } finally {
      this.renderPromise = undefined;
    }
  }

  private async performRender(): Promise<void> {
    const root = this.contentEl;
    const previousList = root.querySelector<HTMLElement>(".calm-list-pane");
    if (previousList) this.listScrollTop = previousList.scrollTop;
    const version = ++this.renderVersion;
    const uiRevision = this.uiRevision;
    this.rebuildTaskKeyCache();
    this.draftRendered = false;
    const staging = createDiv();
    this.renderToolbar(staging);
    await this.renderListView(staging);
    if (version !== this.renderVersion) return;
    if (uiRevision !== this.uiRevision) {
      window.setTimeout(() => void this.render(), 0);
      return;
    }
    root.replaceChildren(...Array.from(staging.childNodes));
    root.addClass("calm-tasks");
    this.applyAppearanceSettings();
    this.alignTaskControlsToFirstLine(root);
    if (this.focusFilterField) {
      const field = root.querySelector<HTMLInputElement>(`input[data-filter-field="${this.focusFilterField}"]`);
      field?.focus({ preventScroll: true });
      field?.setSelectionRange(this.filterSelectionStart, this.filterSelectionEnd);
      this.focusFilterField = undefined;
    }
    window.requestAnimationFrame(() => {
      if (version !== this.renderVersion) return;
      this.alignTaskControlsToFirstLine(root);
      const list = root.querySelector<HTMLElement>(".calm-list-pane");
      if (list) list.scrollTop = this.listScrollTop;
      if (this.focusTaskKey) {
        const focusKey = this.focusTaskKey;
        const row = Array.from(root.querySelectorAll<HTMLElement>(".calm-task")).find(element => element.dataset.taskKey === focusKey);
        const caret = this.restoreEditingCaret?.taskKey === focusKey ? this.restoreEditingCaret : undefined;
        const title = caret ? row?.querySelector<HTMLElement>('.calm-task-title[contenteditable="true"]') : undefined;
        if (title && caret) this.placeCaretAtTextOffset(title, caret.offset);
        else row?.focus({ preventScroll: true });
        this.restoreEditingCaret = undefined;
        this.focusTaskKey = undefined;
      }
    });
  }

  private async renderWorkspaceOnly(): Promise<void> {
    const root = this.contentEl;
    const currentWorkspace = root.querySelector<HTMLElement>(".calm-workspace");
    if (!currentWorkspace) { await this.render(); return; }
    const previousList = currentWorkspace.querySelector<HTMLElement>(".calm-list-pane");
    if (previousList) this.listScrollTop = previousList.scrollTop;
    const version = ++this.renderVersion;
    const uiRevision = this.uiRevision;
    this.rebuildTaskKeyCache();
    this.draftRendered = false;
    const staging = createDiv();
    await this.renderListView(staging);
    if (version !== this.renderVersion || !currentWorkspace.isConnected) return;
    if (uiRevision !== this.uiRevision) {
      window.setTimeout(() => void this.renderWorkspaceOnly(), 0);
      return;
    }
    const nextWorkspace = staging.querySelector<HTMLElement>(".calm-workspace");
    if (!nextWorkspace) return;
    currentWorkspace.replaceWith(nextWorkspace);
    this.alignTaskControlsToFirstLine(nextWorkspace);
    window.requestAnimationFrame(() => {
      if (version !== this.renderVersion) return;
      this.alignTaskControlsToFirstLine(nextWorkspace);
      const list = nextWorkspace.querySelector<HTMLElement>(".calm-list-pane");
      if (list) list.scrollTop = this.listScrollTop;
    });
  }

  private alignTaskControlsToFirstLine(scope: ParentNode = this.contentEl): void {
    const taskRows = scope.instanceOf(HTMLElement) && scope.matches(".calm-task")
      ? [scope]
      : Array.from(scope.querySelectorAll<HTMLElement>(".calm-task"));
    const detailRows = scope.instanceOf(HTMLElement) && scope.matches(".calm-detail-headline")
      ? [scope]
      : Array.from(scope.querySelectorAll<HTMLElement>(".calm-detail-headline"));
    const entries = [...taskRows, ...detailRows].map(row => {
      const checkbox = row.querySelector<HTMLElement>(":scope > .calm-checkbox");
      const circle = checkbox?.querySelector<SVGElement>("svg");
      const title = row.matches(".calm-task")
        ? row.querySelector<HTMLElement>(":scope > .calm-task-content > .calm-task-title")
        : row.querySelector<HTMLElement>(":scope > .calm-detail-title");
      return checkbox && circle && title ? { checkbox, circle, title } : undefined;
    }).filter((entry): entry is { checkbox: HTMLElement; circle: SVGElement; title: HTMLElement } => Boolean(entry));

    // Clear all previous adjustments before measuring, then apply all new
    // values afterward. Keeping DOM writes out of the measurement loop avoids
    // a layout pass for every task in large lists.
    entries.forEach(({ checkbox }) => checkbox.setCssStyles({ transform: "" }));
    const adjustments = entries.map(({ checkbox, circle, title }) => {

      // Measure from the unadjusted control position. A one-character range
      // yields the browser's actual first-line box, including the active font,
      // zoom level and per-row subpixel rounding.
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
      let firstText: Text | undefined;
      let firstOffset = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        const offset = text.search(/\S/u);
        if (offset < 0) continue;
        firstText = node as Text;
        firstOffset = offset;
        break;
      }
      let textRect: DOMRect | undefined;
      if (firstText) {
        const range = document.createRange();
        range.setStart(firstText, firstOffset);
        range.setEnd(firstText, Math.min(firstText.length, firstOffset + 1));
        textRect = range.getClientRects()[0];
      }
      if (!textRect?.height) {
        const bounds = title.getBoundingClientRect();
        const lineHeight = Number.parseFloat(window.getComputedStyle(title).lineHeight) || 15;
        textRect = new DOMRect(bounds.left, bounds.top, bounds.width, lineHeight);
      }
      const circleRect = circle.getBoundingClientRect();
      if (!circleRect.height) return { checkbox, offset: 0 };
      const offset = textRect.top + textRect.height / 2 - (circleRect.top + circleRect.height / 2);
      return { checkbox, offset: Math.round(offset * 4) / 4 };
    });
    adjustments.forEach(({ checkbox, offset: rounded }) => {
      checkbox.setCssStyles({ transform: rounded ? `translateY(${rounded}px)` : "" });
    });
  }

  private renderToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv({ cls: "calm-toolbar" });
    const tabs = toolbar.createDiv({ cls: "calm-tabs", attr: { role: "tablist" } });
    const options: Array<[WorkspaceMode, string, string]> = [
      ["agenda", "calendar-clock", "Agenda"], ["priority", "signal-high", "Priority"], ["all", "list-tree", "All"]
    ];
    options.forEach(([mode, icon, label]) => {
      const button = tabs.createEl("button", { cls: !this.activeSmartFilterId && this.mode === mode ? "is-active" : "", attr: { role: "tab" } });
      setIcon(button.createSpan(), icon);
      button.createSpan({ text: label });
      const activate = (): void => {
        if (!this.activeSmartFilterId && this.mode === mode) return;
        tabs.querySelectorAll<HTMLElement>('button[role="tab"]').forEach(tab => tab.removeClass("is-active"));
        button.addClass("is-active");
        this.activeSmartFilterId = undefined;
        this.mode = mode;
        this.resetFiltersForNavigation();
        void this.render();
      };
      let activatedOnPointer = false;
      button.addEventListener("pointerdown", event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        activatedOnPointer = true;
        activate();
      });
      button.addEventListener("click", () => {
        if (activatedOnPointer) { activatedOnPointer = false; return; }
        activate();
      });
    });
    const smartFilters = this.getSettings().smartFilters;
    if (smartFilters.length) {
      tabs.createDiv({ cls: "calm-tab-separator" });
      smartFilters.forEach(filter => this.renderSmartFilterTab(tabs, filter));
    }
    this.renderFilters(toolbar);
    const refresh = toolbar.createEl("button", { cls: "clickable-icon calm-refresh", attr: { "aria-label": "Refresh tasks" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => {
      // A manually requested refresh ends the temporary "just completed"
      // visibility period. The refreshed task list should respect the active
      // status filter again and hide completed tasks from open views.
      this.sessionCompleted.clear();
      void this.store.refresh();
    });
  }

  private renderFilters(toolbar: HTMLElement): void {
    const bar = toolbar.createDiv({ cls: "calm-filterbar" });
    const locked = Boolean(this.activeSmartFilterId);
    const showPxdTodoFile = this.getSettings().showPxdTodoFile;
    const fileToggle = bar.createEl("button", {
      cls: `calm-file-toggle ${showPxdTodoFile ? "is-active" : ""}`,
      attr: {
        "aria-label": showPxdTodoFile ? "Hide tasks from 🔥 00_To-do" : "Show tasks from 🔥 00_To-do",
        "aria-pressed": String(showPxdTodoFile)
      }
    });
    setIcon(fileToggle.createSpan({ cls: "calm-file-toggle-icon" }), showPxdTodoFile ? "eye" : "eye-off");
    fileToggle.createSpan({ text: "00_To-do" });
    fileToggle.addEventListener("click", () => {
      this.getSettings().showPxdTodoFile = !this.getSettings().showPxdTodoFile;
      void this.render();
      void this.saveSettings().catch(error => new Notice(error instanceof Error ? error.message : "Could not save the file visibility setting."));
    });
    const status = bar.createEl("select", { attr: { "aria-label": "Task status" } });
    [["open", "Open"], ["done", "Completed"], ["all", "All statuses"]].forEach(([value, text]) => status.createEl("option", { value, text }));
    status.value = this.filters.status;
    status.disabled = locked;
    status.addEventListener("change", () => { this.filters.status = status.value as TaskFilters["status"]; this.activeSmartFilterId = undefined; void this.render(); });

    const date = bar.createEl("select", { attr: { "aria-label": "Date filter" } });
    [["any", "Any date"], ["today", "Today"], ["overdue", "Overdue"], ["upcoming", "Upcoming"], ["none", "No date"]].forEach(([value, text]) => date.createEl("option", { value, text }));
    date.value = this.filters.date;
    date.disabled = locked;
    date.addEventListener("change", () => { this.filters.date = date.value as TaskFilters["date"]; this.activeSmartFilterId = undefined; void this.render(); });

    if (this.filters.status === "done") {
      const ranges: Array<["all" | "3days" | "7days" | "30days", string]> = [["3days", "Last 3 days"], ["7days", "Last 7 days"], ["30days", "Last 30 days"], ["all", "All completed"]];
      const completed = bar.createEl("details", { cls: `calm-completed-filter ${locked ? "is-disabled" : ""}` });
      const summary = completed.createEl("summary");
      summary.createSpan({ text: ranges.find(([value]) => value === this.completedRange)?.[1] ?? "All completed" });
      setIcon(summary.createSpan({ cls: "calm-completed-chevron" }), "chevron-down");
      const menu = completed.createDiv({ cls: "calm-completed-menu" });
      ranges.forEach(([value, text]) => {
        const option = menu.createEl("button");
        const check = option.createSpan({ cls: "calm-completed-check" });
        if (value === this.completedRange) setIcon(check, "check");
        option.createSpan({ text });
        option.addEventListener("click", event => {
          event.preventDefault();
          if (locked) return;
          completed.open = false;
          this.completedRange = value;
          this.activeSmartFilterId = undefined;
          void this.render();
        });
      });
      if (locked) summary.addEventListener("click", event => event.preventDefault());
      completed.addEventListener("focusout", event => {
        if (!completed.contains(event.relatedTarget as Node | null)) completed.open = false;
      });
    }

    const query = bar.createEl("input", { type: "search", placeholder: "Keyword", value: this.filters.query, attr: { "aria-label": "Filter by keyword", "data-filter-field": "query" } });
    query.disabled = locked;
    const updateText = (): void => {
      if (this.filterSearchTimer) window.clearTimeout(this.filterSearchTimer);
      this.filterSearchTimer = window.setTimeout(() => {
        this.filterSearchTimer = undefined;
        this.filters.query = query.value.toLowerCase();
        this.activeSmartFilterId = undefined;
        void this.renderWorkspaceOnly();
      }, 200);
    };
    query.addEventListener("compositionstart", () => {
      this.filterCompositionInProgress = true;
      if (this.filterSearchTimer) window.clearTimeout(this.filterSearchTimer);
      this.filterSearchTimer = undefined;
    });
    query.addEventListener("compositionend", () => {
      this.filterCompositionInProgress = false;
      updateText();
      this.pendingStoreRender = false;
    });
    query.addEventListener("input", updateText);
    if (!locked) {
      const save = bar.createEl("button", { cls: "clickable-icon calm-save-filter", attr: { "aria-label": "Save as smart filter" } });
      setIcon(save, "bookmark-plus");
      save.addEventListener("click", () => this.startSaveSmartFilter(bar, save));
    }
  }

  private renderSmartFilterTab(tabs: HTMLElement, filter: SmartFilter): void {
    const shell = tabs.createDiv({ cls: `calm-smart-tab ${this.activeSmartFilterId === filter.id ? "is-active" : ""}` });
    const button = shell.createEl("button", { attr: { role: "tab" } });
    button.createSpan({ text: filter.name });
    button.addEventListener("click", () => {
      this.clearTaskSelection();
      this.activeSmartFilterId = filter.id;
      this.mode = filter.mode;
      this.completedRange = filter.completedRange;
      this.filters = { ...filter.filters };
      this.focusFilterField = undefined;
      void this.render();
    });
    shell.addEventListener("contextmenu", event => {
      event.preventDefault();
      const menu = new Menu();
      menu.addItem(item => item.setTitle("Delete smart filter").setIcon("trash-2").onClick(() => void this.removeSmartFilter(filter.id)));
      menu.showAtMouseEvent(event);
    });
  }

  private startSaveSmartFilter(bar: HTMLElement, button: HTMLElement): void {
    button.remove();
    const input = bar.createEl("input", { cls: "calm-smart-name-input", placeholder: "Filter name" });
    input.focus();
    let submitted = false;
    const submit = (): void => {
      if (submitted) return;
      submitted = true;
      const name = input.value.trim();
      if (!name) { void this.render(); return; }
      const smartFilter: SmartFilter = {
        id: `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        mode: this.mode,
        completedRange: this.completedRange,
        filters: { ...this.filters }
      };
      this.getSettings().smartFilters.push(smartFilter);
      this.activeSmartFilterId = smartFilter.id;
      void this.saveAndRender();
    };
    input.addEventListener("keydown", event => { if (event.key === "Enter") submit(); if (event.key === "Escape") { submitted = true; void this.render(); } });
    input.addEventListener("blur", submit);
  }

  private async removeSmartFilter(id: string): Promise<void> {
    const settings = this.getSettings();
    settings.smartFilters = settings.smartFilters.filter(filter => filter.id !== id);
    if (this.activeSmartFilterId === id) this.activeSmartFilterId = undefined;
    await this.saveAndRender();
  }

  private resetFiltersForNavigation(): void {
    if (this.filterSearchTimer) window.clearTimeout(this.filterSearchTimer);
    this.filterSearchTimer = undefined;
    this.clearTaskSelection();
    this.filters = { status: "open", date: "any", tag: "", query: "" };
    this.completedRange = "all";
    this.focusFilterField = undefined;
    this.filterSelectionStart = 0;
    this.filterSelectionEnd = 0;
  }

  private filteredRoots(): TaskItem[] {
    const today = localDate();
    const upcomingEnd = addDays(today, this.getSettings().upcomingDays);
    const modeMatch = (task: TaskItem): boolean => {
      const date = taskDate(task);
      if (this.mode === "agenda") return Boolean(date);
      return true;
    };
    const filterMatch = (task: TaskItem): boolean => {
      const date = taskDate(task);
      const justCompleted = this.sessionCompleted.has(this.taskGroupKey(task));
      if (this.filters.status !== "all" && task.status !== this.filters.status && !justCompleted) return false;
      if (this.filters.status === "done" && this.completedRange !== "all") {
        const rangeDays = { "3days": 3, "7days": 7, "30days": 30 }[this.completedRange];
        const completedStart = addDays(today, -(rangeDays - 1));
        if (!(task.dates.completed && task.dates.completed >= completedStart && task.dates.completed <= today)) return false;
      }
      if (this.filters.query && !task.title.toLowerCase().includes(this.filters.query)) return false;
      if (this.filters.date === "today" && date !== today) return false;
      if (this.filters.date === "overdue" && !(date && date < today && task.status === "open")) return false;
      if (this.filters.date === "upcoming" && !(date && date > today && date <= upcomingEnd)) return false;
      if (this.filters.date === "none" && date) return false;
      return modeMatch(task) || justCompleted;
    };
    const prune = (task: TaskItem): TaskItem | null => {
      const children = task.children.map(prune).filter((child): child is TaskItem => child !== null);
      if (!filterMatch(task) && children.length === 0) return null;
      return { ...task, children };
    };
    return this.viewRoots().map(prune).filter((task): task is TaskItem => task !== null);
  }

  private viewRoots(): TaskItem[] {
    const roots = [...this.store.roots, ...this.pendingCreatedTasks]
      .filter(task => this.getSettings().showPxdTodoFile || task.path.split("/").at(-1) !== OPTIONAL_TODO_FILENAME);
    if (this.optimisticallyDeletedTaskIds.size === 0) return roots;
    const prune = (task: TaskItem): TaskItem | null => {
      if (this.optimisticallyDeletedTaskIds.has(task.id)) return null;
      const children = task.children.map(prune).filter((child): child is TaskItem => child !== null);
      return children.length === task.children.length ? task : { ...task, children };
    };
    return roots.map(prune).filter((task): task is TaskItem => task !== null);
  }

  private async renderListView(root: HTMLElement): Promise<void> {
    const tasks = this.filteredRoots();
    this.visibleTaskOrder = [];
    if (this.selectedTask && !this.findSelectedTask()) this.clearTaskSelection();
    const showDetail = this.getSettings().showDetailPanel && Boolean(this.findSelectedTask() || (this.taskDraft && !this.draftDetailHidden));
    const bottomDetail = this.getSettings().detailPanelPosition === "bottom";
    const workspace = root.createDiv({ cls: `calm-workspace ${showDetail ? "has-selection" : ""} ${bottomDetail ? "is-detail-bottom" : ""}` });
    const listPane = workspace.createDiv({ cls: "calm-list-pane" });
    listPane.scrollTop = this.listScrollTop;
    listPane.addEventListener("scroll", () => { this.listScrollTop = listPane.scrollTop; }, { passive: true });
    const list = listPane.createDiv({ cls: "calm-list" });
    const detail = workspace.createEl("aside", { cls: "calm-detail" });
    if (!tasks.length && this.mode !== "all") {
      this.renderEmpty(list);
      if (this.getSettings().showDetailPanel) await this.renderDetailInto(detail);
      return;
    }
    if (this.mode === "agenda") await this.renderAgenda(list, tasks);
    else if (this.mode === "priority") await this.renderPriority(list, tasks);
    else await this.renderGroups(list, tasks);
    if (this.getSettings().showDetailPanel) await this.renderDetailInto(detail);
  }

  private async renderAgenda(list: HTMLElement, roots: TaskItem[]): Promise<void> {
    const groups = new Map<string, TaskItem[]>();
    const overdue: TaskItem[] = [];
    const today = localDate();
    flattenTasks(roots).forEach(task => {
      const date = taskDate(task);
      if (!date) return;
      if (date < today) {
        overdue.push({ ...task, children: [] });
        return;
      }
      const group = groups.get(date) ?? [];
      group.push({ ...task, children: [] });
      groups.set(date, group);
    });
    const dates = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
    const sections: Array<{ key: string; label: string; iso?: string; tasks: TaskItem[] }> = [];
    if (overdue.length) {
      overdue.sort((a, b) => (taskDate(b) ?? "").localeCompare(taskDate(a) ?? ""));
      sections.push({ key: "overdue", label: "Overdue", tasks: overdue });
    }
    dates.forEach(date => sections.push({ key: date, label: readableDate(date), iso: date, tasks: groups.get(date) ?? [] }));
    for (const agendaGroup of sections) {
      const section = list.createDiv({ cls: "calm-agenda-section" });
      const header = section.createDiv({ cls: "calm-agenda-heading" });
      header.createSpan({ cls: "calm-agenda-date", text: agendaGroup.label });
      if (agendaGroup.iso) header.createSpan({ cls: "calm-agenda-iso", text: agendaGroup.iso });
      const line = header.createDiv({ cls: "calm-group-line calm-agenda-line" });
      line.setAttribute("aria-hidden", "true");
      const scope = `__agenda__:${agendaGroup.key}`;
      const ordered = this.sortGroupTasks(scope, agendaGroup.tasks);
      this.renderLeadingTaskDraft(section, scope, 0);
      for (const task of ordered) await this.renderTask(section, task, 0, true, scope, false);
    }
  }

  private async renderPriority(list: HTMLElement, roots: TaskItem[]): Promise<void> {
    const definitions: Array<[TaskItem["priorityLabel"], string]> = [["A", "A"], ["B", "B"], ["C", "C"], ["D", "D"], [undefined, "None"]];
    const tasks = flattenTasks(roots).map(task => ({ ...task, children: [] }));
    for (const [priority, label] of definitions) {
      const groupId = `__priority_${priority ?? "none"}__`;
      const grouped = tasks.filter(task => task.priorityLabel === priority);
      if (!grouped.length) continue;
      const section = list.createDiv({ cls: `calm-group calm-priority-group ${this.collapsedGroups.has(groupId) ? "is-collapsed" : ""}` });
      const heading = section.createDiv({ cls: `calm-group-heading calm-priority-heading is-${priority?.toLowerCase() ?? "none"}` });
      const toggle = heading.createEl("button", { cls: "calm-group-toggle", attr: { "aria-label": `Toggle ${label} priority` } });
      setIcon(toggle, this.collapsedGroups.has(groupId) ? "chevron-right" : "chevron-down");
      heading.createDiv({ cls: "calm-group-title", text: label });
      heading.createDiv({ cls: "calm-group-line" });
      heading.createSpan({ cls: "calm-group-count", text: String(grouped.length) });
      toggle.addEventListener("click", event => {
        event.stopPropagation();
        if (this.collapsedGroups.has(groupId)) this.collapsedGroups.delete(groupId); else this.collapsedGroups.add(groupId);
        void this.render();
      });
      if (this.collapsedGroups.has(groupId)) continue;
      const body = section.createDiv({ cls: "calm-group-body", attr: { "data-order-scope": groupId } });
      const ordered = this.sortGroupTasks(groupId, grouped);
      this.renderLeadingTaskDraft(body, groupId, 0);
      for (const task of ordered) await this.renderTask(body, task, 0, true, groupId, false);
    }
  }

  private taskBaseKey(task: TaskItem): string { return `${task.path}::${task.title.trim().toLocaleLowerCase()}`; }

  private taskSyncKey(task: TaskItem): string | undefined {
    const markers = Array.from((task.rawLine || task.title).matchAll(/<!--\s*mst:([a-z0-9]+)\s*-->/giu));
    const marker = markers[markers.length - 1]?.[1];
    return marker ? `mst:${marker.toLocaleLowerCase()}` : undefined;
  }

  private taskIdentityKey(task: TaskItem): string { return `${task.path}\u0000${task.line}\u0000${task.title}`; }

  private rebuildTaskKeyCache(): void {
    const tasks = flattenTasks(this.viewRoots());
    const groups = new Map<string, TaskItem[]>();
    tasks.forEach(task => {
      const base = this.taskBaseKey(task);
      const matches = groups.get(base) ?? [];
      matches.push(task);
      groups.set(base, matches);
    });
    const cache = new Map<string, string>();
    groups.forEach((matches, base) => {
      matches.forEach((task, index) => cache.set(this.taskIdentityKey(task), matches.length < 2 ? base : `${base}::duplicate:${index + 1}`));
    });
    this.taskKeyCache = cache;

    const settings = this.getSettings();
    let migrated = false;
    tasks.forEach(task => {
      const stableKey = this.taskSyncKey(task);
      if (!stableKey) return;
      const marker = stableKey.slice(4);
      const cachedKey = cache.get(this.taskIdentityKey(task));
      const legacyKeys = Object.keys(settings.groupAssignments).filter(key =>
        key === cachedKey || key === this.taskBaseKey(task) || key.toLocaleLowerCase().includes(`<!-- mst:${marker} -->`)
      );
      if (settings.groupAssignments[stableKey] === undefined) {
        const legacyKey = legacyKeys.find(key => settings.groupAssignments[key] !== undefined);
        if (legacyKey) {
          settings.groupAssignments[stableKey] = settings.groupAssignments[legacyKey] as string;
          migrated = true;
        }
      }
      Object.values(settings.taskOrder).forEach(order => {
        const legacyIndexes = order
          .map((key, index) => legacyKeys.includes(key) ? index : -1)
          .filter(index => index >= 0);
        if (!legacyIndexes.length || order.includes(stableKey)) return;
        order[legacyIndexes[0] as number] = stableKey;
        migrated = true;
      });
    });
    if (migrated) void this.saveSettings().catch(error =>
      new Notice(error instanceof Error ? error.message : "Could not migrate Microsoft To Do task placement."));
  }

  private taskGroupKey(task: TaskItem): string {
    const syncKey = this.taskSyncKey(task);
    if (syncKey) return syncKey;
    const identity = this.taskIdentityKey(task);
    let key = this.taskKeyCache.get(identity);
    if (!key) {
      this.rebuildTaskKeyCache();
      key = this.taskKeyCache.get(identity);
    }
    return key ?? this.taskBaseKey(task);
  }

  private dailyNoteDate(path: string): string | undefined {
    return path.split("/").pop()?.match(/^(\d{4}-\d{2}-\d{2})\.md$/u)?.[1];
  }

  private dailyPlacementKeyInfo(key: string): { path: string; date: string; title: string } | undefined {
    const base = key.replace(/::duplicate:\d+$/u, "");
    const separator = base.lastIndexOf(".md::");
    if (separator < 0) return undefined;
    const path = base.slice(0, separator + 3);
    const date = this.dailyNoteDate(path);
    if (!date) return undefined;
    return { path, date, title: base.slice(separator + 5) };
  }

  private dailyPlacementFallbackKeys(task: TaskItem, candidates: string[]): string[] {
    if (!this.getSettings().preserveDailyNoteTaskPlacement) return [];
    const currentDate = this.dailyNoteDate(task.path);
    if (!currentDate) return [];
    const title = task.title.trim().toLocaleLowerCase();
    const existing = flattenTasks(this.store.roots);
    return candidates.map(key => ({ key, info: this.dailyPlacementKeyInfo(key) }))
      .filter((candidate): candidate is { key: string; info: { path: string; date: string; title: string } } => Boolean(candidate.info))
      .filter(({ info }) => info.path !== task.path && info.date !== currentDate && info.title === title)
      .filter(({ info }) => !existing.some(item => item.path === info.path && item.title.trim().toLocaleLowerCase() === title))
      .sort((a, b) => {
        const aDistance = Math.abs(new Date(`${a.info.date}T12:00:00`).getTime() - new Date(`${currentDate}T12:00:00`).getTime());
        const bDistance = Math.abs(new Date(`${b.info.date}T12:00:00`).getTime() - new Date(`${currentDate}T12:00:00`).getTime());
        return aDistance - bDistance || b.info.date.localeCompare(a.info.date);
      })
      .map(({ key }) => key);
  }

  private assignedGroupId(task: TaskItem): string | undefined {
    const settings = this.getSettings();
    const valid = new Set(settings.groups.map(group => group.id));
    const placementKeys = [
      this.taskGroupKey(task),
      this.taskBaseKey(task),
      ...this.dailyPlacementFallbackKeys(task, Object.keys(settings.groupAssignments))
    ];
    const explicit = placementKeys.map(key => settings.groupAssignments[key]).find(value => value !== undefined);
    if (explicit === "__inbox__") return undefined;
    if (explicit && valid.has(explicit)) return explicit;
    const byFile = settings.fileGroupAssignments[task.path];
    return byFile && valid.has(byFile) ? byFile : undefined;
  }

  private async renderGroups(list: HTMLElement, tasks: TaskItem[]): Promise<void> {
    const settings = this.getSettings();
    const inboxTasks = tasks.filter(task => !this.assignedGroupId(task));
    if (inboxTasks.length || this.mode === "all") await this.renderTaskGroup(list, undefined, inboxTasks);
    for (const group of settings.groups) {
      const grouped = tasks.filter(task => this.assignedGroupId(task) === group.id);
      if (grouped.length || this.mode === "all") await this.renderTaskGroup(list, group, grouped);
    }
    if (this.mode === "all") this.renderAddGroup(list);
  }

  private async renderTaskGroup(list: HTMLElement, group: TaskGroup | undefined, tasks: TaskItem[]): Promise<void> {
    const groupId = group?.id ?? "__inbox__";
    const orderedTasks = this.sortGroupTasks(groupId, tasks);
    const section = list.createDiv({ cls: `calm-group ${this.collapsedGroups.has(groupId) ? "is-collapsed" : ""}`, attr: { "data-group-id": groupId } });
    const heading = section.createDiv({ cls: `calm-group-heading ${group ? "has-remove" : ""}` });
    const toggle = heading.createEl("button", { cls: "calm-group-toggle", attr: { "aria-label": "Toggle group" } });
    setIcon(toggle, this.collapsedGroups.has(groupId) ? "chevron-right" : "chevron-down");
    const title = heading.createDiv({ cls: "calm-group-title", text: group?.name ?? "Inbox" });
    if (group) title.addEventListener("dblclick", event => { event.stopPropagation(); this.startGroupRename(group, title); });
    title.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      this.showGroupContextMenu(event, group, title);
    });
    heading.createDiv({ cls: "calm-group-line" });
    heading.createSpan({ cls: "calm-group-count", text: String(orderedTasks.length) });
    if (group) {
      const remove = heading.createEl("button", { cls: "calm-group-remove", attr: { "aria-label": `Delete ${group.name}` } });
      setIcon(remove, "x");
      remove.addEventListener("click", event => {
        event.stopPropagation();
        new ConfirmGroupDeleteModal(this.app, group.name, () => void this.removeGroup(group.id)).open();
      });
      this.enableGroupDrag(group, section, heading);
    }
    const toggleGroup = (): void => {
      if (this.collapsedGroups.has(groupId)) this.collapsedGroups.delete(groupId); else this.collapsedGroups.add(groupId);
      void this.render();
    };
    toggle.addEventListener("click", event => { event.stopPropagation(); toggleGroup(); });
    heading.addEventListener("dragover", event => { event.preventDefault(); section.addClass("is-drag-over"); });
    heading.addEventListener("dragleave", () => section.removeClass("is-drag-over"));
    heading.addEventListener("drop", event => { event.preventDefault(); section.removeClass("is-drag-over"); void this.moveDroppedTasks(event, groupId); });

    if (!this.collapsedGroups.has(groupId)) {
      const body = section.createDiv({ cls: "calm-group-body", attr: { "data-order-scope": groupId } });
      if (!orderedTasks.length && this.taskDraft?.orderScope !== groupId) this.renderEmptyGroupPlaceholder(body, groupId);
      this.renderLeadingTaskDraft(body, groupId, 0);
      for (const task of orderedTasks) await this.renderTask(body, task, 0, true, groupId, true);
      body.addEventListener("dragover", event => { event.preventDefault(); section.addClass("is-drag-over"); });
      body.addEventListener("dragleave", event => { if (!section.contains(event.relatedTarget as Node | null)) section.removeClass("is-drag-over"); });
      body.addEventListener("drop", event => { event.preventDefault(); section.removeClass("is-drag-over"); void this.moveDroppedTasks(event, groupId); });
    }
  }

  private renderAddGroup(list: HTMLElement): void {
    const footer = list.createDiv({ cls: "calm-add-group" });
    const button = footer.createEl("button", { cls: "calm-add-group-button" });
    setIcon(button.createSpan(), "plus");
    button.createSpan({ text: "Add group" });
    button.addEventListener("click", () => {
      footer.empty();
      const input = footer.createEl("input", { cls: "calm-add-group-input", placeholder: "Group name" });
      input.focus();
      let submitted = false;
      const submit = (): void => {
        if (submitted) return;
        submitted = true;
        const name = input.value.trim();
        if (!name) { void this.render(); return; }
        const settings = this.getSettings();
        settings.groups.push({ id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name });
        void this.saveAndRender();
      };
      input.addEventListener("keydown", event => { if (event.key === "Enter") submit(); if (event.key === "Escape") { submitted = true; void this.render(); } });
      input.addEventListener("blur", submit);
    });
  }

  private showGroupContextMenu(event: MouseEvent, group: TaskGroup | undefined, title: HTMLElement): void {
    const menu = new Menu();
    if (group) {
      const groups = this.getSettings().groups;
      const index = groups.findIndex(candidate => candidate.id === group.id);
      menu.addItem(item => item.setTitle("Rename").setIcon("pencil").onClick(() => this.startGroupRename(group, title)));
      menu.addItem(item => item.setTitle("Move up").setIcon("arrow-up").setDisabled(index <= 0)
        .onClick(() => void this.moveGroupByOffset(group.id, -1)));
      menu.addItem(item => item.setTitle("Move down").setIcon("arrow-down").setDisabled(index < 0 || index >= groups.length - 1)
        .onClick(() => void this.moveGroupByOffset(group.id, 1)));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("Delete").setIcon("trash-2").onClick(() => {
        new ConfirmGroupDeleteModal(this.app, group.name, () => void this.removeGroup(group.id)).open();
      }));
      menu.addSeparator();
    }
    menu.addItem(item => item.setTitle("Collapse all").setIcon("chevrons-up").onClick(() => this.setAllGroupsCollapsed(true)));
    menu.addItem(item => item.setTitle("Expand all").setIcon("chevrons-down").onClick(() => this.setAllGroupsCollapsed(false)));
    menu.showAtMouseEvent(event);
  }

  private moveGroupByOffset(groupId: string, direction: -1 | 1): void {
    const groups = this.getSettings().groups;
    const index = groups.findIndex(group => group.id === groupId);
    const target = groups[index + direction];
    if (index < 0 || !target) return;
    void this.moveGroup(groupId, target.id, direction > 0);
  }

  private setAllGroupsCollapsed(collapsed: boolean): void {
    const ids = ["__inbox__", ...this.getSettings().groups.map(group => group.id)];
    ids.forEach(id => {
      if (collapsed) this.collapsedGroups.add(id);
      else this.collapsedGroups.delete(id);
    });
    void this.render();
  }

  private startGroupRename(group: TaskGroup, title: HTMLElement): void {
    title.empty();
    const input = title.createEl("input", { cls: "calm-group-name-input", value: group.name });
    const resize = (): void => {
      const measure = title.createSpan({ cls: "calm-group-name-measure", text: input.value || " " });
      const available = Math.max(24, (title.closest<HTMLElement>(".calm-group-heading")?.clientWidth ?? this.contentEl.clientWidth) - 80);
      const width = Math.min(available, Math.max(8, Math.ceil(measure.getBoundingClientRect().width) + 2));
      measure.remove();
      input.style.setProperty("width", `${width}px`, "important");
    };
    resize();
    input.focus(); input.select();
    let saved = false;
    const save = (): void => {
      if (saved) return;
      saved = true;
      const next = input.value.trim();
      if (next) group.name = next;
      void this.saveAndRender();
    };
    input.addEventListener("input", resize);
    input.addEventListener("keydown", event => { if (event.key === "Enter") save(); if (event.key === "Escape") { saved = true; void this.render(); } });
    input.addEventListener("blur", save);
  }

  private async removeGroup(groupId: string): Promise<void> {
    const settings = this.getSettings();
    settings.groups = settings.groups.filter(group => group.id !== groupId);
    Object.entries(settings.groupAssignments).forEach(([key, value]) => {
      if (value === groupId) settings.groupAssignments[key] = "__inbox__";
    });
    Object.entries(settings.fileGroupAssignments).forEach(([path, value]) => { if (value === groupId) delete settings.fileGroupAssignments[path]; });
    const removedOrder = settings.taskOrder[groupId] ?? [];
    const inboxOrder = settings.taskOrder.__inbox__ ?? [];
    settings.taskOrder.__inbox__ = [...inboxOrder, ...removedOrder.filter(key => !inboxOrder.includes(key))];
    delete settings.taskOrder[groupId];
    await this.saveAndRender();
  }

  private enableGroupDrag(group: TaskGroup, section: HTMLElement, heading: HTMLElement): void {
    heading.addEventListener("pointerdown", event => {
      if (event.button !== 0 || (isHTMLElement(event.target) && event.target.closest("button, input, a"))) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const sourceRect = heading.getBoundingClientRect();
      let dragging = false;
      let overlay: HTMLElement | null = null;
      let targetId: string | undefined;
      let insertAfter = false;

      const clearTarget = (): void => {
        this.contentEl.querySelectorAll<HTMLElement>(".calm-group.is-group-drop-before, .calm-group.is-group-drop-after")
          .forEach(candidate => candidate.removeClass("is-group-drop-before", "is-group-drop-after"));
        targetId = undefined;
      };
      const removeOverlay = (): void => {
        overlay?.remove();
        overlay = null;
        section.removeClass("is-group-dragging");
        document.body.removeClass("calm-drag-active");
      };
      const positionOverlay = (clientY: number): void => {
        if (!overlay) return;
        const width = overlay.getBoundingClientRect().width;
        const height = overlay.getBoundingClientRect().height;
        const left = Math.max(8, Math.min(sourceRect.left, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(clientY + 12, window.innerHeight - height - 8));
        overlay.setCssStyles({ transform: `translate3d(${left}px, ${top}px, 0)` });
      };
      const updateTarget = (pointer: PointerEvent): void => {
        clearTarget();
        const pane = heading.closest<HTMLElement>(".calm-list-pane");
        const paneRect = pane?.getBoundingClientRect();
        if (!paneRect || pointer.clientX < paneRect.left || pointer.clientX > paneRect.right || pointer.clientY < paneRect.top || pointer.clientY > paneRect.bottom) return;
        const candidates = Array.from(this.contentEl.querySelectorAll<HTMLElement>('.calm-group[data-group-id]:not([data-group-id="__inbox__"])'))
          .filter(candidate => candidate.dataset.groupId !== group.id && !candidate.hasClass("is-group-dragging"));
        if (!candidates.length) return;
        const before = candidates.find(candidate => {
          const rect = candidate.getBoundingClientRect();
          return pointer.clientY < rect.top + rect.height / 2;
        });
        const target = before ?? candidates[candidates.length - 1];
        if (!target?.dataset.groupId) return;
        targetId = target.dataset.groupId;
        insertAfter = !before;
        target.addClass(insertAfter ? "is-group-drop-after" : "is-group-drop-before");
      };
      const activate = (clientY: number): void => {
        if (dragging) return;
        dragging = true;
        window.getSelection()?.removeAllRanges();
        section.addClass("is-group-dragging");
        document.body.addClass("calm-drag-active");
        overlay = heading.cloneNode(true) as HTMLElement;
        overlay.removeClass("has-remove");
        overlay.addClass("calm-group-drag-overlay");
        overlay.querySelectorAll<HTMLElement>("button").forEach(button => button.remove());
        overlay.setCssStyles({ width: `${sourceRect.width}px` });
        document.body.appendChild(overlay);
        positionOverlay(clientY);
      };
      const holdTimer = window.setTimeout(() => activate(startY), 300);
      const move = (pointer: PointerEvent): void => {
        if (!dragging && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) >= 5) {
          window.clearTimeout(holdTimer);
          activate(pointer.clientY);
        }
        if (!dragging) return;
        pointer.preventDefault();
        positionOverlay(pointer.clientY);
        updateTarget(pointer);
      };
      const finish = (pointer: PointerEvent): void => {
        window.clearTimeout(holdTimer);
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", cancel, true);
        if (dragging) {
          pointer.preventDefault();
          pointer.stopPropagation();
          const destination = targetId;
          clearTarget();
          removeOverlay();
          if (destination) void this.moveGroup(group.id, destination, insertAfter);
        }
      };
      const cancel = (): void => {
        window.clearTimeout(holdTimer);
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", cancel, true);
        clearTarget();
        removeOverlay();
      };
      window.addEventListener("pointermove", move, { capture: true, passive: false });
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", cancel, true);
    });
  }

  private async moveGroup(groupId: string, targetId: string, after: boolean): Promise<void> {
    if (groupId === targetId) return;
    const groups = this.getSettings().groups;
    const previousGroups = groups.map(group => ({ ...group }));
    const sourceIndex = groups.findIndex(group => group.id === groupId);
    if (sourceIndex < 0) return;
    const [moving] = groups.splice(sourceIndex, 1);
    if (!moving) return;
    let targetIndex = groups.findIndex(group => group.id === targetId);
    if (targetIndex < 0) { groups.splice(sourceIndex, 0, moving); return; }
    if (after) targetIndex += 1;
    groups.splice(targetIndex, 0, moving);
    const sections = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-group[data-group-id]"));
    const movingSection = sections.find(section => section.dataset.groupId === groupId);
    const targetSection = sections.find(section => section.dataset.groupId === targetId);
    if (movingSection && targetSection) {
      if (after) targetSection.after(movingSection); else targetSection.before(movingSection);
      window.requestAnimationFrame(() => {
        if (movingSection.isConnected) movingSection.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    } else {
      await this.render();
    }
    try {
      await this.saveSettings();
    } catch (error) {
      this.getSettings().groups = previousGroups;
      new Notice(error instanceof Error ? error.message : "Could not save group ordering.");
      await this.render();
    }
  }

  private sortGroupTasks(groupId: string, tasks: TaskItem[]): TaskItem[] {
    const stored = this.getSettings().taskOrder[groupId] ?? [];
    const positions = new Map(stored.map((key, index) => [key, index]));
    const position = (task: TaskItem): number | undefined => {
      const keys = [this.taskGroupKey(task), this.taskBaseKey(task), ...this.dailyPlacementFallbackKeys(task, stored)];
      for (const key of keys) {
        const value = positions.get(key);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    return [...tasks].sort((a, b) => {
      const aPosition = position(a);
      const bPosition = position(b);
      if (aPosition !== undefined && bPosition !== undefined) return aPosition - bPosition;
      if (aPosition !== undefined) return -1;
      if (bPosition !== undefined) return 1;
      return 0;
    });
  }

  private draggedKeys(event: DragEvent): string[] {
    const encoded = event.dataTransfer?.getData("application/x-calm-tasks");
    if (encoded) {
      try {
        const parsed = JSON.parse(encoded) as unknown;
        if (Array.isArray(parsed)) return parsed.filter((key): key is string => typeof key === "string");
      } catch { /* Fall through to the legacy single-task payload. */ }
    }
    const single = event.dataTransfer?.getData("application/x-calm-task");
    return single ? [single] : [];
  }

  private rootTasksForGroup(groupId: string): TaskItem[] {
    return this.viewRoots().filter(task => groupId === "__inbox__" ? !this.assignedGroupId(task) : this.assignedGroupId(task) === groupId);
  }

  private tasksForOrderScope(scopeId: string): TaskItem[] {
    if (scopeId.startsWith("__agenda__:")) {
      const date = scopeId.slice("__agenda__:".length);
      if (date === "overdue") {
        return flattenTasks(this.viewRoots()).filter(task => {
          const value = taskDate(task);
          return Boolean(value && value < localDate());
        });
      }
      return flattenTasks(this.viewRoots()).filter(task => taskDate(task) === date);
    }
    if (scopeId.startsWith("__priority_")) {
      const priority = scopeId.slice("__priority_".length).replace(/__$/u, "").toLowerCase();
      return flattenTasks(this.viewRoots()).filter(task => (task.priorityLabel?.toLowerCase() ?? "none") === priority);
    }
    if (!scopeId.startsWith("__children__:")) return this.rootTasksForGroup(scopeId);
    const parentKey = scopeId.slice("__children__:".length);
    const parent = flattenTasks(this.viewRoots()).find(task => this.taskGroupKey(task) === parentKey);
    return parent?.children ?? [];
  }

  private groupIdForTaskKey(key: string): string {
    const task = flattenTasks(this.viewRoots()).find(item => this.taskGroupKey(item) === key);
    if (task) return this.assignedGroupId(task) ?? "__inbox__";
    const assigned = this.getSettings().groupAssignments[key];
    return assigned && this.getSettings().groups.some(group => group.id === assigned) ? assigned : "__inbox__";
  }

  private async moveDroppedTasks(event: DragEvent, groupId: string, targetKey?: string, after = false): Promise<void> {
    event.stopPropagation();
    const keys = this.draggedKeys(event);
    await this.moveTaskKeys(keys, groupId, targetKey, after);
  }

  private async moveTaskKeys(keys: string[], scopeId: string, targetKey?: string, after = false, canChangeGroup = true): Promise<void> {
    if (!keys.length) return;
    if (targetKey && keys.includes(targetKey)) return;
    const settings = this.getSettings();
    const previousTaskOrder = Object.fromEntries(Object.entries(settings.taskOrder).map(([scope, order]) => [scope, [...order]]));
    const previousAssignments = { ...settings.groupAssignments };
    const visibleKeyOrder = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-task-key]"))
      .map(row => row.dataset.taskKey).filter((key): key is string => Boolean(key));
    keys = [...keys].sort((a, b) => visibleKeyOrder.indexOf(a) - visibleKeyOrder.indexOf(b));
    const derivedScope = scopeId.startsWith("__agenda__:") || scopeId.startsWith("__priority_");
    const orders = derivedScope ? [settings.taskOrder[scopeId] ?? []] : Object.values(settings.taskOrder);
    orders.forEach(order => keys.forEach(key => {
      let index = order.indexOf(key);
      while (index >= 0) { order.splice(index, 1); index = order.indexOf(key); }
    }));
    if (canChangeGroup) keys.forEach(key => {
      if (scopeId !== "__inbox__") {
        settings.groupAssignments[key] = scopeId;
        return;
      }
      const task = flattenTasks(this.store.roots).find(item => this.taskGroupKey(item) === key);
      if (task && settings.fileGroupAssignments[task.path]) settings.groupAssignments[key] = "__inbox__";
      else delete settings.groupAssignments[key];
    });
    const destination = this.sortGroupTasks(scopeId, this.tasksForOrderScope(scopeId))
      .map(task => this.taskGroupKey(task)).filter(key => !keys.includes(key));
    let index = targetKey ? destination.indexOf(targetKey) : destination.length;
    if (index < 0) index = destination.length;
    if (after && targetKey) index += 1;
    destination.splice(index, 0, ...keys);
    settings.taskOrder[scopeId] = destination;
    if (!this.applyTaskMoveToDom(keys, scopeId, destination)) await this.render();
    try {
      await this.saveSettings();
    } catch (error) {
      settings.taskOrder = previousTaskOrder;
      settings.groupAssignments = previousAssignments;
      new Notice(error instanceof Error ? error.message : "Could not move the task.");
      await this.render();
    }
  }

  private applyTaskMoveToDom(keys: string[], scopeId: string, destinationOrder: string[]): boolean {
    this.uiRevision += 1;
    const rows = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-task-key]"));
    const moved = rows.filter(row => Boolean(row.dataset.taskKey && keys.includes(row.dataset.taskKey)))
      .map(row => row.closest<HTMLElement>(".calm-task-wrap"))
      .filter((wrapper): wrapper is HTMLElement => Boolean(wrapper));
    if (!moved.length) return false;
    const targetBody = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-group-body[data-order-scope]"))
      .find(element => element.dataset.orderScope === scopeId);
    const existingDestinationRow = rows.find(row => row.dataset.orderScope === scopeId && !keys.includes(row.dataset.taskKey ?? ""));
    const destination = targetBody ?? existingDestinationRow?.closest<HTMLElement>(".calm-task-wrap")?.parentElement;
    if (!destination) return false;
    destination.querySelector(":scope > .calm-group-empty")?.remove();
    moved.forEach(wrapper => {
      const row = wrapper.querySelector<HTMLElement>(":scope > .calm-task");
      if (row) row.dataset.orderScope = scopeId;
      destination.appendChild(wrapper);
    });
    const wrappers = Array.from(destination.querySelectorAll<HTMLElement>(":scope > .calm-task-wrap"));
    const byKey = new Map(wrappers.map(wrapper => [wrapper.querySelector<HTMLElement>(":scope > .calm-task")?.dataset.taskKey, wrapper]));
    destinationOrder.forEach(key => {
      const wrapper = byKey.get(key);
      if (wrapper) destination.appendChild(wrapper);
    });
    this.refreshGroupSummaries();
    const caret = this.restoreEditingCaret;
    if (caret) {
      window.requestAnimationFrame(() => {
        const row = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-task-key]"))
          .find(candidate => candidate.dataset.taskKey === caret.taskKey);
        const title = row?.querySelector<HTMLElement>('.calm-task-title[contenteditable="true"]');
        if (title) this.placeCaretAtTextOffset(title, caret.offset);
      });
    }
    return true;
  }

  private refreshGroupSummaries(): void {
    this.contentEl.querySelectorAll<HTMLElement>(".calm-group[data-group-id]").forEach(section => {
      const body = section.querySelector<HTMLElement>(":scope > .calm-group-body");
      if (!body) return;
      const count = body.querySelectorAll(":scope > .calm-task-wrap > .calm-task").length;
      const countLabel = section.querySelector<HTMLElement>(":scope > .calm-group-heading > .calm-group-count");
      if (countLabel) countLabel.textContent = String(count);
      const empty = body.querySelector<HTMLElement>(":scope > .calm-group-empty");
      const groupId = section.dataset.groupId;
      if (count === 0 && !empty && groupId && this.taskDraft?.orderScope !== groupId) this.renderEmptyGroupPlaceholder(body, groupId);
      if (count > 0) empty?.remove();
    });
  }

  private renderEmptyGroupPlaceholder(body: HTMLElement, groupId: string): void {
    const placeholder = body.createEl("button", {
      cls: "calm-group-empty",
      text: "Click to add a task",
      attr: { type: "button" }
    });
    let started = false;
    const start = (event: Event): void => {
      event.stopPropagation();
      if (event instanceof PointerEvent) event.preventDefault();
      if (started) return;
      started = true;
      void this.startTaskDraftInGroup(groupId);
    };
    // Start on the first press so focusing the placeholder cannot consume the
    // initial click. Keep click as a keyboard/accessibility fallback.
    placeholder.addEventListener("pointerdown", start);
    placeholder.addEventListener("click", start);
  }

  private async startTaskDraftInGroup(groupId: string): Promise<void> {
    this.preserveCurrentEmptyDraft();
    this.taskDraft = {
      id: `__draft__:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      afterTaskKey: "",
      orderScope: groupId,
      groupId: groupId === "__inbox__" ? undefined : groupId,
      mode: "all",
      title: ""
    };
    this.editingTaskKey = this.taskDraft.id;
    this.activeTitleCommit = undefined;
    this.clearTaskSelection();
    this.focusTaskKey = undefined;
    this.restoreEditingCaret = undefined;
    this.keyboardTargetKey = undefined;
    this.keyboardTargetScope = groupId;
    this.draftDetailHidden = false;
    await this.render();
  }

  private async saveAndRender(): Promise<void> {
    await this.render();
    try {
      await this.saveSettings();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Could not save Calm Tasks settings.");
    }
  }

  private async renderTask(container: HTMLElement, task: TaskItem, depth: number, groupable = false, orderScope = "__inbox__", canChangeGroup = false, targetedReplacement = false): Promise<void> {
    const wrapper = container.createDiv({ cls: "calm-task-wrap" });
    const key = this.taskGroupKey(task);
    if (groupable && !targetedReplacement) this.visibleTaskOrder.push(key);
    const selectedByDetail = this.selectedTask?.key
      ? this.selectedTask.key === key
      : this.selectedTask?.path === task.path && this.selectedTask.line === task.line;
    const selected = this.selectedKeys.has(key) || selectedByDetail;
    const row = wrapper.createDiv({ cls: `calm-task ${task.status === "done" ? "is-done" : ""} ${selected ? "is-selected" : ""} ${this.selectedKeys.has(key) ? "is-multi-selected" : ""}`, attr: { "data-depth": String(Math.min(depth, 6)), tabindex: "0" } });
    row.dataset.taskKey = key;
    row.dataset.taskPath = task.path;
    row.dataset.taskLine = String(task.line);
    row.dataset.orderScope = orderScope;
    row.setCssProps({ "--task-depth": String(Math.min(depth, 6)) });
    if (groupable) {
      row.dataset.groupable = "true";
    }
    const hasChildren = task.children.length > 0;
    const disclosure = row.createEl("button", { cls: `calm-disclosure ${hasChildren ? "" : "is-hidden"}`, attr: { "aria-label": "Toggle subtasks" } });
    setIcon(disclosure, this.collapsed.has(task.id) ? "chevron-right" : "chevron-down");
    disclosure.addEventListener("click", event => { event.stopPropagation(); this.toggleCollapsed(task.id); });

    const checkbox = row.createEl("button", { cls: "calm-checkbox" });
    setIcon(checkbox, task.status === "open" ? "circle" : "circle-check-big");
    checkbox.createSpan({ cls: "calm-sr-only", text: task.status === "open" ? "Complete task" : "Reopen task" });
    checkbox.addEventListener("click", event => { event.stopPropagation(); void this.run(() => this.toggleTask(task)); });

    const content = row.createDiv({ cls: "calm-task-content" });
    const displayTitle = visibleTaskTitle(task.title);
    const title = content.createDiv({ cls: `calm-task-title markdown-rendered ${displayTitle ? "" : "is-empty-title"}`, attr: { contenteditable: "true", spellcheck: "false" } });
    if (/[*_~`=<>#\\]|https?:\/\//u.test(displayTitle) || displayTitle.includes("[") || displayTitle.includes("]")) {
      await MarkdownRenderer.render(this.app, displayTitle, title, task.path, this);
    } else {
      title.setText(displayTitle);
    }
    const suppressTitleTooltip = (): void => {
      title.removeAttribute("aria-label");
      title.removeAttribute("title");
      title.removeAttribute("data-tooltip-position");
    };
    suppressTitleTooltip();
    title.addEventListener("pointerenter", suppressTitleTooltip, { capture: true });
    title.addEventListener("focus", suppressTitleTooltip, { capture: true });
    const appendSeparator = (): void => {
      title.appendText(" ");
      title.createSpan({ cls: "calm-inline-meta-separator", text: "|" });
      title.appendText(" ");
    };
    inlineMetadataOrder(task).forEach(kind => {
      appendSeparator();
      if (kind === "due" && task.dates.due) {
        const dueState = dateVisualState(task.dates.due);
        title.createSpan({ cls: `calm-inline-date ${dueState}`, text: task.dates.due });
      } else if (kind === "priority" && task.priorityLabel) {
        title.createSpan({ cls: `calm-inline-priority is-${task.priorityLabel.toLowerCase()}`, text: task.priorityLabel });
      }
    });
    this.enableMarkdownLinkPaste(title);
    this.enableInlineTitleEditing(task, title, groupable, orderScope);
    const fileName = task.path.split("/").pop() ?? task.path;
    const sourceName = row.createEl("button", { cls: "calm-task-source-name", text: fileName, attr: { "aria-label": `Open ${task.path}` } });
    sourceName.addEventListener("click", event => { event.stopPropagation(); void this.openSource(task); });
    this.enableUnifiedTaskGesture(task, row, title, groupable, orderScope, canChangeGroup);
    row.addEventListener("keydown", event => {
      if (title.contains(event.target as Node) || (isHTMLElement(event.target) && event.target.closest('[contenteditable="true"]'))) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.selectTask(task, groupable, event.shiftKey, orderScope);
      if (event.key === "Enter") {
        event.stopPropagation();
        void this.startTaskDraft(task, orderScope);
        return;
      }
      if (hasChildren) this.toggleCollapsed(task.id); else void this.render();
    });
    if (hasChildren && !this.collapsed.has(task.id)) {
      const childScope = `__children__:${key}`;
      const children = wrapper.createDiv({ cls: "calm-task-children", attr: { "data-order-scope": childScope } });
      const orderedChildren = this.sortGroupTasks(childScope, task.children);
      this.renderLeadingTaskDraft(children, childScope, depth + 1);
      for (const child of orderedChildren) await this.renderTask(children, child, depth + 1, this.mode === "all", childScope, false);
    }
    if (!targetedReplacement && this.taskDraft?.afterTaskKey === key && !this.draftRendered) {
      this.draftRendered = true;
      this.renderTaskDraft(container, this.taskDraft, depth);
    }
  }

  private async replaceDraftRowWithPending(wrapper: HTMLElement, task: TaskItem, depth: number, orderScope: string, canChangeGroup: boolean, focusOffset?: number): Promise<void> {
    const holder = createDiv();
    await this.renderTask(holder, task, depth, true, orderScope, canChangeGroup, true);
    const rendered = holder.firstElementChild as HTMLElement | null;
    if (!rendered || !wrapper.isConnected) return;
    wrapper.replaceWith(rendered);
    this.alignTaskControlsToFirstLine(rendered);
    window.requestAnimationFrame(() => {
      if (rendered.isConnected) this.alignTaskControlsToFirstLine(rendered);
    });
    if (focusOffset === undefined) return;
    const renderedTitle = rendered.querySelector<HTMLElement>('.calm-task-title[contenteditable="true"]');
    if (!renderedTitle) return;
    this.placeCaretAtTextOffset(renderedTitle, focusOffset);
    window.requestAnimationFrame(() => {
      if (renderedTitle.isConnected) this.placeCaretAtTextOffset(renderedTitle, focusOffset);
    });
  }

  private renderLeadingTaskDraft(container: HTMLElement, orderScope: string, depth: number): void {
    if (this.draftRendered || !this.taskDraft || this.taskDraft.orderScope !== orderScope || this.taskDraft.afterTaskKey) return;
    this.draftRendered = true;
    this.renderTaskDraft(container, this.taskDraft, depth);
  }

  private moveTaskDraft(direction: -1 | 1): void {
    const draft = this.taskDraft;
    const wrapper = this.contentEl.querySelector<HTMLElement>(".calm-task-draft-wrap");
    const title = wrapper?.querySelector<HTMLElement>('.calm-task-draft-title[contenteditable="true"]');
    if (!draft || !wrapper || !title) return;

    const taskKey = (element: Element | null): string | undefined =>
      element?.querySelector<HTMLElement>(":scope > .calm-task[data-task-key]")?.dataset.taskKey;
    const selection = window.getSelection();
    let caretOffset = title.textContent?.length ?? 0;
    if (selection?.rangeCount && selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (title.contains(range.startContainer)) {
        const preceding = document.createRange();
        preceding.selectNodeContents(title);
        preceding.setEnd(range.startContainer, range.startOffset);
        caretOffset = preceding.toString().length;
      }
    }

    if (direction < 0) {
      const previous = wrapper.previousElementSibling;
      if (!taskKey(previous)) return;
      this.taskDraftMoveInProgress = true;
      draft.afterTaskKey = taskKey(previous?.previousElementSibling ?? null) ?? "";
      previous?.before(wrapper);
    } else {
      const next = wrapper.nextElementSibling;
      const nextKey = taskKey(next);
      if (!nextKey) return;
      this.taskDraftMoveInProgress = true;
      draft.afterTaskKey = nextKey;
      next?.after(wrapper);
    }

    this.keyboardTargetKey = draft.afterTaskKey || undefined;
    this.keyboardTargetScope = draft.orderScope;
    const restoreCaret = (): void => {
      if (this.taskDraft !== draft || !title.isConnected) return;
      this.placeCaretAtTextOffset(title, caretOffset);
    };
    restoreCaret();
    window.requestAnimationFrame(() => {
      restoreCaret();
      this.taskDraftMoveInProgress = false;
    });
  }

  private selectTask(task: TaskItem, groupable: boolean, shiftKey: boolean, orderScope?: string): void {
    const key = this.taskGroupKey(task);
    this.draftDetailHidden = true;
    this.selectedTask = { path: task.path, line: task.line, key };
    this.focusTaskKey = key;
    this.keyboardTargetKey = key;
    this.keyboardTargetScope = orderScope;
    if (!groupable) {
      this.selectedKeys = new Set([key]);
      this.selectionAnchor = key;
      this.selectionScope = orderScope;
      return;
    }
    if (shiftKey && this.selectionAnchor && this.selectionScope === orderScope) {
      const scopedOrder = Array.from(this.contentEl.querySelectorAll<HTMLElement>('.calm-task[data-groupable="true"]'))
        .filter(element => element.dataset.orderScope === orderScope)
        .map(element => element.dataset.taskKey).filter((value): value is string => Boolean(value));
      const anchorIndex = scopedOrder.indexOf(this.selectionAnchor);
      const currentIndex = scopedOrder.indexOf(key);
      if (anchorIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        this.selectedKeys = new Set(scopedOrder.slice(start, end + 1));
        return;
      }
    }
    this.selectedKeys = new Set([key]);
    this.selectionAnchor = key;
    this.selectionScope = orderScope;
  }

  private async reorderSelectedByKeyboard(groupId: string, direction: -1 | 1, fallbackKey: string): Promise<void> {
    const preservedScrollTop = this.contentEl.querySelector<HTMLElement>(".calm-list-pane")?.scrollTop ?? this.listScrollTop;
    if (!this.selectedKeys.has(fallbackKey)) {
      this.selectedKeys = new Set([fallbackKey]);
      this.selectionAnchor = fallbackKey;
      this.selectionScope = groupId;
      this.syncSelectionClasses();
    }
    const fullOrder = this.sortGroupTasks(groupId, this.tasksForOrderScope(groupId)).map(task => this.taskGroupKey(task));
    const visibleOrder = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-order-scope][data-task-key]"))
      .filter(row => row.dataset.orderScope === groupId)
      .map(row => row.dataset.taskKey).filter((key): key is string => Boolean(key));
    const order = visibleOrder.includes(fallbackKey) ? [...visibleOrder] : [...fullOrder];
    const previousVisualOrder = [...order];
    const selected = new Set(order.filter(key => this.selectedKeys.has(key)));
    if (direction < 0) {
      for (let index = 1; index < order.length; index++) {
        const key = order[index];
        const previous = order[index - 1];
        if (key && previous && selected.has(key) && !selected.has(previous)) {
          order[index - 1] = key;
          order[index] = previous;
        }
      }
    } else {
      for (let index = order.length - 2; index >= 0; index--) {
        const key = order[index];
        const next = order[index + 1];
        if (key && next && selected.has(key) && !selected.has(next)) {
          order[index] = next;
          order[index + 1] = key;
        }
      }
    }
    if (order.every((key, index) => key === previousVisualOrder[index])) return;
    const settings = this.getSettings();
    const previousOrder = [...(settings.taskOrder[groupId] ?? [])];
    const visibleKeys = new Set(previousVisualOrder);
    let visibleIndex = 0;
    const persistedOrder = fullOrder.map(key => visibleKeys.has(key) ? (order[visibleIndex++] ?? key) : key);
    order.slice(visibleIndex).forEach(key => { if (!persistedOrder.includes(key)) persistedOrder.push(key); });
    settings.taskOrder[groupId] = persistedOrder;
    this.pendingStoreRender = false;
    this.listScrollTop = preservedScrollTop;
    if (!this.applyKeyboardStepToDom(groupId, previousVisualOrder, selected, direction)) {
      if (!this.applyTaskMoveToDom(Array.from(selected), groupId, order)) await this.render();
    }
    try {
      await this.saveSettings();
    } catch (error) {
      settings.taskOrder[groupId] = previousOrder;
      new Notice(error instanceof Error ? error.message : "Could not save task ordering.");
      await this.render();
    }
  }

  private applyKeyboardStepToDom(scopeId: string, order: string[], selected: Set<string>, direction: -1 | 1): boolean {
    const selectedIndexes = order.map((key, index) => selected.has(key) ? index : -1).filter(index => index >= 0);
    if (!selectedIndexes.length) return false;
    const firstIndex = selectedIndexes[0] as number;
    const lastIndex = selectedIndexes[selectedIndexes.length - 1] as number;
    if (lastIndex - firstIndex + 1 !== selectedIndexes.length) return false;
    const boundaryIndex = direction < 0 ? firstIndex - 1 : lastIndex + 1;
    const boundaryKey = order[boundaryIndex];
    const firstKey = order[firstIndex];
    const lastKey = order[lastIndex];
    if (!boundaryKey || !firstKey || !lastKey) return false;
    const rows = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-order-scope][data-task-key]"))
      .filter(row => row.dataset.orderScope === scopeId);
    const wrapperFor = (key: string): HTMLElement | undefined => rows
      .find(row => row.dataset.taskKey === key)?.closest<HTMLElement>(".calm-task-wrap") ?? undefined;
    const boundary = wrapperFor(boundaryKey);
    const first = wrapperFor(firstKey);
    const last = wrapperFor(lastKey);
    if (!boundary || !first || !last || boundary.parentElement !== first.parentElement || first.parentElement !== last.parentElement) return false;
    if (direction < 0) last.after(boundary);
    else first.before(boundary);
    return true;
  }

  private showSelectedTasksMenu(event: MouseEvent, contextTask: TaskItem): void {
    const menu = new Menu();
    const contextKey = this.taskGroupKey(contextTask);
    const keys = this.selectedKeys.has(contextKey) ? Array.from(this.selectedKeys) : [contextKey];
    if (this.mode === "priority") {
      (["A", "B", "C", "D"] as const).forEach(priority => {
        menu.addItem(item => item.setTitle(`Move to ${priority}`).setIcon("signal-high").onClick(() => void this.setSelectedTasksPriority(keys, priority)));
      });
      menu.addItem(item => item.setTitle("Move to none").setIcon("circle-minus").onClick(() => void this.setSelectedTasksPriority(keys, undefined)));
      this.addMoveToDailyNoteMenuItem(menu, keys);
      this.addDeleteTasksMenuItem(menu, keys);
      menu.showAtMouseEvent(event);
      return;
    }
    if (this.mode === "agenda") {
      const dates = Array.from(new Set(flattenTasks(this.filteredRoots()).map(taskDate).filter((date): date is string => Boolean(date)))).sort();
      dates.forEach(date => {
        menu.addItem(item => item.setTitle(`Move to ${readableDate(date)} · ${date}`).setIcon("calendar-days").onClick(() => void this.setSelectedTasksDue(keys, date)));
      });
      menu.addItem(item => item.setTitle("Remove due date").setIcon("calendar-x").onClick(() => void this.setSelectedTasksDue(keys, undefined)));
      this.addMoveToDailyNoteMenuItem(menu, keys);
      this.addDeleteTasksMenuItem(menu, keys);
      menu.showAtMouseEvent(event);
      return;
    }
    menu.addItem(item => item.setTitle("Move to inbox").setIcon("inbox").onClick(() => void this.moveTasksFromMenu(keys, "__inbox__")));
    this.getSettings().groups.forEach(group => {
      menu.addItem(item => item.setTitle(`Move to ${group.name}`).setIcon("folder-input").onClick(() => void this.moveTasksFromMenu(keys, group.id)));
    });
    this.addMoveToDailyNoteMenuItem(menu, keys);
    this.addDeleteTasksMenuItem(menu, keys);
    menu.showAtMouseEvent(event);
  }

  private addMoveToDailyNoteMenuItem(menu: Menu, keys: string[]): void {
    if (!this.getSettings().moveTasksToDailyNoteEnabled) return;
    const count = new Set(keys).size;
    const today = localDate();
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle(count > 1 ? `Move ${count} tasks to daily note (${today})` : `Move to daily note (${today})`)
      .setIcon("calendar-arrow-down")
      .onClick(() => void this.moveTaskKeysToDailyNote(keys)));
  }

  private addDeleteTasksMenuItem(menu: Menu, keys: string[]): void {
    menu.addSeparator();
    const count = new Set(keys).size;
    menu.addItem(item => item
      .setTitle(count > 1 ? `Delete ${count} tasks` : "Delete task")
      .setIcon("trash-2")
      .onClick(() => this.requestDeleteTaskKeys(keys)));
  }

  private requestDeleteTaskKeys(keys: string[]): void {
    const uniqueKeys = Array.from(new Set(keys));
    const count = this.selectedTasksForKeys(uniqueKeys).length;
    if (!count) {
      new Notice("Could not find the selected tasks. Refresh Calm Tasks and try again.");
      return;
    }
    if (count > 1) {
      new ConfirmTaskDeleteModal(this.app, count, () => void this.deleteTaskKeys(uniqueKeys)).open();
      return;
    }
    void this.deleteTaskKeys(uniqueKeys);
  }

  private async deleteTaskKeys(keys: string[]): Promise<void> {
    const tasks = this.selectedTasksForKeys(keys);
    if (!tasks.length) {
      new Notice("Could not find the selected tasks. Refresh Calm Tasks and try again.");
      return;
    }

    const selected = new Set(keys);
    const visibleRows = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-task-key]"));
    const selectedIndexes = visibleRows
      .map((row, index) => selected.has(row.dataset.taskKey ?? "") ? index : -1)
      .filter(index => index >= 0);
    const lastSelectedIndex = selectedIndexes.length ? Math.max(...selectedIndexes) : -1;
    const firstSelectedIndex = selectedIndexes.length ? Math.min(...selectedIndexes) : -1;
    const fallbackRow = visibleRows.slice(lastSelectedIndex + 1).find(row => !selected.has(row.dataset.taskKey ?? ""))
      ?? (firstSelectedIndex > 0 ? [...visibleRows.slice(0, firstSelectedIndex)].reverse().find(row => !selected.has(row.dataset.taskKey ?? "")) : undefined);
    const fallbackKey = fallbackRow?.dataset.taskKey;
    const fallbackScope = fallbackRow?.dataset.orderScope;
    const fallbackGroupable = fallbackRow?.dataset.groupable === "true";

    tasks.forEach(task => this.optimisticallyDeletedTaskIds.add(task.id));
    visibleRows
      .filter(row => selected.has(row.dataset.taskKey ?? ""))
      .forEach(row => row.closest<HTMLElement>(".calm-task-wrap")?.remove());
    const fallbackTask = fallbackKey
      ? flattenTasks(this.viewRoots()).find(task => this.taskGroupKey(task) === fallbackKey)
      : undefined;
    if (fallbackTask && fallbackKey) {
      this.selectTask(fallbackTask, fallbackGroupable, false, fallbackScope);
      this.focusTaskKey = fallbackKey;
      this.restoreEditingCaret = { taskKey: fallbackKey, offset: Number.MAX_SAFE_INTEGER };
      this.syncSelectionClasses();
    } else {
      this.clearTaskSelection();
    }
    this.refreshGroupSummaries();
    void this.refreshDetailPanel();

    await this.runTaskMutation(async () => {
      try {
        await this.activeTitleCommit?.(false);
        await this.store.deleteTasks(tasks);
        const persistedKeys = new Set([...keys, ...tasks.map(task => this.taskGroupKey(task))]);
        const settings = this.getSettings();
        persistedKeys.forEach(key => delete settings.groupAssignments[key]);
        Object.values(settings.taskOrder).forEach(order => {
          for (let index = order.length - 1; index >= 0; index--) {
            if (persistedKeys.has(order[index] as string)) order.splice(index, 1);
          }
        });
        await this.saveSettings();
      } catch (error) {
        tasks.forEach(task => this.optimisticallyDeletedTaskIds.delete(task.id));
        await this.store.refreshFiles(new Set(tasks.map(task => task.path)));
        this.pendingStoreRender = false;
        await this.render();
        throw error;
      }
      tasks.forEach(task => this.optimisticallyDeletedTaskIds.delete(task.id));
      this.pendingStoreRender = false;
    });
  }

  private async moveTasksFromMenu(keys: string[], groupId: string): Promise<void> {
    const selected = new Set(keys);
    const liveKeys = flattenTasks(this.viewRoots())
      .filter(task => selected.has(this.taskGroupKey(task)))
      .map(task => this.taskGroupKey(task));
    if (!liveKeys.length) {
      new Notice("Could not find the selected task. Refresh Calm Tasks and try again.");
      return;
    }
    await this.moveTaskKeys(liveKeys, groupId, undefined, false, true);
    // Rebuild the groups from persisted assignments instead of relying on the
    // optimistic DOM move. This also confirms file-level fallback assignments
    // are overridden correctly when moving through the context menu.
    await this.render();
  }

  private async moveTaskKeysToDailyNote(keys: string[]): Promise<void> {
    const requestedKeys = Array.from(new Set(keys));
    const requestedSelection = requestedKeys.length === this.selectedKeys.size
      && requestedKeys.every(key => this.selectedKeys.has(key));
    await this.runTaskMutation(async () => {
      await this.activeTitleCommit?.(false);
      // Committing an inline edit can change the task key. Resolve fresh task
      // objects only after that commit so a stale/empty editor snapshot can
      // never be removed from its source file.
      const liveKeys = requestedSelection ? Array.from(this.selectedKeys) : requestedKeys;
      const tasks = this.selectedTasksForKeys(liveKeys);
      if (!tasks.length) throw new Error("Could not find the selected tasks. Refresh Calm Tasks and try again.");
      if (tasks.some(task => !task.title.trim())) {
        throw new Error("Finish entering the task title before moving it to the daily note.");
      }
      const placements = new Map(tasks.map(task => [this.taskGroupKey(task), this.assignedGroupId(task)]));
      const settings = this.getSettings();
      const moved = await this.store.moveTasksToDailyNote(tasks, settings.dailyNotesFolder, settings.dailyNoteTaskHeading);

      const keyChanges = new Map<string, string>();
      moved.forEach(({ before, after }) => keyChanges.set(this.taskGroupKey(before), this.taskGroupKey(after)));
      moved.forEach(({ before, after }) => {
        const previousKey = this.taskGroupKey(before);
        const nextKey = this.taskGroupKey(after);
        const previousBase = this.taskBaseKey(before);
        const groupId = placements.get(previousKey);
        delete settings.groupAssignments[previousKey];
        delete settings.groupAssignments[previousBase];
        if (groupId) settings.groupAssignments[nextKey] = groupId;
        else if (settings.fileGroupAssignments[after.path]) settings.groupAssignments[nextKey] = "__inbox__";
      });
      const syncSettings = settings.microsoftSync;
      const managedPath = normalizeSyncPath(syncSettings.markdownPath);
      const now = new Date().toISOString();
      moved.forEach(({ before, after }) => {
        if (normalizeSyncPath(before.path) !== managedPath || normalizeSyncPath(after.path) === managedPath || !before.syncKey) return;
        const snapshot = Object.values(syncSettings.snapshots).find(candidate => syncMarker("t", candidate.taskId) === before.syncKey);
        if (!snapshot) return;
        syncSettings.calmImports[`mst:${before.syncKey}`] = {
          taskId: snapshot.taskId,
          listId: snapshot.listId,
          sourcePath: after.path,
          sourceLine: after.line,
          sourceTitle: after.title,
          createdAt: snapshot.createdAt ?? now,
          lastSyncedAt: now,
          remoteCreatedAt: snapshot.createdAt
        };
        delete syncSettings.deletions[snapshot.taskId];
      });
      Object.values(settings.taskOrder).forEach(order => {
        for (let index = 0; index < order.length; index++) {
          const replacement = keyChanges.get(order[index] as string);
          if (replacement) order[index] = replacement;
        }
      });
      this.selectedKeys = new Set(Array.from(this.selectedKeys, key => keyChanges.get(key) ?? key));
      if (this.selectionAnchor) this.selectionAnchor = keyChanges.get(this.selectionAnchor) ?? this.selectionAnchor;
      if (this.keyboardTargetKey) this.keyboardTargetKey = keyChanges.get(this.keyboardTargetKey) ?? this.keyboardTargetKey;
      if (this.selectedTask?.key) this.selectedTask.key = keyChanges.get(this.selectedTask.key) ?? this.selectedTask.key;
      const selectedMoved = moved.find(({ before }) => this.selectedTask?.path === before.path && this.selectedTask.line === before.line);
      if (selectedMoved && this.selectedTask) {
        this.selectedTask.path = selectedMoved.after.path;
        this.selectedTask.line = selectedMoved.after.line;
        this.selectedTask.key = this.taskGroupKey(selectedMoved.after);
      }
      await this.saveSettings();
      this.pendingStoreRender = false;
      await this.render();
      new Notice(moved.length > 1 ? `${moved.length} tasks moved to today's daily note.` : "Task moved to today's daily note.");
    });
  }

  private selectedTasksForKeys(keys: string[]): TaskItem[] {
    const selected = new Set(keys);
    return flattenTasks(this.viewRoots()).filter(task => selected.has(this.taskGroupKey(task)));
  }

  private async setSelectedTasksPriority(keys: string[], priority?: "A" | "B" | "C" | "D"): Promise<void> {
    await this.runTaskMutation(async () => {
      const writes = this.selectedTasksForKeys(keys).map(task => this.store.setPriority(task, priority));
      this.pendingStoreRender = false;
      await this.render();
      await Promise.all(writes);
    });
  }

  private async setSelectedTasksDue(keys: string[], due?: string): Promise<void> {
    await this.runTaskMutation(async () => {
      const writes = this.selectedTasksForKeys(keys).map(task => this.store.setDue(task, due));
      this.pendingStoreRender = false;
      await this.render();
      await Promise.all(writes);
    });
  }

  private toggleCollapsed(id: string): void {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    void this.render();
  }

  private enableInlineTitleEditing(task: TaskItem, title: HTMLElement, groupable: boolean, orderScope: string): void {
    const key = this.taskGroupKey(task);
    let finished = false;
    let initialText = "";
    let metadataSaveTimer: number | undefined;
    const save = async (renderAfter = true): Promise<void> => {
      if (finished) return;
      finished = true;
      if (metadataSaveTimer) window.clearTimeout(metadataSaveTimer);
      const nextTitle = serializeInlineMarkdown(title);
      if (!logicalInlineTitle(nextTitle) && task.path !== this.store.newTaskFilePath()) {
        finished = false;
        return;
      }
      if (nextTitle !== initialText) {
        await this.run(() => this.renameTask(task, nextTitle));
      }
      if (this.editingTaskKey === key) {
        this.editingTaskKey = undefined;
        this.pendingStoreRender = false;
        if (this.activeTitleCommit === save) this.activeTitleCommit = undefined;
        if (renderAfter) await this.render();
      }
    };
    title.addEventListener("focus", () => {
      finished = false;
      initialText = serializeInlineMarkdown(title);
      this.draftDetailHidden = true;
      this.editingTaskKey = key;
      this.activeTitleCommit = save;
      this.selectedTask = { path: task.path, line: task.line, key };
      if (groupable) {
        if (!this.selectedKeys.has(key)) {
          this.selectedKeys = new Set([key]);
          this.selectionAnchor = key;
        }
        this.keyboardTargetKey = key;
        this.keyboardTargetScope = orderScope;
        this.selectionScope = orderScope;
        this.syncSelectionClasses();
      } else {
        this.selectedKeys = new Set([key]);
        this.selectionAnchor = key;
        this.selectionScope = orderScope;
        this.keyboardTargetKey = undefined;
        this.keyboardTargetScope = undefined;
        this.syncSelectionClasses();
      }
      void this.refreshDetailPanel();
    });
    title.addEventListener("blur", () => window.setTimeout(() => void save(), 0));
    title.addEventListener("input", () => {
      if (metadataSaveTimer) window.clearTimeout(metadataSaveTimer);
      const emptyTitle = !logicalInlineTitle(serializeInlineMarkdown(title));
      title.toggleClass("is-empty-title", emptyTitle);
      if (emptyTitle) return;
      metadataSaveTimer = window.setTimeout(() => {
        metadataSaveTimer = undefined;
        const state = inlineMetadataState(serializeInlineMarkdown(title));
        if (!state) return;
        if (state.due === task.dates.due && state.priority === task.priorityLabel) return;
        this.captureEditingCaret();
        this.focusTaskKey = key;
        void save();
      }, 180);
    });
    title.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const direction = event.key === "ArrowUp" ? -1 : 1;
        if (this.shouldLeaveTitleWithArrow(title, direction)) {
          event.preventDefault();
          event.stopPropagation();
          void this.moveEditingFocus(title, direction, save);
          return;
        }
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const split = splitInlineMarkdownAtCaret(title);
        void (async () => {
          if (split?.before && split.after) title.setText(split.before);
          await save(false);
          const currentTask = flattenTasks(this.store.roots).find(item => item.path === task.path && item.line === task.line) ?? task;
          await this.startTaskDraft(currentTask, orderScope, split?.before && split.after ? split.after : "");
        })();
      }
      if (event.key === "Backspace" && !logicalInlineTitle(serializeInlineMarkdown(title))) {
        event.preventDefault();
        event.stopPropagation();
        const rows = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-task-key]"));
        const currentRow = title.closest<HTMLElement>(".calm-task");
        const currentIndex = currentRow ? rows.indexOf(currentRow) : -1;
        const previousRow = currentIndex > 0 ? rows[currentIndex - 1] : undefined;
        const previousKey = previousRow?.dataset.taskKey;
        const previousTitle = previousRow?.querySelector<HTMLElement>('.calm-task-title[contenteditable="true"]');
        finished = true;
        if (metadataSaveTimer) window.clearTimeout(metadataSaveTimer);
        if (this.activeTitleCommit === save) this.activeTitleCommit = undefined;
        this.clearTaskSelection();
        this.editingTaskKey = undefined;
        this.pendingStoreRender = false;
        this.optimisticallyDeletedTaskIds.add(task.id);
        currentRow?.closest(".calm-task-wrap")?.remove();
        this.refreshGroupSummaries();
        if (previousKey) {
          this.focusTaskKey = previousKey;
          this.restoreEditingCaret = { taskKey: previousKey, offset: Number.MAX_SAFE_INTEGER };
        }
        if (previousTitle?.isConnected) this.placeCaretAtTextOffset(previousTitle, Number.MAX_SAFE_INTEGER);
        void (async () => {
          try {
            await this.store.deleteTask(task);
            this.optimisticallyDeletedTaskIds.delete(task.id);
            this.pendingStoreRender = false;
            const settings = this.getSettings();
            delete settings.groupAssignments[key];
            Object.values(settings.taskOrder).forEach(order => {
              let index = order.indexOf(key);
              while (index >= 0) {
                order.splice(index, 1);
                index = order.indexOf(key);
              }
            });
            await this.saveSettings();
          } catch (error) {
            this.optimisticallyDeletedTaskIds.delete(task.id);
            this.pendingStoreRender = false;
            new Notice(this.taskErrorMessage(error, "Could not remove the empty task."));
            await this.render();
          }
        })();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        finished = true;
        if (this.editingTaskKey === key) {
          this.editingTaskKey = undefined;
          this.pendingStoreRender = false;
        }
        if (this.activeTitleCommit === save) this.activeTitleCommit = undefined;
        void this.render();
      }
    });
    title.addEventListener("click", event => {
      if (isHTMLElement(event.target) && event.target.closest("a")) event.preventDefault();
      event.stopPropagation();
    });
  }

  private async startTaskDraft(task: TaskItem, orderScope: string, initialTitle = ""): Promise<void> {
    this.preserveCurrentEmptyDraft();
    const afterTaskKey = this.taskGroupKey(task);
    const groupId = this.mode === "all" ? this.groupIdForTaskKey(afterTaskKey) : undefined;
    this.taskDraft = {
      id: `__draft__:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      afterTaskKey,
      orderScope: groupId ?? orderScope,
      groupId,
      mode: this.mode,
      due: this.mode === "agenda" ? taskDate(task) : undefined,
      priority: this.mode === "priority" ? task.priorityLabel : undefined,
      title: initialTitle
    };
    this.editingTaskKey = this.taskDraft.id;
    this.activeTitleCommit = undefined;
    this.clearTaskSelection();
    this.focusTaskKey = undefined;
    this.restoreEditingCaret = undefined;
    this.keyboardTargetKey = afterTaskKey;
    this.keyboardTargetScope = this.taskDraft.orderScope;
    this.editingTaskKey = this.taskDraft.id;
    this.draftDetailHidden = false;
    await this.render();
  }

  private preserveCurrentEmptyDraft(): void {
    const draft = this.taskDraft;
    if (!draft || draft.title.trim()) return;
    let body = "";
    if (draft.due) body += ` | ${draft.due}`;
    if (draft.priority) body += ` | ${draft.priority}`;
    body = body.trim();
    const path = this.store.newTaskFilePath();
    const pending = parseTasks(path, `- [ ] ${body}`, true)[0];
    if (!pending) return;
    pending.id = `__pending__:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    pending.line = -Date.now();
    this.pendingCreatedTasks.push(pending);
    const pendingKey = this.taskGroupKey(pending);
    const settings = this.getSettings();
    if (draft.mode === "all" && draft.groupId) settings.groupAssignments[pendingKey] = draft.groupId;
    const tasks = this.sortGroupTasks(draft.orderScope, this.tasksForOrderScope(draft.orderScope));
    const order = tasks.map(item => this.taskGroupKey(item)).filter(key => key !== pendingKey);
    const afterIndex = order.indexOf(draft.afterTaskKey);
    const insertionIndex = draft.afterTaskKey ? (afterIndex >= 0 ? afterIndex + 1 : order.length) : 0;
    order.splice(insertionIndex, 0, pendingKey);
    settings.taskOrder[draft.orderScope] = order;
    this.taskDraft = undefined;
    this.pendingStoreRender = false;
    void this.persistPendingTask(body, pending, draft);
  }

  private renderTaskDraft(container: HTMLElement, draft: TaskDraft, depth: number): void {
    const wrapper = container.createDiv({ cls: "calm-task-wrap calm-task-draft-wrap" });
    const row = wrapper.createDiv({ cls: "calm-task calm-task-draft is-selected", attr: { "data-depth": String(Math.min(depth, 6)) } });
    row.setCssProps({ "--task-depth": String(Math.min(depth, 6)) });
    const disclosure = row.createEl("button", { cls: "calm-disclosure is-hidden", attr: { tabindex: "-1", "aria-hidden": "true" } });
    setIcon(disclosure, "chevron-down");
    const checkbox = row.createEl("button", { cls: "calm-checkbox", attr: { tabindex: "-1" } });
    setIcon(checkbox, "circle");
    checkbox.createSpan({ cls: "calm-sr-only", text: "New task" });
    const content = row.createDiv({ cls: "calm-task-content" });
    const title = content.createDiv({ cls: "calm-task-title calm-task-draft-title", attr: { contenteditable: "true", spellcheck: "false", role: "textbox" } });
    if (draft.title) title.setText(draft.title);
    this.enableMarkdownLinkPaste(title);
    if (draft.due) {
      title.createSpan({ cls: "calm-inline-meta-separator", text: "\u00a0|\u00a0" });
      title.createSpan({ cls: `calm-inline-date ${dateVisualState(draft.due)}`, text: draft.due });
    } else if (draft.mode === "priority" && draft.priority) {
      title.createSpan({ cls: "calm-inline-meta-separator", text: "\u00a0|\u00a0" });
      title.createSpan({ cls: `calm-inline-priority is-${draft.priority.toLowerCase()}`, text: draft.priority });
    }
    let finished = false;
    let saving = false;
    const cancel = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      this.taskDraft = undefined;
      if (this.editingTaskKey === draft.id) this.editingTaskKey = undefined;
      this.pendingStoreRender = false;
      this.focusTaskKey = draft.afterTaskKey;
      this.restoreEditingCaret = { taskKey: draft.afterTaskKey, offset: Number.MAX_SAFE_INTEGER };
      await this.render();
    };
    const commit = async (createNext = false, completeAndFocus = false, focusOffset?: number): Promise<void> => {
      if (finished || saving) return;
      const value = serializeInlineMarkdown(title).trim();
      if (!logicalInlineTitle(value)) return;
      saving = true;
      const metadata = inlineMetadataState(value);
      let body = value;
      if (metadata && draft.due && !metadata.due) body += ` | ${draft.due}`;
      if (metadata && draft.priority && !metadata.priority) body += ` | ${draft.priority}`;
      const path = this.store.newTaskFilePath();
      const pending = parseTasks(path, `- [ ] ${body}`)[0];
      if (!pending) { saving = false; return; }
      pending.id = `__pending__:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
      pending.line = -Date.now();
      if (completeAndFocus) {
        pending.status = "done";
        pending.statusChar = "x";
        pending.dates.completed = localDate();
      }
      this.pendingCreatedTasks.push(pending);
      checkbox.removeAttribute("tabindex");
      checkbox.empty();
      setIcon(checkbox, pending.status === "done" ? "circle-check-big" : "circle");
      checkbox.createSpan({ cls: "calm-sr-only", text: pending.status === "done" ? "Reopen task" : "Complete task" });
      if (!completeAndFocus) {
        checkbox.addEventListener("click", event => {
          event.stopPropagation();
          void this.run(() => this.toggleTask(pending));
        });
      }
      const createdKey = this.taskGroupKey(pending);
      if (completeAndFocus) this.sessionCompleted.add(createdKey);
      const settings = this.getSettings();
      if (draft.mode === "all" && draft.groupId) settings.groupAssignments[createdKey] = draft.groupId;
      const tasks = this.sortGroupTasks(draft.orderScope, this.tasksForOrderScope(draft.orderScope));
      const order = tasks.map(item => this.taskGroupKey(item)).filter(key => key !== createdKey);
      const afterIndex = order.indexOf(draft.afterTaskKey);
      const insertionIndex = draft.afterTaskKey ? (afterIndex >= 0 ? afterIndex + 1 : order.length) : 0;
      order.splice(insertionIndex, 0, createdKey);
      settings.taskOrder[draft.orderScope] = order;
      finished = true;
      this.pendingStoreRender = false;
      if (createNext) {
        this.clearTaskSelection();
        this.focusTaskKey = undefined;
        this.restoreEditingCaret = undefined;
        this.taskDraft = {
          ...draft,
          id: `__draft__:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
          afterTaskKey: createdKey,
          title: ""
        };
        this.editingTaskKey = this.taskDraft.id;
        this.keyboardTargetKey = createdKey;
        this.keyboardTargetScope = this.taskDraft.orderScope;
        this.draftDetailHidden = false;
        wrapper.removeClass("calm-task-draft-wrap");
        row.removeClass("calm-task-draft", "is-selected");
        row.dataset.taskKey = createdKey;
        row.dataset.taskPath = pending.path;
        row.dataset.taskLine = String(pending.line);
        title.removeClass("calm-task-draft-title");
        title.addClass("calm-task-pending-title", "markdown-rendered");
        title.setAttribute("contenteditable", "false");
        const holder = createDiv();
        this.renderTaskDraft(holder, this.taskDraft, depth);
        const nextWrapper = holder.firstElementChild;
        if (nextWrapper) wrapper.after(nextWrapper);
        const workspace = this.contentEl.querySelector<HTMLElement>(".calm-workspace");
        workspace?.addClass("has-selection");
        const detail = workspace?.querySelector<HTMLElement>(".calm-detail");
        if (detail) {
          detail.empty();
          this.renderTaskDraftDetail(detail, this.taskDraft);
        }
        void this.replaceDraftRowWithPending(wrapper, pending, depth, draft.orderScope, draft.mode === "all");
      } else {
        this.taskDraft = undefined;
        if (this.editingTaskKey === draft.id) this.editingTaskKey = `__persist__:${pending.id}`;
        wrapper.removeClass("calm-task-draft-wrap");
        row.removeClass("calm-task-draft");
        row.toggleClass("is-selected", completeAndFocus);
        row.toggleClass("is-done", pending.status === "done");
        row.dataset.taskKey = createdKey;
        row.dataset.taskPath = pending.path;
        row.dataset.taskLine = String(pending.line);
        title.removeClass("calm-task-draft-title");
        title.addClass("calm-task-pending-title", "markdown-rendered");
        if (completeAndFocus) {
          this.selectedTask = { path: pending.path, line: pending.line, key: createdKey };
          this.selectedKeys = new Set([createdKey]);
          this.selectionAnchor = createdKey;
          this.selectionScope = draft.orderScope;
          this.keyboardTargetKey = createdKey;
          this.keyboardTargetScope = draft.orderScope;
          this.draftDetailHidden = true;
          void this.refreshDetailPanel();
        } else {
          row.removeClass("is-selected");
          title.setAttribute("contenteditable", "false");
        }
        void this.replaceDraftRowWithPending(wrapper, pending, depth, draft.orderScope, draft.mode === "all", completeAndFocus ? focusOffset : undefined);
      }
      void this.persistPendingTask(body, pending, draft);
    };
    let checkboxCaretOffset = Number.MAX_SAFE_INTEGER;
    checkbox.addEventListener("pointerdown", event => {
      event.preventDefault();
      const selection = window.getSelection();
      if (!selection?.rangeCount || !selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!title.contains(range.startContainer)) return;
      const preceding = document.createRange();
      preceding.selectNodeContents(title);
      preceding.setEnd(range.startContainer, range.startOffset);
      checkboxCaretOffset = preceding.toString().length;
    });
    checkbox.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (!logicalInlineTitle(serializeInlineMarkdown(title))) return;
      void commit(false, true, checkboxCaretOffset);
    });
    title.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const direction = event.key === "ArrowUp" ? -1 : 1;
        if (logicalInlineTitle(serializeInlineMarkdown(title)) && this.shouldLeaveTitleWithArrow(title, direction)) {
          event.preventDefault();
          event.stopPropagation();
          void this.moveEditingFocus(title, direction, async () => { await commit(false); });
          return;
        }
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void commit(true);
        return;
      }
      if (event.key === "Backspace" && !logicalInlineTitle(serializeInlineMarkdown(title))) {
        event.preventDefault();
        event.stopPropagation();
        void cancel();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void cancel();
      }
    });
    title.addEventListener("input", () => {
      draft.title = logicalInlineTitle(serializeInlineMarkdown(title));
      if (draft.title) {
        this.keyboardTargetKey = undefined;
        this.keyboardTargetScope = undefined;
      } else {
        this.keyboardTargetKey = draft.afterTaskKey;
        this.keyboardTargetScope = draft.orderScope;
      }
      const detailTitle = this.contentEl.querySelector<HTMLElement>(".calm-detail-draft-title");
      if (detailTitle) detailTitle.textContent = draft.title;
    });
    title.addEventListener("compositionstart", () => {
      this.taskDraftCompositionInProgress = true;
    });
    title.addEventListener("compositionend", () => {
      this.taskDraftCompositionInProgress = false;
      const direction = this.queuedTaskDraftMove;
      this.queuedTaskDraftMove = undefined;
      if (!direction) return;
      window.requestAnimationFrame(() => {
        if (this.taskDraft !== draft || !title.isConnected) return;
        draft.title = logicalInlineTitle(serializeInlineMarkdown(title));
        this.moveTaskDraft(direction);
      });
    });
    title.addEventListener("focus", () => {
      if (this.taskDraft?.id !== draft.id) return;
      this.draftDetailHidden = false;
      this.clearTaskSelection();
      if (!draft.title) {
        this.keyboardTargetKey = draft.afterTaskKey;
        this.keyboardTargetScope = draft.orderScope;
      }
      this.syncSelectionClasses();
      void this.refreshDetailPanel();
    });
    title.addEventListener("blur", () => {
      if (finished || saving || this.taskDraftMoveInProgress) return;
      if (logicalInlineTitle(serializeInlineMarkdown(title))) void commit(false);
    });
    window.requestAnimationFrame(() => {
      if (!title.isConnected || this.taskDraft?.id !== draft.id) return;
      title.focus({ preventScroll: true });
      const range = document.createRange();
      range.setStart(title, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      title.scrollIntoView({ block: "nearest" });
    });
  }

  private async persistPendingTask(body: string, pending: TaskItem, draft: TaskDraft): Promise<void> {
    const pendingId = pending.id;
    const pendingKey = this.taskGroupKey(pending);
    const pendingPath = pending.path;
    const pendingLine = pending.line;
    let created: TaskItem;
    try {
      created = await this.store.createTask(body);
    } catch (error) {
      this.pendingCreatedTasks = this.pendingCreatedTasks.filter(task => task.id !== pending.id);
      const settings = this.getSettings();
      settings.taskOrder[draft.orderScope] = (settings.taskOrder[draft.orderScope] ?? []).filter(key => key !== pendingKey);
      if (draft.mode === "all" && settings.groupAssignments[pendingKey] === draft.groupId) delete settings.groupAssignments[pendingKey];
      if (this.taskDraft?.afterTaskKey === pendingKey) this.taskDraft.afterTaskKey = draft.afterTaskKey;
      if (this.editingTaskKey === `__persist__:${pending.id}`) this.editingTaskKey = undefined;
      this.pendingStoreRender = false;
      new Notice(error instanceof Error ? error.message : "Could not create the task.");
      await this.render();
      return;
    }

    // A pending row can be toggled while its initial Markdown line is still
    // being created. Replay the latest desired state after creation; if the
    // user toggles again during that write, loop once more until disk and UI
    // agree.
    try {
      while (created.status !== pending.status) await this.store.toggle(created);
    } catch (error) {
      new Notice(this.taskErrorMessage(error, "The task was created, but its completed state could not be saved."));
    }

    const selectedPending = this.selectedTask?.path === pendingPath && this.selectedTask.line === pendingLine;
    const createdKey = this.taskGroupKey(created);
    this.pendingCreatedTasks = this.pendingCreatedTasks.filter(task => task.id !== pendingId);
    const settings = this.getSettings();
    const pendingGroup = settings.groupAssignments[pendingKey];
    if (createdKey !== pendingKey) {
      if (pendingGroup !== undefined) settings.groupAssignments[createdKey] = pendingGroup;
      delete settings.groupAssignments[pendingKey];
      Object.values(settings.taskOrder).forEach(order => {
        for (let index = 0; index < order.length; index++) {
          if (order[index] === pendingKey) order[index] = createdKey;
        }
      });
      if (this.selectedKeys.delete(pendingKey)) this.selectedKeys.add(createdKey);
      if (this.selectionAnchor === pendingKey) this.selectionAnchor = createdKey;
      if (this.keyboardTargetKey === pendingKey) this.keyboardTargetKey = createdKey;
      if (this.taskDraft?.afterTaskKey === pendingKey) this.taskDraft.afterTaskKey = createdKey;
    }
    // File-level grouping can differ between the source task and the configured
    // new-task file. Pin the newly persisted task to the group inherited by the
    // draft so it cannot fall back to Inbox or another file's default group.
    if (draft.mode === "all" && draft.groupId) settings.groupAssignments[createdKey] = draft.groupId;
    void this.saveSettings().catch(error => new Notice(error instanceof Error ? error.message : "Could not save task ordering."));
    if (selectedPending) this.selectedTask = { path: created.path, line: created.line, key: createdKey };
    Object.assign(pending, created);
    this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-task-path][data-task-line]").forEach(row => {
      if (row.dataset.taskPath !== pendingPath || Number(row.dataset.taskLine) !== pendingLine) return;
      row.dataset.taskPath = created.path;
      row.dataset.taskLine = String(created.line);
    });
    if (this.editingTaskKey === `__persist__:${pendingId}`) {
      this.editingTaskKey = undefined;
      if (this.pendingStoreRender) {
        this.pendingStoreRender = false;
        await this.render();
      }
    }
  }

  private enableUnifiedTaskGesture(task: TaskItem, row: HTMLElement, title: HTMLElement, groupable: boolean, sourceScope: string, canChangeGroup: boolean): void {
    const key = this.taskGroupKey(task);
    let suppressClick = false;
    const isControl = (target: EventTarget | null): boolean => isHTMLElement(target) && Boolean(target.closest("button, a, input"));
    const focusTitle = (clientX?: number, clientY?: number): void => {
      title.focus({ preventScroll: true });
      const selection = window.getSelection();
      if (!selection) return;
      let range: Range | null = null;
      if (clientX !== undefined && clientY !== undefined) {
        const caretDocument = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
        const position = caretDocument.caretPositionFromPoint?.(clientX, clientY);
        if (position && title.contains(position.offsetNode)) {
          range = document.createRange();
          range.setStart(position.offsetNode, position.offset);
          range.collapse(true);
        }
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(title);
        range.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(range);
    };

    row.addEventListener("click", event => {
      if (suppressClick) {
        suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (isControl(event.target)) return;
      const selection = window.getSelection();
      const hasTitleSelection = Boolean(selection && !selection.isCollapsed
        && ((selection.anchorNode && title.contains(selection.anchorNode)) || (selection.focusNode && title.contains(selection.focusNode))));
      if (this.editingTaskKey === key && title.contains(event.target as Node)) return;
      if (event.shiftKey && groupable) {
        event.preventDefault();
        this.selectTask(task, true, true, sourceScope);
        this.syncSelectionClasses();
        void this.refreshDetailPanel();
        return;
      }
      this.selectTask(task, groupable, false, sourceScope);
      this.syncSelectionClasses();
      void this.refreshDetailPanel();
      if (!title.contains(event.target as Node) && !hasTitleSelection) focusTitle();
    }, { capture: true });

    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.selectedKeys.has(key)) {
        this.selectTask(task, groupable, false, sourceScope);
        this.syncSelectionClasses();
        void this.refreshDetailPanel();
      }
      this.showSelectedTasksMenu(event, task);
    });

    if (!groupable) return;
    row.addEventListener("dragstart", event => event.preventDefault());
    row.addEventListener("pointerdown", downEvent => {
      if (downEvent.button !== 0 || isControl(downEvent.target) || downEvent.shiftKey) return;
      const startedInTitle = title.contains(downEvent.target as Node);
      if (!startedInTitle) downEvent.preventDefault();
      const startX = downEvent.clientX;
      const startY = downEvent.clientY;
      const sourceLeft = row.getBoundingClientRect().left;
      let dragging = false;
      let selectingText = false;
      let movedAfterHold = false;
      let dragOverlay: HTMLElement | null = null;
      let targetRow: HTMLElement | null = null;
      let targetGroup: HTMLElement | null = null;
      let dropAfter = false;
      let dropScope = sourceScope;
      let dropTargetKey: string | undefined;
      let hasDropTarget = false;

      const clearTarget = (): void => {
        targetRow?.removeClass("is-drop-before", "is-drop-after");
        targetGroup?.removeClass("is-drag-over");
        targetRow = null;
        targetGroup = null;
      };
      const positionOverlay = (clientY: number): void => {
        if (!dragOverlay) return;
        const width = dragOverlay.getBoundingClientRect().width;
        const height = dragOverlay.getBoundingClientRect().height;
        const left = Math.max(8, Math.min(sourceLeft, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(clientY + 14, window.innerHeight - height - 8));
        dragOverlay.setCssStyles({ transform: `translate3d(${left}px, ${top}px, 0)` });
      };
      const removeOverlay = (): void => {
        dragOverlay?.remove();
        dragOverlay = null;
        document.body.removeClass("calm-drag-active");
      };
      const updateTarget = (event: PointerEvent): void => {
        clearTarget();
        hasDropTarget = false;
        const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
        if (!hit) return;
        let candidates: HTMLElement[] = [];
        let group: HTMLElement | null = null;
        if (canChangeGroup) {
          group = hit.closest<HTMLElement>(".calm-group");
          if (!group?.dataset.groupId) return;
          dropScope = group.dataset.groupId;
          candidates = Array.from(group.querySelectorAll<HTMLElement>('.calm-task[data-groupable="true"]'))
            .filter(candidate => candidate.dataset.orderScope === dropScope);
        } else {
          const scopeTarget = hit.closest<HTMLElement>("[data-order-scope]");
          if (scopeTarget?.dataset.orderScope !== sourceScope) return;
          dropScope = sourceScope;
          candidates = Array.from(this.contentEl.querySelectorAll<HTMLElement>('.calm-task[data-groupable="true"]'))
            .filter(candidate => candidate.dataset.orderScope === sourceScope);
        }
        const draggedKeys = this.selectedKeys.has(key) ? this.selectedKeys : new Set([key]);
        candidates = candidates.filter(candidate => Boolean(candidate.dataset.taskKey) && !draggedKeys.has(candidate.dataset.taskKey ?? ""));
        if (candidates.length) {
          const before = candidates.find(candidate => {
            const rect = candidate.getBoundingClientRect();
            return event.clientY < rect.top + rect.height / 2;
          });
          const candidate = before ?? candidates[candidates.length - 1];
          if (!candidate) return;
          hasDropTarget = true;
          targetRow = candidate;
          dropTargetKey = candidate.dataset.taskKey;
          dropAfter = !before;
          candidate.toggleClass("is-drop-after", dropAfter);
          candidate.toggleClass("is-drop-before", !dropAfter);
        } else if (canChangeGroup && group && dropScope !== sourceScope) {
          hasDropTarget = true;
          targetGroup = group;
          dropTargetKey = undefined;
          group.addClass("is-drag-over");
        }
      };
      const activateDrag = (clientX: number, clientY: number): void => {
        if (dragging) return;
        dragging = true;
        suppressClick = true;
        if (this.selectionScope !== sourceScope || !this.selectedKeys.has(key)) {
          this.selectedKeys = new Set([key]);
          this.selectionAnchor = key;
          this.selectionScope = sourceScope;
          this.syncSelectionClasses();
        }
        this.keyboardTargetKey = key;
        this.keyboardTargetScope = sourceScope;
        window.getSelection()?.removeAllRanges();
        row.addClass("is-dragging", "is-pointer-dragging");
        document.body.addClass("calm-drag-active");
        dragOverlay = row.cloneNode(true) as HTMLElement;
        dragOverlay.removeClass("is-dragging", "is-pointer-dragging", "is-drop-before", "is-drop-after");
        dragOverlay.addClass("calm-drag-overlay");
        dragOverlay.removeAttribute("tabindex");
        dragOverlay.removeAttribute("data-task-key");
        dragOverlay.dataset.depth = "0";
        const rowStyle = window.getComputedStyle(row);
        dragOverlay.setCssProps({
          "--task-depth": "0",
          "--calm-task-spacing": rowStyle.getPropertyValue("--calm-task-spacing").trim() || "3px",
          "--calm-task-line-height": rowStyle.getPropertyValue("--calm-task-line-height").trim() || "15px",
          "--calm-subtask-circle-opacity": rowStyle.getPropertyValue("--calm-subtask-circle-opacity").trim() || ".4"
        });
        dragOverlay.setCssStyles({ width: `${row.getBoundingClientRect().width}px` });
        dragOverlay.querySelectorAll<HTMLElement>("[contenteditable]").forEach(element => element.setAttribute("contenteditable", "false"));
        const count = this.selectedKeys.size;
        if (count > 1) dragOverlay.createSpan({ cls: "calm-drag-count", text: String(count) });
        document.body.appendChild(dragOverlay);
        positionOverlay(clientY);
      };
      const holdTimer = startedInTitle ? undefined : window.setTimeout(() => activateDrag(startX, startY), 300);
      const clearHoldTimer = (): void => {
        if (holdTimer !== undefined) window.clearTimeout(holdTimer);
      };
      const move = (event: PointerEvent): void => {
        if (!dragging) {
          const deltaX = event.clientX - startX;
          const deltaY = event.clientY - startY;
          const distanceX = Math.abs(deltaX);
          const distanceY = Math.abs(deltaY);
          if (startedInTitle) {
            if (!selectingText && Math.max(distanceX, distanceY) >= 5) {
              if (distanceX >= distanceY) selectingText = true;
              else activateDrag(event.clientX, event.clientY);
            }
            if (selectingText || !dragging) return;
          } else if (Math.hypot(deltaX, deltaY) >= 5) {
            clearHoldTimer();
            activateDrag(event.clientX, event.clientY);
          } else {
            event.preventDefault();
            return;
          }
        }
        event.preventDefault();
        movedAfterHold = true;
        positionOverlay(event.clientY);
        updateTarget(event);
      };
      const finish = (event: PointerEvent): void => {
        clearHoldTimer();
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", cancel, true);
        if (!dragging) {
          this.selectTask(task, true, false, sourceScope);
          this.syncSelectionClasses();
          void this.refreshDetailPanel();
          if (selectingText) {
            suppressClick = true;
            window.setTimeout(() => { suppressClick = false; }, 0);
          }
          if (!startedInTitle) focusTitle(startX, startY);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const keys = this.selectedKeys.has(key) ? Array.from(this.selectedKeys) : [key];
        row.removeClass("is-dragging", "is-pointer-dragging");
        removeOverlay();
        clearTarget();
        if (movedAfterHold && hasDropTarget) {
          void this.activeTitleCommit?.(false);
          const committedKeys = this.selectedKeys.size ? Array.from(this.selectedKeys) : keys;
          void this.moveTaskKeys(committedKeys, dropScope, dropTargetKey, dropAfter, canChangeGroup);
        }
      };
      const cancel = (): void => {
        clearHoldTimer();
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", cancel, true);
        row.removeClass("is-dragging", "is-pointer-dragging");
        removeOverlay();
        clearTarget();
      };
      window.addEventListener("pointermove", move, { capture: true, passive: false });
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", cancel, true);
    });
  }

  private caretRectIn(title: HTMLElement): DOMRect | undefined {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return undefined;
    const range = selection.getRangeAt(0);
    if (!title.contains(range.startContainer)) return undefined;
    const rects = range.getClientRects();
    return rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  }

  private captureEditingCaret(): void {
    this.restoreEditingCaret = undefined;
    const active = document.activeElement;
    const title = active?.instanceOf(HTMLElement) && active.matches('.calm-task-title[contenteditable="true"]') ? active : undefined;
    const row = title?.closest<HTMLElement>(".calm-task");
    const taskKey = row?.dataset.taskKey;
    const selection = window.getSelection();
    if (!title || !taskKey || !selection?.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!title.contains(range.startContainer)) return;
    const preceding = document.createRange();
    preceding.selectNodeContents(title);
    preceding.setEnd(range.startContainer, range.startOffset);
    this.restoreEditingCaret = { taskKey, offset: preceding.toString().length };
  }

  private placeCaretAtTextOffset(title: HTMLElement, requestedOffset: number): void {
    title.focus({ preventScroll: true });
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, requestedOffset);
    let node: Text | undefined;
    let offset = 0;
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const text = current as Text;
      node = text;
      if (remaining <= text.data.length) { offset = remaining; break; }
      remaining -= text.data.length;
      offset = text.data.length;
    }
    const range = document.createRange();
    if (node) range.setStart(node, Math.min(offset, node.data.length));
    else range.selectNodeContents(title);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    title.scrollIntoView({ block: "nearest" });
  }

  private shouldLeaveTitleWithArrow(title: HTMLElement, direction: -1 | 1): boolean {
    const caret = this.caretRectIn(title);
    if (!caret) return false;
    const bounds = title.getBoundingClientRect();
    const lineHeight = Number.parseFloat(window.getComputedStyle(title).lineHeight) || 15;
    if (direction < 0) return caret.top <= bounds.top + lineHeight * .55;
    return caret.bottom >= bounds.bottom - lineHeight * .55;
  }

  private async moveEditingFocus(title: HTMLElement, direction: -1 | 1, commit: (renderAfter?: boolean) => Promise<void>): Promise<void> {
    const titles = Array.from(this.contentEl.querySelectorAll<HTMLElement>('.calm-task-title[contenteditable="true"]'))
      .filter(candidate => candidate.getClientRects().length > 0);
    const currentIndex = titles.indexOf(title);
    const target = titles[currentIndex + direction];
    if (currentIndex < 0 || !target) return;
    const caret = this.caretRectIn(title);
    const desiredX = caret?.left ?? title.getBoundingClientRect().left;
    await commit(false);
    if (!target.isConnected) return;

    target.focus({ preventScroll: true });
    const bounds = target.getBoundingClientRect();
    const lineHeight = Number.parseFloat(window.getComputedStyle(target).lineHeight) || 15;
    const x = Math.max(bounds.left + 1, Math.min(desiredX, bounds.right - 1));
    const y = direction < 0 ? Math.max(bounds.top + 1, bounds.bottom - lineHeight / 2) : Math.min(bounds.bottom - 1, bounds.top + lineHeight / 2);
    const caretDocument = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let range: Range | null = null;
    const position = caretDocument.caretPositionFromPoint?.(x, y);
    if (position && target.contains(position.offsetNode)) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(direction > 0);
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    target.scrollIntoView({ block: "nearest" });

    const row = target.closest<HTMLElement>(".calm-task");
    const targetKey = row?.dataset.taskKey;
    const path = row?.dataset.taskPath;
    const line = Number(row?.dataset.taskLine);
    const liveTasks = flattenTasks(this.viewRoots());
    const targetTask = (targetKey ? liveTasks.find(item => this.taskGroupKey(item) === targetKey) : undefined)
      ?? (!targetKey && path && Number.isInteger(line) ? liveTasks.find(item => item.path === path && item.line === line) : undefined);
    if (targetTask && row) {
      this.selectTask(targetTask, row.dataset.groupable === "true", false, row.dataset.orderScope);
      this.syncSelectionClasses();
      const detail = this.contentEl.querySelector<HTMLElement>(".calm-detail");
      if (detail && this.getSettings().showDetailPanel) void this.renderDetailInto(detail);
    }
  }

  private syncSelectionClasses(): void {
    this.uiRevision += 1;
    this.contentEl.querySelectorAll<HTMLElement>(".calm-task").forEach(row => {
      const selected = Boolean(row.dataset.taskKey && this.selectedKeys.has(row.dataset.taskKey));
      row.toggleClass("is-selected", selected);
      row.toggleClass("is-multi-selected", selected);
    });
  }

  private enableDetailTitleEditing(task: TaskItem, title: HTMLElement): void {
    const key = this.taskGroupKey(task);
    let initialText = "";
    let finished = false;
    const save = async (renderAfter = true): Promise<void> => {
      if (finished) return;
      finished = true;
      const nextTitle = serializeInlineMarkdown(title);
      if (nextTitle && nextTitle !== initialText) {
        await this.run(() => this.renameTask(task, this.withInlineMetadata(task, nextTitle)));
      }
      if (this.editingTaskKey === key) {
        this.editingTaskKey = undefined;
        this.pendingStoreRender = false;
        if (this.activeTitleCommit === save) this.activeTitleCommit = undefined;
        if (renderAfter) await this.render();
      }
    };
    title.addEventListener("focus", () => {
      finished = false;
      initialText = serializeInlineMarkdown(title);
      this.editingTaskKey = key;
      this.activeTitleCommit = save;
    });
    title.addEventListener("input", () => this.syncDetailTitleToList(task, serializeInlineMarkdown(title)));
    title.addEventListener("blur", () => window.setTimeout(() => void save(), 0));
    title.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); title.blur(); }
      if (event.key === "Escape") {
        event.preventDefault();
        finished = true;
        if (this.editingTaskKey === key) this.editingTaskKey = undefined;
        this.pendingStoreRender = false;
        if (this.activeTitleCommit === save) this.activeTitleCommit = undefined;
        void this.render();
      }
    });
  }

  private enableMarkdownLinkPaste(title: HTMLElement): void {
    const revealLink = (link: HTMLAnchorElement, focusNode?: Node, focusOffset?: number): void => {
      const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
      if (!/^https?:\/\//iu.test(href)) return;
      let labelOffset = link.textContent?.length ?? 0;
      if (focusNode && link.contains(focusNode) && focusOffset !== undefined) {
        const prefix = document.createRange();
        prefix.selectNodeContents(link);
        try {
          prefix.setEnd(focusNode, focusOffset);
          labelOffset = prefix.toString().length;
        } catch { /* Keep the end-of-label fallback for a stale DOM position. */ }
      }
      const holder = createDiv();
      holder.appendChild(link.cloneNode(true));
      const markdown = serializeInlineMarkdown(holder);
      const raw = document.createTextNode(markdown);
      link.replaceWith(raw);
      title.focus({ preventScroll: true });
      const caret = document.createRange();
      // External Markdown links begin with `[`. Put the caret at the same
      // character within the now-visible label.
      caret.setStart(raw, Math.min(markdown.length, 1 + labelOffset));
      caret.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
    };

    title.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !isHTMLElement(event.target)) return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!link || !title.contains(link)) return;
      const caretDocument = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
      const position = caretDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      revealLink(link, position?.offsetNode, position?.offset);
    }, { capture: true });

    title.addEventListener("keyup", event => {
      if (!/^(?:ArrowLeft|ArrowRight|Home|End)$/u.test(event.key)) return;
      const selection = window.getSelection();
      if (!selection?.isCollapsed || !selection.focusNode) return;
      const parent = selection.focusNode.instanceOf(HTMLElement) ? selection.focusNode : selection.focusNode.parentElement;
      const link = parent?.closest<HTMLAnchorElement>("a[href]");
      if (link && title.contains(link)) revealLink(link, selection.focusNode, selection.focusOffset);
    });

    title.addEventListener("paste", event => {
      const url = pastedExternalUrl(event);
      const selection = window.getSelection();
      if (!url || !selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!title.contains(range.startContainer) || !title.contains(range.endContainer)) return;
      const label = selection.toString();
      if (!label.trim()) return;

      event.preventDefault();
      event.stopPropagation();
      const markdown = `[${label}](${url})`;
      // Electron's editing command records this replacement in the native
      // contenteditable undo stack, unlike direct Range DOM mutations.
      // Keep the compatibility call isolated: no modern contenteditable API
      // can add a programmatic replacement to the native undo stack.
      const editingDocument = document as unknown as { execCommand: (command: string, showUi: boolean, value: string) => boolean };
      if (!editingDocument.execCommand("insertText", false, markdown)) {
        range.deleteContents();
        const raw = document.createTextNode(markdown);
        range.insertNode(raw);
        range.setStartAfter(raw);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        title.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: markdown }));
      }
    });
  }

  private enableDetailExternalLinks(title: HTMLElement): void {
    title.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(link => {
      const href = link.getAttribute("href")?.trim();
      if (!href || !/^https?:\/\//iu.test(href)) return;
      link.setAttrs({ target: "_blank", rel: "noopener noreferrer" });
      link.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        window.open(href, "_blank", "noopener,noreferrer");
      });
    });
  }

  private syncDetailTitleToList(task: TaskItem, value: string): void {
    const row = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-task-path][data-task-line]"))
      .find(candidate => candidate.dataset.taskPath === task.path && Number(candidate.dataset.taskLine) === task.line);
    const listTitle = row?.querySelector<HTMLElement>(".calm-task-title");
    if (!listTitle || listTitle === document.activeElement) return;
    const logicalTitle = logicalInlineTitle(value);
    const separator = listTitle.querySelector<HTMLElement>(":scope > .calm-inline-meta-separator");
    if (!separator) {
      listTitle.setText(logicalTitle);
    } else {
      let node = listTitle.firstChild;
      while (node && node !== separator) {
        const next = node.nextSibling;
        node.remove();
        node = next;
      }
      listTitle.insertBefore(document.createTextNode(`${logicalTitle} `), separator);
    }
    listTitle.toggleClass("is-empty-title", !logicalTitle);
  }

  private withInlineMetadata(task: TaskItem, title: string): string {
    let value = title.trim();
    inlineMetadataOrder(task).forEach(kind => {
      if (kind === "due" && task.dates.due) value += ` | ${task.dates.due}`;
      if (kind === "priority" && task.priorityLabel) value += ` | ${task.priorityLabel}`;
    });
    return value;
  }

  private async renameTask(task: TaskItem, nextTitle: string): Promise<void> {
    const settings = this.getSettings();
    const assignments = settings.groupAssignments;
    const previousKey = this.taskGroupKey(task);
    const groupId = assignments[previousKey] ?? assignments[this.taskBaseKey(task)];
    const storedNextTitle = preserveTaskComments(task.title, nextTitle);
    const logicalTitle = storedNextTitle
      .replace(/(?:\s*\|\s*(?:\d{4}-\d{2}-\d{2}|[A-D]))+(?=\s*$)/gu, "")
      .replace(/(?:^|\s)\[[A-D]\](?=\s|$)/gu, "")
      .replace(/\s{2,}/g, " ").trim();
    const nextKey = this.taskGroupKey({ ...task, title: logicalTitle });
    await this.store.rename(task, storedNextTitle);
    const previousChildScope = `__children__:${previousKey}`;
    const nextChildScope = `__children__:${nextKey}`;
    if (settings.taskOrder[previousChildScope]) {
      settings.taskOrder[nextChildScope] = settings.taskOrder[previousChildScope];
      delete settings.taskOrder[previousChildScope];
    }
    if (groupId) {
      delete assignments[previousKey];
      assignments[nextKey] = groupId;
    }
    Object.values(settings.taskOrder).forEach(order => {
      const index = order.indexOf(previousKey);
      if (index >= 0) order[index] = nextKey;
    });
    if (this.selectedKeys.delete(previousKey)) this.selectedKeys.add(nextKey);
    if (this.selectedTask?.key === previousKey) this.selectedTask.key = nextKey;
    if (this.sessionCompleted.delete(previousKey)) this.sessionCompleted.add(nextKey);
    if (this.selectionAnchor === previousKey) this.selectionAnchor = nextKey;
    if (this.keyboardTargetKey === previousKey) this.keyboardTargetKey = nextKey;
    if (this.restoreEditingCaret?.taskKey === previousKey) this.restoreEditingCaret.taskKey = nextKey;
    if (this.selectionScope === previousChildScope) this.selectionScope = nextChildScope;
    if (this.keyboardTargetScope === previousChildScope) this.keyboardTargetScope = nextChildScope;
    await this.saveSettings();
    await this.store.refreshFiles([task.path]);
  }

  private async toggleTask(task: TaskItem): Promise<void> {
    const key = this.taskGroupKey(task);
    const wasSessionCompleted = this.sessionCompleted.has(key);
    // Keep a task whose status changed in the current session visible while the
    // background vault refresh catches up. This also prevents a reopened task
    // from briefly dropping out of a completed-only result set.
    this.sessionCompleted.add(key);
    if (this.pendingCreatedTasks.includes(task)) {
      const wasOpen = task.status === "open";
      task.status = wasOpen ? "done" : "open";
      task.statusChar = wasOpen ? "x" : " ";
      task.dates.completed = wasOpen ? localDate() : undefined;
      this.updateTaskStatusInDom(task);
      return;
    }
    this.taskMutationsInProgress += 1;
    try {
      const operation = this.store.toggle(task);
      // TaskStore applies the optimistic model change synchronously, before its
      // Markdown write awaits. Paint just the affected controls instead of
      // rebuilding the entire workspace.
      this.pendingStoreRender = false;
      this.updateTaskStatusInDom(task);
      await operation;
    } catch (error) {
      if (wasSessionCompleted) this.sessionCompleted.add(key); else this.sessionCompleted.delete(key);
      // TaskStore rolls the model back before rejecting.
      this.updateTaskStatusInDom(task);
      throw error;
    } finally {
      this.taskMutationsInProgress = Math.max(0, this.taskMutationsInProgress - 1);
      // TaskStore has now confirmed the write by reading the source file back.
      // The targeted row already shows that state, so avoid a full-list repaint.
      this.pendingStoreRender = false;
    }
  }

  private updateTaskStatusInDom(task: TaskItem): void {
    this.uiRevision += 1;
    const done = task.status === "done";
    const updateCheckbox = (checkbox: HTMLButtonElement): void => {
      // Obsidian's setIcon appends an SVG; clear the previous icon and hidden
      // label first so repeated optimistic toggles never stack children.
      checkbox.empty();
      setIcon(checkbox, done ? "circle-check-big" : "circle");
      checkbox.createSpan({ cls: "calm-sr-only", text: done ? "Reopen task" : "Complete task" });
    };

    this.contentEl.querySelectorAll<HTMLElement>(".calm-task[data-task-path][data-task-line]").forEach(row => {
      if (row.dataset.taskPath !== task.path || Number(row.dataset.taskLine) !== task.line) return;
      row.toggleClass("is-done", done);
      const checkbox = row.querySelector<HTMLButtonElement>(".calm-checkbox");
      if (checkbox) updateCheckbox(checkbox);
    });

    if (!this.selectedTask) return;
    const selectedKey = this.selectedTask.key;
    if (selectedKey ? selectedKey !== this.taskGroupKey(task) : this.selectedTask.path !== task.path || this.selectedTask.line !== task.line) return;
    const headline = this.contentEl.querySelector<HTMLElement>(".calm-detail-headline");
    if (!headline) return;
    headline.toggleClass("is-done", done);
    const detailCheckbox = headline.querySelector<HTMLButtonElement>(".calm-checkbox");
    if (detailCheckbox) updateCheckbox(detailCheckbox);
  }

  private findSelectedTask(): TaskItem | undefined {
    if (!this.selectedTask) return undefined;
    const tasks = flattenTasks(this.viewRoots());
    const selectedKey = this.selectedTask.key ?? Array.from(this.selectedKeys)[0];
    // Once a stable key is known, never fall back to a Markdown line number.
    // Deleting earlier rows changes line numbers and could otherwise make the
    // caret and highlighted task resolve to two different items.
    const selected = selectedKey
      ? tasks.find(task => this.taskGroupKey(task) === selectedKey)
      : tasks.find(task => task.path === this.selectedTask?.path && task.line === this.selectedTask.line);
    if (selected) {
      const nextKey = this.taskGroupKey(selected);
      if (selectedKey && selectedKey !== nextKey) {
        if (this.selectedKeys.delete(selectedKey)) this.selectedKeys.add(nextKey);
        if (this.selectionAnchor === selectedKey) this.selectionAnchor = nextKey;
        if (this.keyboardTargetKey === selectedKey) this.keyboardTargetKey = nextKey;
      }
      this.selectedTask.path = selected.path;
      this.selectedTask.line = selected.line;
      this.selectedTask.key = nextKey;
    }
    return selected;
  }

  private async renderDetail(container: HTMLElement): Promise<void> {
    if (this.taskDraft && !this.draftDetailHidden) {
      this.renderTaskDraftDetail(container, this.taskDraft);
      return;
    }
    const task = this.findSelectedTask();
    if (!task) {
      const placeholder = container.createDiv({ cls: "calm-detail-empty" });
      const icon = placeholder.createDiv();
      setIcon(icon, "panel-right");
      placeholder.createDiv({ text: "Select a task to see details" });
      return;
    }

    const top = container.createDiv({ cls: "calm-detail-top" });
    top.createSpan({ text: "Details" });
    const close = top.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Close details" } });
    setIcon(close, "x");
    close.addEventListener("click", () => { this.clearTaskSelection(); void this.render(); });

    const headline = container.createDiv({ cls: `calm-detail-headline ${task.status === "done" ? "is-done" : ""}` });
    const checkbox = headline.createEl("button", { cls: "calm-checkbox" });
    setIcon(checkbox, task.status === "open" ? "circle" : "circle-check-big");
    checkbox.createSpan({ cls: "calm-sr-only", text: task.status === "open" ? "Complete task" : "Reopen task" });
    checkbox.addEventListener("click", () => void this.run(() => this.toggleTask(task)));
    const title = headline.createDiv({ cls: "calm-detail-title markdown-rendered", attr: { contenteditable: "true", spellcheck: "true", role: "textbox" } });
    await MarkdownRenderer.render(this.app, visibleTaskTitle(task.title), title, task.path, this);
    this.enableDetailExternalLinks(title);
    this.enableDetailTitleEditing(task, title);

    if (this.getSettings().detailPanelPosition === "bottom") {
      const row = container.createDiv({ cls: "calm-detail-bottom-row" });
      this.renderDueEditor(row, task);
      this.renderDateActions(row, task);
      this.renderPriorityEditor(row, task);
      this.renderAuxiliaryFields(row, task, true);
      this.renderAuxiliaryFields(row, task, false);
      this.renderSourceField(row, task);
      this.renderTaskNote(container, task);
      return;
    }

    const fields = container.createDiv({ cls: "calm-detail-fields" });
    this.renderDueEditor(fields, task);
    this.renderAuxiliaryFields(fields, task, true);
    this.renderPriorityEditor(fields, task);
    this.renderAuxiliaryFields(fields, task, false);
    this.renderSourceField(fields, task);
    const actions = container.createDiv({ cls: "calm-detail-actions" });
    this.renderDateButtons(actions, task);
    this.renderTaskNote(container, task);
  }

  private renderTaskDraftDetail(container: HTMLElement, draft: TaskDraft): void {
    const top = container.createDiv({ cls: "calm-detail-top" });
    top.createSpan({ text: "Details" });
    const close = top.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Close details" } });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      this.draftDetailHidden = true;
      void this.render();
    });
    const headline = container.createDiv({ cls: "calm-detail-headline" });
    const checkbox = headline.createEl("button", { cls: "calm-checkbox", attr: { tabindex: "-1" } });
    setIcon(checkbox, "circle");
    checkbox.createSpan({ cls: "calm-sr-only", text: "New task" });
    headline.createDiv({ cls: "calm-detail-title calm-detail-draft-title", text: draft.title });
    const fields = container.createDiv({ cls: this.getSettings().detailPanelPosition === "bottom" ? "calm-detail-bottom-row" : "calm-detail-fields" });
    if (draft.due) this.renderDetailField(fields, "calendar-clock", "Due", value => value.createSpan({ text: draft.due as string }));
    if (draft.mode === "priority") this.renderDetailField(fields, "signal-high", "Priority", value => value.createSpan({ text: draft.priority ?? "None" }));
    this.renderDetailField(fields, "file-text", "Source", value => {
      const source = value.createEl("button", { cls: "calm-detail-source", text: this.store.newTaskFilePath() });
      source.addEventListener("click", () => void this.openDraftSource());
    }).addClass("is-source");
  }

  private async openDraftSource(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.store.newTaskFilePath());
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
  }

  private renderTaskNote(container: HTMLElement, task: TaskItem): void {
    const note = task.note?.trim();
    if (!note) return;
    const row = container.createDiv({ cls: "calm-detail-note" });
    const icon = row.createDiv({ cls: "calm-detail-note-icon" });
    setIcon(icon, "notebook-pen");
    row.createDiv({ cls: "calm-detail-note-label", text: "Note" });
    const value = row.createDiv({ cls: "calm-detail-note-value" });
    const urlPattern = /https?:\/\/[^\s]+/gu;
    let cursor = 0;
    for (const match of note.matchAll(urlPattern)) {
      const start = match.index;
      const url = match[0];
      if (start > cursor) value.appendText(note.slice(cursor, start));
      const link = value.createEl("a", { text: url, href: url, attr: { target: "_blank", rel: "noopener noreferrer", draggable: "false" } });
      link.addEventListener("click", event => event.stopPropagation());
      cursor = start + url.length;
    }
    if (cursor < note.length) value.appendText(note.slice(cursor));
    value.addEventListener("contextmenu", event => {
      const link = isHTMLElement(event.target) ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      const selection = window.getSelection();
      const selectedText = selection && !selection.isCollapsed
        && ((selection.anchorNode && value.contains(selection.anchorNode)) || (selection.focusNode && value.contains(selection.focusNode)))
        ? selection.toString()
        : "";
      if (!link && !selectedText) return;
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      if (link) {
        const url = link.href;
        menu.addItem(item => item.setTitle("Copy URL").setIcon("link").onClick(() => this.copyDetailText(url, "URL copied")));
      }
      if (selectedText) {
        menu.addItem(item => item.setTitle("Copy selected text").setIcon("copy").onClick(() => this.copyDetailText(selectedText, "Text copied")));
      }
      menu.showAtMouseEvent(event);
    });
  }

  private copyDetailText(text: string, successMessage: string): void {
    void navigator.clipboard.writeText(text).then(
      () => new Notice(successMessage),
      () => new Notice("Could not copy to the clipboard.")
    );
  }

  private renderDueEditor(fields: HTMLElement, task: TaskItem): void {
    const row = this.renderDetailField(fields, "calendar-clock", "Due", field => {
      const input = field.createEl("input", {
        type: "text",
        value: task.dates.due ?? "",
        placeholder: "YYYY-MM-DD",
        attr: { "aria-label": "Due date", inputmode: "numeric", autocomplete: "off" }
      });
      const saveDue = (): void => {
        const value = input.value.trim();
        if (value === (task.dates.due ?? "")) return;
        if (value && !isValidIsoDate(value)) {
          new Notice("Enter a valid due date in YYYY-MM-DD format.");
          input.value = task.dates.due ?? "";
          return;
        }
        void this.runTaskMutation(() => this.store.setDue(task, value || undefined));
      };
      input.addEventListener("blur", saveDue);
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); input.blur(); }
        if (event.key === "Escape") { event.preventDefault(); input.value = task.dates.due ?? ""; input.blur(); }
      });
    });
    row.addClass("is-due");
  }

  private renderPriorityEditor(fields: HTMLElement, task: TaskItem): void {
    const row = this.renderDetailField(fields, "signal-high", "Priority", field => {
      const choices: Array<["A" | "B" | "C" | "D" | undefined, string]> = [["A", "A"], ["B", "B"], ["C", "C"], ["D", "D"], [undefined, "None"]];
      const control = field.createDiv({ cls: "calm-priority-switch", attr: { role: "group", "aria-label": "Task priority" } });
      choices.forEach(([value, label]) => {
        const selected = task.priorityLabel === value || (!task.priorityLabel && value === undefined);
        const button = control.createEl("button", { cls: selected ? "is-active" : "", text: label, attr: { type: "button", "aria-pressed": String(selected) } });
        const applyPriority = (): void => {
          if (selected) return;
          void this.runTaskMutation(() => this.store.setPriority(task, value));
        };
        button.addEventListener("pointerdown", event => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          event.preventDefault();
          event.stopPropagation();
          applyPriority();
        });
        button.addEventListener("click", event => {
          if (event.detail !== 0) return;
          event.preventDefault();
          applyPriority();
        });
      });
    });
    row.addClass("is-priority");
  }

  private renderAuxiliaryFields(fields: HTMLElement, task: TaskItem, dateFields = false): void {
    if (dateFields) {
      if (task.dates.scheduled) this.renderDetailField(fields, "calendar", "Scheduled", field => field.createSpan({ text: readableDate(task.dates.scheduled as string) }));
      if (task.dates.start) this.renderDetailField(fields, "calendar-range", "Start", field => field.createSpan({ text: readableDate(task.dates.start as string) }));
      if (task.dates.completed) this.renderDetailField(fields, "check-check", "Completed", field => field.createSpan({ text: readableDate(task.dates.completed as string) }));
      return;
    }
    if (task.recurrence) this.renderDetailField(fields, "repeat-2", "Repeat", field => field.createSpan({ text: task.recurrence as string }));
    if (task.tags.length) this.renderDetailField(fields, "tag", "Tags", field => field.createSpan({ text: task.tags.map(tag => `#${tag}`).join("  ") }));
  }

  private renderSourceField(fields: HTMLElement, task: TaskItem): void {
    const row = this.renderDetailField(fields, "file-text", "Source", field => {
      const source = field.createEl("button", { cls: "calm-detail-source", text: task.path });
      source.addEventListener("click", () => void this.openSource(task));
    });
    row.addClass("is-source");
  }

  private renderDateButtons(actions: HTMLElement, task: TaskItem): void {
    const quickDates: Array<[string, number]> = [["Today", 0], ["Tomorrow", 1], ["+3 days", 3], ["+7 days", 7]];
    quickDates.forEach(([label, days]) => {
      const button = actions.createEl("button", { text: label, attr: { type: "button" } });
      const applyDate = (): void => {
        void this.runTaskMutation(() => this.store.setDue(task, addDays(localDate(), days)));
      };
      button.addEventListener("pointerdown", event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        event.stopPropagation();
        applyDate();
      });
      button.addEventListener("click", event => {
        if (event.detail !== 0) return;
        event.preventDefault();
        applyDate();
      });
    });
  }

  private renderDateActions(container: HTMLElement, task: TaskItem): void {
    const actions = container.createDiv({ cls: "calm-detail-actions is-date-only" });
    this.renderDateButtons(actions, task);
  }

  private renderDetailField(container: HTMLElement, iconName: string, label: string, renderValue: (value: HTMLElement) => void): HTMLElement {
    const row = container.createDiv({ cls: "calm-detail-field" });
    const icon = row.createDiv({ cls: "calm-detail-field-icon" });
    setIcon(icon, iconName);
    row.createDiv({ cls: "calm-detail-field-label", text: label });
    const value = row.createDiv({ cls: "calm-detail-field-value" });
    renderValue(value);
    return row;
  }

  private async openSource(task: TaskItem): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { eState: { line: task.line } });
  }

  private renderEmpty(container: HTMLElement): void {
    const empty = container.createDiv({ cls: "calm-empty" });
    const icon = empty.createDiv({ cls: "calm-empty-icon" }); setIcon(icon, "sparkles");
    empty.createEl("h3", { text: "All clear" });
    empty.createDiv({ text: "No tasks match this view." });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) { new Notice(this.taskErrorMessage(error, "Could not update the task.")); }
  }

  private taskErrorMessage(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : fallback;
    if (this.mode === "agenda" && message === "The task moved. Refresh and try again.") {
      return "The task was moved because it no longer has a due date.";
    }
    return message;
  }

  private async runTaskMutation(action: () => Promise<void>): Promise<void> {
    this.taskMutationsInProgress += 1;
    try {
      const operation = action();
      if (this.pendingStoreRender) {
        this.pendingStoreRender = false;
        await this.render();
      }
      await operation;
    } catch (error) {
      new Notice(this.taskErrorMessage(error, "Could not update the task."));
    } finally {
      this.taskMutationsInProgress = Math.max(0, this.taskMutationsInProgress - 1);
      if (this.taskMutationsInProgress === 0 && this.pendingStoreRender) {
        this.pendingStoreRender = false;
        void this.render();
      }
    }
  }
}
