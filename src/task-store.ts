import { App, EventRef, TFile, TFolder, normalizePath } from "obsidian";
import { flattenTasks, parseTasks } from "./parser";
import { CalmTasksSettings, TaskItem } from "./types";

type StoreChange = "optimistic" | "refresh";
type Listener = (change: StoreChange) => void;

export interface MovedTask {
  before: TaskItem;
  after: TaskItem;
}

export class TaskStore {
  roots: TaskItem[] = [];
  private listeners = new Set<Listener>();
  private eventRefs: EventRef[] = [];
  private refreshTimer?: number;
  private latestReadPaths = new Set<string>();
  private fullRefreshRequested = false;
  private rootsByPath = new Map<string, TaskItem[]>();
  private refreshQueue: Promise<void> = Promise.resolve();
  private completionMutationRevisions = new Map<string, number>();
  private dueMutationRevisions = new Map<string, number>();
  private priorityMutationRevisions = new Map<string, number>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private stateRevision = 0;

  constructor(private app: App, private settings: CalmTasksSettings) {}

  async start(): Promise<void> {
    await this.refresh();
    this.eventRefs.push(this.app.vault.on("create", file => { if (file instanceof TFile && file.extension === "md") this.queueRefresh(file.path); }));
    this.eventRefs.push(this.app.vault.on("modify", file => { if (file instanceof TFile && file.extension === "md") this.queueRefresh(file.path); }));
    this.eventRefs.push(this.app.vault.on("delete", file => {
      if (file instanceof TFile && file.extension === "md") this.queueRefresh(file.path);
      else this.queueRefresh();
    }));
    this.eventRefs.push(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile && file.extension === "md") this.queueRefreshPaths([oldPath, file.path]);
      else this.queueRefresh();
    }));
  }

  stop(): void {
    this.eventRefs.forEach(ref => this.app.vault.offref(ref));
    this.eventRefs = [];
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.latestReadPaths.clear();
  }

  async updateSettings(settings: CalmTasksSettings): Promise<void> {
    await this.enqueueMutation(async () => {
      this.settings = settings;
      await this.refresh();
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: StoreChange): void { this.listeners.forEach(listener => listener(change)); }

  private enqueueMutation<T>(action: () => Promise<T>): Promise<T> {
    const tracked = async (): Promise<T> => {
      const result = await action();
      this.stateRevision++;
      return result;
    };
    const operation = this.mutationQueue.then(tracked, tracked);
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Serialize every local write, including optional Microsoft sync commits. */
  runExclusive<T>(action: () => Promise<T>): Promise<T> { return this.enqueueMutation(action); }

  getStateRevision(): number { return this.stateRevision; }

  private queueRefresh(latestPath?: string): void {
    if (latestPath) this.latestReadPaths.add(normalizePath(latestPath));
    else this.fullRefreshRequested = true;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined;
      const paths = Array.from(this.latestReadPaths);
      this.latestReadPaths.clear();
      const refreshAll = this.fullRefreshRequested;
      this.fullRefreshRequested = false;
      void (refreshAll ? this.refresh() : this.refreshFiles(paths));
    }, 60);
  }

  private queueRefreshPaths(paths: Iterable<string>): void {
    for (const path of paths) this.latestReadPaths.add(normalizePath(path));
    this.queueRefresh(Array.from(this.latestReadPaths)[0]);
  }

  private enqueueRefresh(action: () => Promise<void>): Promise<void> {
    const operation = this.refreshQueue.then(action, action);
    this.refreshQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private isIncluded(file: TFile): boolean {
    return file.extension === "md" && !this.settings.excludedFolders.some(folder =>
      file.path === folder || file.path.startsWith(`${folder}/`)
    );
  }

  private publishRoots(): void {
    this.roots = Array.from(this.rootsByPath.values()).flat();
    this.stateRevision++;
    this.emit("refresh");
  }

  async refresh(): Promise<void> {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.latestReadPaths.clear();
    this.fullRefreshRequested = false;
    await this.enqueueRefresh(async () => {
      const files = this.app.vault.getMarkdownFiles().filter(file => this.isIncluded(file));
      const newTaskFile = this.newTaskFilePath();
      const parsed = await Promise.all(files.map(async file => ({
        path: file.path,
        tasks: parseTasks(file.path, await this.app.vault.cachedRead(file), file.path === newTaskFile)
      })));
      this.rootsByPath = new Map(parsed.map(result => [result.path, result.tasks]));
      this.publishRoots();
    });
  }

  async refreshFiles(paths: Iterable<string>): Promise<void> {
    const uniquePaths = Array.from(new Set(Array.from(paths, path => normalizePath(path))));
    if (!uniquePaths.length) return;
    await this.enqueueRefresh(async () => {
      const newTaskFile = this.newTaskFilePath();
      let tasksChanged = false;
      await Promise.all(uniquePaths.map(async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || !this.isIncluded(file)) {
          if ((this.rootsByPath.get(path)?.length ?? 0) > 0) tasksChanged = true;
          this.rootsByPath.delete(path);
          return;
        }
        const previous = this.rootsByPath.get(path) ?? [];
        const next = parseTasks(path, await this.app.vault.read(file), path === newTaskFile);
        if (JSON.stringify(previous) === JSON.stringify(next)) return;
        this.rootsByPath.set(path, next);
        tasksChanged = true;
      }));
      // Editing prose in an ordinary note should not repaint Calm Tasks or
      // invalidate an in-progress Microsoft sync when its task model did not change.
      if (tasksChanged) this.publishRoots();
    });
  }

  async toggle(task: TaskItem): Promise<void> {
    const revision = (this.completionMutationRevisions.get(task.id) ?? 0) + 1;
    this.completionMutationRevisions.set(task.id, revision);
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
      }, true);
    } catch (error) {
      // A later click may already have established a newer optimistic state.
      // Never let an older failed write roll that newer state back.
      if (this.completionMutationRevisions.get(task.id) === revision) {
        task.status = previous.status;
        task.statusChar = previous.statusChar;
        task.dates.completed = previous.completed;
        this.emit("optimistic");
      }
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
    return this.enqueueMutation(async () => {
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
      await this.refreshFiles([path]);
      const matches = flattenTasks(this.roots).filter(task => task.path === path && task.rawLine === line);
      const created = matches[matches.length - 1];
      if (!created) throw new Error("The task was saved but could not be reopened.");
      return created;
    });
  }

  async deleteTask(task: TaskItem): Promise<void> {
    await this.deleteTasks([task]);
  }

  async deleteTasks(tasks: TaskItem[]): Promise<void> {
    await this.enqueueMutation(async () => {
      const tasksByPath = new Map<string, TaskItem[]>();
      tasks.forEach(task => tasksByPath.set(task.path, [...(tasksByPath.get(task.path) ?? []), task]));
      await Promise.all(Array.from(tasksByPath.entries()).map(async ([path, fileTasks]) => {
        const target = this.app.vault.getAbstractFileByPath(path);
        if (!(target instanceof TFile)) throw new Error(`File not found: ${path}`);
        await this.app.vault.process(target, content => {
          const lines = content.split("\n");
          const ordered = [...fileTasks].sort((left, right) => right.line - left.line);
          ordered.forEach(task => {
            let index = lines[task.line] === task.rawLine ? task.line : -1;
            if (index < 0) {
              const candidates = lines
                .map((line, candidateIndex) => line === task.rawLine ? candidateIndex : -1)
                .filter(candidateIndex => candidateIndex >= 0)
                .sort((left, right) => Math.abs(left - task.line) - Math.abs(right - task.line));
              index = candidates[0] ?? -1;
            }
            if (index < 0) throw new Error("A selected task moved. Refresh and try again.");
            lines.splice(index, 1);
          });
          return lines.join("\n");
        });
      }));
      await this.refreshFiles(tasksByPath.keys());
    });
  }

  async moveTasksToDailyNote(tasks: TaskItem[], folderPath: string, heading: string, date = this.localDate()): Promise<MovedTask[]> {
    return this.enqueueMutation(async () => {
      const folder = folderPath.trim().replace(/^\/+|\/+$/gu, "");
      if (!folder) throw new Error("Set a daily notes folder in Calm Tasks settings first.");
      const folderFile = this.app.vault.getAbstractFileByPath(normalizePath(folder));
      if (!(folderFile instanceof TFolder)) throw new Error(`Daily notes folder not found: ${folder}`);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error(`Invalid daily note date: ${date}`);
      const year = date.slice(0, 4);
      const month = date.slice(5, 7);
      const targetPath = normalizePath(`${folder}/${year}/${month}/${date}.md`);
      const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (!(targetFile instanceof TFile)) throw new Error(`Today's daily note was not found: ${targetPath}`);

      const destinationHeading = heading.trim();
      if (destinationHeading && !/^#{1,6}\s+\S/u.test(destinationHeading)) {
        throw new Error("Daily note task heading must be a Markdown heading such as # 오늘의 할 일 or ## To-do.");
      }

      type TaskBlock = { task: TaskItem; path: string; start: number; end: number; lines: string[] };
      const originals = new Map<string, string>();
      const fileForPath = new Map<string, TFile>();
      const uniqueTasks = Array.from(new Map(tasks.map(task => [task.id, task])).values());
      if (!uniqueTasks.length) throw new Error("No tasks were selected to move.");
      if (uniqueTasks.some(task => !task.title.trim())) {
        throw new Error("Finish entering the task title before moving it to the daily note.");
      }
      const blocks: TaskBlock[] = [];

      const contentFor = async (path: string): Promise<string> => {
        const cached = originals.get(path);
        if (cached !== undefined) return cached;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`Source file not found: ${path}`);
        const content = await this.app.vault.read(file);
        originals.set(path, content);
        fileForPath.set(path, file);
        return content;
      };

      for (const task of uniqueTasks) {
        const lines = (await contentFor(task.path)).split("\n");
        let start = lines[task.line] === task.rawLine ? task.line : lines.indexOf(task.rawLine);
        if (start < 0) throw new Error(`A task moved in ${task.path}. Refresh Calm Tasks and try again.`);
        const baseIndent = (lines[start]?.match(/^\s*/u)?.[0] ?? "").replace(/\t/gu, "    ").length;
        let end = start + 1;
        while (end < lines.length) {
          const line = lines[end] ?? "";
          if (!line.trim()) {
            const next = lines.slice(end + 1).find(candidate => candidate.trim());
            const nextIndent = (next?.match(/^\s*/u)?.[0] ?? "").replace(/\t/gu, "    ").length;
            if (next && nextIndent > baseIndent) { end++; continue; }
            break;
          }
          const indent = (line.match(/^\s*/u)?.[0] ?? "").replace(/\t/gu, "    ").length;
          if (indent <= baseIndent) break;
          end++;
        }
        const basePrefix = lines[start]?.match(/^\s*/u)?.[0] ?? "";
        const movedLines = lines.slice(start, end).map(line => {
          // Microsoft markers are transport metadata for the managed sync
          // file. Once a task becomes an ordinary vault task, keep that
          // identity in Calm Tasks settings instead of exposing it in Markdown.
          const markerless = line.replace(/\s*<!--\s*mst:[a-z0-9]+\s*-->/giu, "");
          return markerless.startsWith(basePrefix) ? markerless.slice(basePrefix.length) : markerless;
        });
        blocks.push({ task, path: task.path, start, end, lines: movedLines });
      }

      const retainedBlocks = blocks.filter((candidate, index) => !blocks.some((other, otherIndex) =>
        otherIndex !== index && other.path === candidate.path && other.start <= candidate.start && other.end >= candidate.end
        && (other.start < candidate.start || other.end > candidate.end)
      ));
      const targetOriginal = await contentFor(targetPath);
      fileForPath.set(targetPath, targetFile);
      const updated = new Map(originals);

      const bySource = new Map<string, TaskBlock[]>();
      retainedBlocks.forEach(block => bySource.set(block.path, [...(bySource.get(block.path) ?? []), block]));
      bySource.forEach((sourceBlocks, path) => {
        const lines = (updated.get(path) ?? "").split("\n");
        [...sourceBlocks].sort((left, right) => right.start - left.start).forEach(block => lines.splice(block.start, block.end - block.start));
        updated.set(path, lines.join("\n"));
      });

      const targetLines = (updated.get(targetPath) ?? targetOriginal).split("\n");
      let insertAt: number;
      const configuredHeading = destinationHeading.match(/^(#{1,6})\s+(.+)$/u);
      const exactHeadingIndex = destinationHeading ? targetLines.findIndex(line => line.trim() === destinationHeading) : -1;
      const sameTitleHeadingIndex = configuredHeading && exactHeadingIndex < 0
        ? targetLines.findIndex(line => {
          const candidate = line.trim().match(/^(#{1,6})\s+(.+)$/u);
          return candidate?.[2]?.trim() === configuredHeading[2]?.trim();
        })
        : -1;
      const headingIndex = exactHeadingIndex >= 0 ? exactHeadingIndex : sameTitleHeadingIndex;
      if (headingIndex >= 0) {
        const headingLevel = targetLines[headingIndex]?.trim().match(/^#+/u)?.[0].length ?? 1;
        let sectionEnd = targetLines.length;
        for (let index = headingIndex + 1; index < targetLines.length; index++) {
          const level = targetLines[index]?.trim().match(/^(#{1,6})\s+/u)?.[1]?.length;
          if (level !== undefined && level <= headingLevel) { sectionEnd = index; break; }
        }
        let lastTask = -1;
        for (let index = headingIndex + 1; index < sectionEnd; index++) {
          if (/^\s*[-*+]\s+\[[^\]]\]/u.test(targetLines[index] ?? "")) lastTask = index;
        }
        insertAt = lastTask >= 0 ? lastTask + 1 : headingIndex + 1;
        if (lastTask >= 0) {
          const taskIndent = (targetLines[lastTask]?.match(/^\s*/u)?.[0] ?? "").replace(/\t/gu, "    ").length;
          while (insertAt < sectionEnd) {
            const line = targetLines[insertAt] ?? "";
            if (!line.trim()) break;
            const indent = (line.match(/^\s*/u)?.[0] ?? "").replace(/\t/gu, "    ").length;
            if (indent <= taskIndent) break;
            insertAt++;
          }
        }
      } else {
        while (targetLines.length && !targetLines[targetLines.length - 1]?.trim()) targetLines.pop();
        if (targetLines.length) targetLines.push("");
        insertAt = targetLines.length;
      }

      const orderedBlocks = retainedBlocks.sort((left, right) => uniqueTasks.indexOf(left.task) - uniqueTasks.indexOf(right.task));
      const insertedLines = orderedBlocks.flatMap(block => block.lines);
      const resultLines = new Map<TaskItem, number>();
      let offset = 0;
      orderedBlocks.forEach(block => {
        resultLines.set(block.task, insertAt + offset);
        offset += block.lines.length;
      });
      targetLines.splice(insertAt, 0, ...insertedLines);
      updated.set(targetPath, `${targetLines.join("\n").trimEnd()}\n`);

      const changedPaths = Array.from(updated.keys()).filter(path => updated.get(path) !== originals.get(path));
      const written: string[] = [];
      const rollbackWrittenFiles = async (): Promise<void> => {
        for (const path of [...written].reverse()) {
          const file = fileForPath.get(path);
          if (!file) continue;
          const expected = updated.get(path) ?? "";
          const original = originals.get(path) ?? "";
          await this.app.vault.process(file, current => current === expected ? original : current);
        }
      };
      try {
        for (const path of [targetPath, ...changedPaths.filter(candidate => candidate !== targetPath)]) {
          if (!changedPaths.includes(path)) continue;
          const file = fileForPath.get(path);
          if (!file) throw new Error(`File not found: ${path}`);
          const expected = originals.get(path) ?? "";
          const next = updated.get(path) ?? "";
          await this.app.vault.process(file, current => {
            if (current !== expected) throw new Error(`A file changed while moving tasks: ${path}`);
            return next;
          });
          written.push(path);
        }
      } catch (error) {
        await rollbackWrittenFiles();
        throw error;
      }

      await this.refreshFiles(changedPaths);
      const moved: MovedTask[] = [];
      for (const [before, line] of resultLines) {
        const after = flattenTasks(this.roots).find(task => task.path === targetPath && task.line === line)
          ?? (before.syncKey ? flattenTasks(this.roots).find(task => task.path === targetPath && task.syncKey === before.syncKey) : undefined);
        if (after) moved.push({ before, after });
      }
      if (moved.length !== resultLines.size) {
        await rollbackWrittenFiles();
        await this.refreshFiles(changedPaths);
        throw new Error("Calm Tasks could not verify the daily-note move, so every changed file was restored.");
      }
      return moved;
    });
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
    const metadata = parts.length ? ` ${parts.join(" ")}` : "";
    const marker = task.syncKey ? ` <!-- mst:${task.syncKey} -->` : "";
    return `${metadata}${marker}`;
  }

  private async mutateLine(task: TaskItem, mutation: (line: string) => string, refresh = true): Promise<void> {
    await this.enqueueMutation(async () => {
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
      if (refresh) await this.refreshFiles([task.path]);
    });
  }

  private localDate(): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
