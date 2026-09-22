import type { TaskStore } from "../task-store";
import type { CalmTasksSettings, TaskItem } from "../types";
import { normalizePath } from "./markdown";

export interface CalmImportCandidate {
  fingerprint: string;
  path: string;
  line: number;
  completed: boolean;
  title: string;
  sourceTitle: string;
  note: string;
  dueDate?: string;
  importance: "low" | "normal" | "high";
  sourceTask: TaskItem;
}

export interface CalmCandidatesResult {
  available: boolean;
  candidates: CalmImportCandidate[];
}

function flatten(tasks: TaskItem[]): TaskItem[] {
  return tasks.flatMap((task) => [task, ...flatten(task.children ?? [])]);
}

function normalizedGroupName(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_–—-]+/gu, "");
}

function visibleCalmTitle(value: string): string {
  return value.replace(/<!--\s*mst:[a-z0-9]+\s*-->/giu, " ").replace(/\s{2,}/gu, " ").trim();
}

function calmTitle(task: TaskItem, dueDate?: string): string {
  const available = new Set<"due" | "priority">();
  if (dueDate) available.add("due");
  if (task.priorityLabel) available.add("priority");
  const order = (task.inlineMetadataOrder ?? []).filter((kind, index, items) => available.has(kind) && items.indexOf(kind) === index);
  (["due", "priority"] as const).forEach((kind) => { if (available.has(kind) && !order.includes(kind)) order.push(kind); });
  const values = order.map((kind) => kind === "due" ? dueDate : task.priorityLabel).filter((value): value is string => Boolean(value));
  return [visibleCalmTitle(task.title), ...values].join(" | ");
}

function calmImportance(label?: "A" | "B" | "C" | "D"): "low" | "normal" | "high" {
  if (label === "A" || label === "B") return "high";
  if (label === "D") return "low";
  return "normal";
}

export function calmImportCandidates(store: TaskStore, settings: CalmTasksSettings, managedPath: string): CalmCandidatesResult {
  const groups = settings.groups ?? [];
  const validGroups = new Set(groups.map((group) => group.id));
  const excludedGroupIds = new Set(
    groups.filter((group) => normalizedGroupName(group.name) === "mstodo").map((group) => group.id)
  );
  const assignments = settings.groupAssignments ?? {};
  const fileAssignments = settings.fileGroupAssignments ?? {};
  const targetPath = normalizePath(managedPath);
  const occurrences = new Map<string, number>();
  const candidates: CalmImportCandidate[] = [];

  for (const task of flatten(store.roots)) {
    if (normalizePath(task.path) === targetPath) continue;
    const groupKey = `${task.path}::${task.title.trim().toLocaleLowerCase()}`;
    const markers = Array.from(task.rawLine.matchAll(/<!--\s*mst:([a-z0-9]+)\s*-->/giu));
    const marker = task.syncKey ?? markers[markers.length - 1]?.[1];
    const explicit = (marker ? assignments[`mst:${marker.toLocaleLowerCase()}`] : undefined) ?? assignments[groupKey];
    const groupId = explicit === "__inbox__"
      ? undefined
      : explicit && validGroups.has(explicit)
        ? explicit
        : fileAssignments[task.path];
    if (groupId && excludedGroupIds.has(groupId)) continue;

    const base = `${task.path}::${task.title.trim().toLocaleLowerCase()}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    const dueDate = task.dates?.due ?? task.dates?.scheduled ?? task.dates?.start;
    candidates.push({
      fingerprint: task.syncKey ? `mst:${task.syncKey}` : `${base}::${occurrence}`,
      path: task.path,
      line: task.line,
      completed: task.status === "done",
      title: calmTitle(task, dueDate),
      sourceTitle: visibleCalmTitle(task.title),
      note: task.note?.trim() ?? "",
      dueDate,
      importance: calmImportance(task.priorityLabel),
      sourceTask: task
    });
  }
  return { available: true, candidates };
}
