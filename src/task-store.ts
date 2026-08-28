import { App, EventRef, TFile, normalizePath } from "obsidian";
import { flattenTasks, parseTasks } from "./parser";
import { CalmTasksSettings, TaskItem } from "./types";

type StoreChange = "optimistic" | "refresh";
type Listener = (change: StoreChange) => void;

export class TaskStore {
  roots: TaskItem[] = [];
  private listeners = new Set<Listener>();
  private eventRefs: EventRef[] = [];
  private refreshTimer?: number;
  private latestReadPaths = new Set<string>();
  private refreshRevision = 0;
  private dueMutationRevisions = new Map<string, number>();
  private priorityMutationRevisions = new Map<string, number>();

  constructor(private app: App, private settings: CalmTasksSettings) {}

  async start(): Promise<void> {
    await this.refresh();
    this.eventRefs.push(this.app.vault.on("create", file => { if (file instanceof TFile && file.extension === "md") this.queueRefresh(file.path); }));
    this.eventRefs.push(this.app.vault.on("modify", file => { if (file instanceof TFile && file.extension === "md") this.queueRefresh(file.path); }));
    this.eventRefs.push(this.app.vault.on("delete", () => this.queueRefresh()));
    this.eventRefs.push(this.app.vault.on("rename", file => this.queueRefresh(file instanceof TFile && file.extension === "md" ? file.path : undefined)));
  }

  stop(): void {
    this.eventRefs.forEach(ref => this.app.vault.offref(ref));
    this.eventRefs = [];
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
  }

  async updateSettings(settings: CalmTasksSettings): Promise<void> {
    this.settings = settings;
    await this.refresh();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange): void { this.listeners.forEach(listener => listener(change)); }

