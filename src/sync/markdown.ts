import type { ConflictRecord, GraphList, GraphTask, LocalTask } from "./types";

const LIST_META = /^<!--\s*ms-todo-list-id:(.+?)\s*-->$/;
const TASK_META = /^\s*<!--\s*ms-todo:list-id=(.+?)\s+task-id=(.+?)\s*-->\s*$/;
const SHORT_LIST_META = /^<!--\s*mst-list:([a-z0-9]+)\s*-->$/;
const SHORT_TASK_META = /^\s*<!--\s*mst:([a-z0-9]+)\s*-->\s*$/;
const HEADING_LINE = /^## (?!⚠ Sync Conflicts)(.*?)(?:\s+<!--\s*mst-list:([a-z0-9]+)\s*-->)?\s*$/;
const TASK_LINE = /^- \[([ xX])\] (.*?)(?:\s+<!--\s*mst:([a-z0-9]+)\s*-->)?\s*$/;

/** Stable opaque marker: keeps long Graph IDs out of the Markdown file. */
export function syncMarker(kind: "l" | "t", id: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const input = `${kind}:${id}`;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${kind}${(first >>> 0).toString(36).padStart(7, "0")}${(second >>> 0).toString(36).padStart(7, "0")}`;
}

export function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "");
  return trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
}

export function normalizeNote(note: string): string {
  return note
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
}

export function taskHash(task: Pick<LocalTask, "title" | "completed" | "note">): string {
  return JSON.stringify([task.title.trim(), task.completed, normalizeNote(task.note)]);
}

export function graphToLocal(list: GraphList, task: GraphTask): LocalTask {
  return { listId: list.id, listKey: syncMarker("l", list.id), listName: list.displayName, taskId: task.id, syncKey: syncMarker("t", task.id), title: task.title, completed: task.status === "completed", note: normalizeNote(task.body?.content ?? "") };
}

export function parseMarkdown(content: string): LocalTask[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const tasks: LocalTask[] = [];
  let listName = "";
  let listId: string | undefined;
  let listKey: string | undefined;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const currentLine = lines[i];
    if (currentLine === undefined) continue;
    if (/^```/.test(currentLine)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const heading = currentLine.match(HEADING_LINE);
    if (heading) { listName = (heading[1] ?? "").trim(); listId = undefined; listKey = heading[2]; continue; }
    const listMeta = currentLine.match(LIST_META);
    if (listMeta && listName) { listId = (listMeta[1] ?? "").trim(); continue; }
    const shortListMeta = currentLine.match(SHORT_LIST_META);
    if (shortListMeta && listName) { listKey = shortListMeta[1]; continue; }
    const match = currentLine.match(TASK_LINE);
    if (!match || !listName) continue;
    const task: LocalTask = { listId, listKey, listName, syncKey: match[3], title: (match[2] ?? "").trim(), completed: (match[1] ?? "").toLowerCase() === "x", note: "" };
    for (let j = i + 1; j < lines.length; j++) {
      const detailLine = lines[j];
      if (detailLine === undefined || TASK_LINE.test(detailLine) || /^## /.test(detailLine)) break;
      const note = detailLine.match(/^ {2}- Note:(?: (.*))?$/);
      if (note) {
        const noteLines = [note[1] ?? ""];
        let k = j + 1;
        while (k < lines.length) {
          const continuation = lines[k];
          if (continuation === undefined || (!/^ {4}/.test(continuation) && continuation !== "")) break;
          if (TASK_META.test(continuation)) break;
          noteLines.push(/^ {4}/.test(continuation) ? continuation.slice(4) : "");
          k++;
        }
        task.note = normalizeNote(noteLines.join("\n"));
      }
      const meta = detailLine.match(TASK_META);
      if (meta) { task.listId = (meta[1] ?? "").trim(); task.taskId = (meta[2] ?? "").trim(); }
      const shortMeta = detailLine.match(SHORT_TASK_META);
      if (shortMeta) task.syncKey = shortMeta[1];
    }
    tasks.push(task);
  }
  return tasks;
}

function renderTask(task: LocalTask): string[] {
  const marker = task.syncKey ? ` <!-- mst:${task.syncKey} -->` : "";
  const result = [`- [${task.completed ? "x" : " "}] ${task.title}${marker}`];
  const normalizedNote = normalizeNote(task.note);
  if (normalizedNote) {
    const noteLines = normalizedNote.split("\n");
    result.push(`  - Note: ${noteLines[0]}`);
    for (const line of noteLines.slice(1)) result.push(`    ${line}`);
  }
  return result;
}

export function renderMarkdown(lists: GraphList[], tasksByList: Map<string, LocalTask[]>, conflicts: ConflictRecord[]): string {
  const lines = ["---", "cssclasses: [ms-todo-sync-note]", "---", "", "# Microsoft To Do", ""];
  for (const list of lists) {
    lines.push(`## ${list.displayName} <!-- mst-list:${syncMarker("l", list.id)} -->`);
    for (const task of (tasksByList.get(list.id) ?? []).filter((item) => !item.completed)) lines.push(...renderTask(task));
  }
  if (conflicts.length) {
    lines.push("", "# ⚠ Sync Conflicts", "", "아래 항목은 데이터 유실을 막기 위해 보관된 복사본입니다. 확인 후 직접 정리하세요.", "");
    for (const conflict of conflicts.slice(-50)) {
      lines.push(`### ${conflict.createdAt} — ${conflict.reason}`, `List: ${conflict.listName}`, "", "```markdown", conflict.taskMarkdown.replace(/```/g, "` ` `"), "```", "");
    }
  }
  const hasCompleted = [...tasksByList.values()].some((tasks) => tasks.some((task) => task.completed));
  if (hasCompleted) {
    lines.push("", "# Completed");
    for (const list of lists) {
      const completed = (tasksByList.get(list.id) ?? []).filter((task) => task.completed);
      if (!completed.length) continue;
      lines.push(`## ${list.displayName} <!-- mst-list:${syncMarker("l", list.id)} -->`);
      for (const task of completed) lines.push(...renderTask(task));
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function localTaskMarkdown(task: LocalTask): string { return renderTask(task).join("\n"); }