  private queueRefresh(latestPath?: string): void {
    if (latestPath) this.latestReadPaths.add(latestPath);
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 60);
  }

  async refresh(readLatest = false): Promise<void> {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const revision = ++this.refreshRevision;
    const latestPaths = new Set(this.latestReadPaths);
    this.latestReadPaths.clear();
    const files = this.app.vault.getMarkdownFiles().filter(file =>
      !this.settings.excludedFolders.some(folder => file.path === folder || file.path.startsWith(`${folder}/`))
    );
    const newTaskFile = this.newTaskFilePath();
    const parsed = await Promise.all(files.map(async file =>
      parseTasks(file.path, await (readLatest || latestPaths.has(file.path) ? this.app.vault.read(file) : this.app.vault.cachedRead(file)), file.path === newTaskFile)
    ));
    if (revision !== this.refreshRevision) return;
    this.roots = parsed.flat();
    this.emit("refresh");
  }

  async toggle(task: TaskItem): Promise<void> {
    const wasOpen = task.status === "open";
    const next = wasOpen ? "x" : " ";
    const today = this.localDate();
    const previous = { status: task.status, statusChar: task.statusChar, completed: task.dates.completed };
    task.status = wasOpen ? "done" : "open";
    task.statusChar = next;
    task.dates.completed = wasOpen ? today : undefined;
    this.emit("optimistic");
    try {
      await this.mutateLine(task, line => {
        const toggled = line.replace(/^(\s*[-*+]\s+\[)[^\]](\])/, `$1${next}$2`);
        const withoutCompleted = toggled.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/gu, "").trimEnd();
        return wasOpen ? `${withoutCompleted} ✅ ${today}` : withoutCompleted;
      }, false);
    } catch (error) {
      task.status = previous.status;
      task.statusChar = previous.statusChar;
      task.dates.completed = previous.completed;
      this.emit("optimistic");
      throw error;
    }
  }

  async rename(task: TaskItem, nextTitle: string): Promise<void> {
    const metadata = this.metadataSuffix(task, true);
    await this.mutateLine(task, line => line.replace(/^(\s*[-*+]\s+\[[^\]]\])(?:\s+.*)?$/u, (_match, checkbox: string) => `${checkbox} ${nextTitle.trim()}${metadata}`), false);
  }

  newTaskFilePath(): string {
    const configured = this.settings.newTaskFile.trim() || "Calm Tasks.md";
    const withExtension = configured.toLowerCase().endsWith(".md") ? configured : `${configured}.md`;
    return normalizePath(withExtension.replace(/^\/+|\/+$/gu, ""));
  }

  async createTask(body: string): Promise<TaskItem> {
    const path = this.newTaskFilePath();
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folder) {
      let current = "";
      for (const segment of folder.split("/").filter(Boolean)) {
        current = current ? `${current}/${segment}` : segment;
        if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
      }
    }
    const line = `- [ ] ${body.trim()}`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, content => `${content}${content && !content.endsWith("\n") ? "\n" : ""}${line}\n`);
    } else if (existing) {
      throw new Error(`A folder already exists at ${path}.`);
    } else {
      await this.app.vault.create(path, `${line}\n`);
    }
    await this.refresh(true);
    const matches = flattenTasks(this.roots).filter(task => task.path === path && task.rawLine === line);
    const created = matches[matches.length - 1];
    if (!created) throw new Error("The task was saved but could not be reopened.");
    return created;
  }

  async deleteTask(task: TaskItem): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(task.path);
    if (!(target instanceof TFile)) throw new Error(`File not found: ${task.path}`);
    await this.app.vault.process(target, content => {
      const lines = content.split("\n");
      let index = lines[task.line] === task.rawLine ? task.line : lines.indexOf(task.rawLine);
      if (index < 0) throw new Error("The task moved. Refresh and try again.");
      lines.splice(index, 1);
      return lines.join("\n");
    });
    await this.refresh(true);
  }

  async setDue(task: TaskItem, date?: string): Promise<void> {
    const mutationKey = `${task.path}:${task.line}`;
    const revision = (this.dueMutationRevisions.get(mutationKey) ?? 0) + 1;
    this.dueMutationRevisions.set(mutationKey, revision);
    const previousDue = task.dates.due;
    const previousOrder = [...(task.inlineMetadataOrder ?? [])];
    task.dates.due = date;
    task.inlineMetadataOrder = previousOrder.filter((kind, index, items) => kind !== "due" || (date && items.indexOf(kind) === index));
    if (date && !task.inlineMetadataOrder.includes("due")) task.inlineMetadataOrder.push("due");
    this.emit("optimistic");
    try {
      await this.mutateLine(task, line => this.rebuildTaskLine(line, task, date, task.priorityLabel), false);
    } catch (error) {
      if (this.dueMutationRevisions.get(mutationKey) === revision) {
        task.dates.due = previousDue;
        task.inlineMetadataOrder = previousOrder;
        this.emit("optimistic");
      }
      throw error;
    }
  }

  async setPriority(task: TaskItem, label?: "A" | "B" | "C" | "D"): Promise<void> {
    const mutationKey = `${task.path}:${task.line}`;
    const revision = (this.priorityMutationRevisions.get(mutationKey) ?? 0) + 1;
    this.priorityMutationRevisions.set(mutationKey, revision);
    const previousLabel = task.priorityLabel;
    const previousPriority = task.priority;
    const previousOrder = [...(task.inlineMetadataOrder ?? [])];
    task.priorityLabel = label;
    task.priority = label ? { A: "highest", B: "high", C: "normal", D: "low" }[label] as TaskItem["priority"] : "normal";
    task.inlineMetadataOrder = previousOrder.filter((kind, index, items) => kind !== "priority" || (label && items.indexOf(kind) === index));
    if (label && !task.inlineMetadataOrder.includes("priority")) task.inlineMetadataOrder.push("priority");
    this.emit("optimistic");
    try {
      await this.mutateLine(task, line => this.rebuildTaskLine(line, task, task.dates.due, label), false);
    } catch (error) {
      if (this.priorityMutationRevisions.get(mutationKey) === revision) {
        task.priorityLabel = previousLabel;
        task.priority = previousPriority;
        task.inlineMetadataOrder = previousOrder;
        this.emit("optimistic");
      }
      throw error;
    }
  }

  private rebuildTaskLine(line: string, task: TaskItem, due?: string, priority?: "A" | "B" | "C" | "D"): string {
    const prefix = line.match(/^(\s*[-*+]\s+\[[^\]]\]\s+)/u)?.[1] ?? task.marker;
    const available = new Set<"due" | "priority">();
    if (due) available.add("due");
    if (priority) available.add("priority");
    const order = (task.inlineMetadataOrder ?? []).filter((kind, index, items) => available.has(kind) && items.indexOf(kind) === index);
    (["due", "priority"] as const).forEach(kind => { if (available.has(kind) && !order.includes(kind)) order.push(kind); });
    const inline = order.map(kind => kind === "due" ? ` | ${due}` : ` | ${priority}`).join("");
    const metadata = this.metadataSuffix({ ...task, dates: { ...task.dates, due }, priorityLabel: priority }, true);
    return `${prefix}${task.title}${inline}${metadata}`;
  }

  private metadataSuffix(task: TaskItem, inlineDueAndPriority = false): string {
    const parts: string[] = [];
    if (task.recurrence) parts.push(`🔁 ${task.recurrence}`);
    if (task.dates.start) parts.push(`🛫 ${task.dates.start}`);
    if (task.dates.scheduled) parts.push(`⏳ ${task.dates.scheduled}`);
    if (task.dates.due && !inlineDueAndPriority) parts.push(`📅 ${task.dates.due}`);
    if (task.dates.completed) parts.push(`✅ ${task.dates.completed}`);
    if (!inlineDueAndPriority) {
      if (task.priorityLabel) parts.push(`| ${task.priorityLabel}`);
      else {
        const priority = { highest: "⏫", high: "🔼", normal: "", low: "🔽", lowest: "⏬" }[task.priority];
        if (priority) parts.push(priority);
      }
    }
    return parts.length ? ` ${parts.join(" ")}` : "";
  }

  private async mutateLine(task: TaskItem, mutation: (line: string) => string, refresh = true): Promise<void> {
    const target = this.app.vault.getAbstractFileByPath(task.path);
    if (!(target instanceof TFile)) throw new Error(`File not found: ${task.path}`);
    let nextRawLine: string | undefined;
    await this.app.vault.process(target, content => {
      const lines = content.split("\n");
      let index = lines[task.line] === task.rawLine ? task.line : lines.indexOf(task.rawLine);
      if (index < 0) {
        const candidates = lines.map((line, i) => ({ line, i })).filter(({ line }) => /^(\s*)[-*+]\s+\[[^\]]\]/.test(line));
        index = candidates.find(({ line }) => line.includes(task.title))?.i ?? -1;
      }
      if (index < 0 || lines[index] === undefined) throw new Error("The task moved. Refresh and try again.");
      nextRawLine = mutation(lines[index] as string);
      lines[index] = nextRawLine;
      return lines.join("\n");
    });
    if (nextRawLine !== undefined) task.rawLine = nextRawLine;
    if (refresh) await this.refresh(true);
  }

  private localDate(): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
