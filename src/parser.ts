import { TaskItem, TaskPriority } from "./types";

const TASK_RE = /^(\s*)([-*+]\s+\[([^\]])\](?:\s+)?)(.*)$/;
const NOTE_RE = /^(\s*)(?:[-*+]\s+)?Note:\s*(.+)$/iu;
const DATE_META: Array<[key: "due" | "scheduled" | "start" | "completed", re: RegExp]> = [
  ["due", /📅\s*(\d{4}-\d{2}-\d{2})/u],
  ["scheduled", /⏳\s*(\d{4}-\d{2}-\d{2})/u],
  ["start", /🛫\s*(\d{4}-\d{2}-\d{2})/u],
  ["completed", /✅\s*(\d{4}-\d{2}-\d{2})/u]
];
const PRIORITIES: Array<[string, TaskPriority]> = [
  ["⏫", "highest"], ["🔺", "highest"], ["🔼", "high"],
  ["🔽", "low"], ["⏬", "lowest"]
];
const INLINE_METADATA = /((?:\s*\|\s*(?:\d{4}-\d{2}-\d{2}|[A-D]))+)(?=\s*(?:✅|📅|⏳|🛫|🔁|$))/u;
const LEGACY_INLINE_DATE = /(?:^|\s)\|\s*(\d{4}-\d{2}-\d{2})(?=\s*\[[A-D]\])/u;
const LEGACY_PRIORITY = /(?:^|\s)\[([A-D])\](?=\s|$)/u;

function cleanTitle(value: string): string {
  return value
    .replace(/<!--\s*mst:[a-z0-9]+\s*-->/giu, "")
    .replace(/(?:\s*\|\s*(?:\d{4}-\d{2}-\d{2}|[A-D]))+(?=\s*(?:✅|📅|⏳|🛫|🔁|$))/gu, "")
    .replace(/\s*\|\s*\d{4}-\d{2}-\d{2}(?=\s*\[[A-D]\])/gu, "")
    .replace(/(?:📅|⏳|🛫|✅)\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/🔁\s*.+?(?=(?:📅|⏳|🛫|✅|⏫|🔺|🔼|🔽|⏬|\[[A-D]\]|\|\s*[A-D])|$)/gu, "")
    .replace(/[⏫🔺🔼🔽⏬]/gu, "")
    .replace(/(?:^|\s)\[([A-D])\](?=\s|$)/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseTasks(path: string, content: string, includeEmptyTasks = false): TaskItem[] {
  const tasks: TaskItem[] = [];
  const stack: TaskItem[] = [];
  const lines = content.split("\n");
  let fence: "```" | "~~~" | undefined;

  lines.forEach((rawLine, line) => {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed.startsWith("```") ? "```" : "~~~";
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      return;
    }
    if (fence) return;
    const match = rawLine.match(TASK_RE);
    if (!match) {
      const noteMatch = rawLine.match(NOTE_RE);
      if (noteMatch) {
        const noteIndent = (noteMatch[1] ?? "").replace(/\t/g, "    ").length;
        const note = (noteMatch[2] ?? "").trim();
        for (let index = stack.length - 1; index >= 0; index--) {
          const parent = stack[index];
          if (parent && parent.indent < noteIndent) {
            if (note) parent.note = parent.note ? `${parent.note}\n${note}` : note;
            break;
          }
        }
        return;
      }
      if (/^\S/.test(rawLine) && rawLine.trim()) stack.length = 0;
      return;
    }
    const indentText = match[1] ?? "";
    const matchedMarker = match[2] ?? "- [ ] ";
    const marker = /\s$/u.test(matchedMarker) ? matchedMarker : `${matchedMarker} `;
    const statusChar = match[3] ?? " ";
    const body = match[4] ?? "";
    const syncKey = body.match(/<!--\s*mst:([a-z0-9]+)\s*-->/iu)?.[1]?.toLocaleLowerCase();
    // Microsoft-synchronized tasks keep a stable identity comment at the end
    // of the line. Remove that transport-only marker before parsing visible
    // metadata, otherwise a suffix such as `| B` is no longer at the logical
    // end of the task and is missed by the priority parser.
    const metadataBody = body.replace(/<!--\s*mst:[a-z0-9]+\s*-->/giu, "").trimEnd();
    const indent = indentText.replace(/\t/g, "    ").length;
    const dates: TaskItem["dates"] = {};
    for (const [key, re] of DATE_META) {
      const found = metadataBody.match(re)?.[1];
      if (found) dates[key] = found;
    }
    const inlineMetadata = metadataBody.match(INLINE_METADATA)?.[1] ?? "";
    const inlineMetadataOrder = Array.from(inlineMetadata.matchAll(/\|\s*(\d{4}-\d{2}-\d{2}|[A-D])(?=\s*(?:\||$))/gu), match =>
      /^\d{4}-\d{2}-\d{2}$/u.test(match[1] ?? "") ? "due" as const : "priority" as const
    );
    const inlineDate = inlineMetadata.match(/(?:^|\|)\s*(\d{4}-\d{2}-\d{2})(?=\s*(?:\||$))/u)?.[1]
      ?? metadataBody.match(LEGACY_INLINE_DATE)?.[1];
    if (inlineDate) dates.due = inlineDate;
    let priority: TaskPriority = "normal";
    for (const [emoji, value] of PRIORITIES) if (metadataBody.includes(emoji)) priority = value;
    const priorityLabel = (inlineMetadata.match(/(?:^|\|)\s*([A-D])(?=\s*(?:\||$))/u)?.[1]
      ?? metadataBody.match(LEGACY_PRIORITY)?.[1]) as TaskItem["priorityLabel"];
    if (!inlineMetadataOrder.length) {
      if (inlineDate) inlineMetadataOrder.push("due");
      if (priorityLabel) inlineMetadataOrder.push("priority");
    }
    if (priorityLabel) priority = { A: "highest", B: "high", C: "normal", D: "low" }[priorityLabel] as TaskPriority;
    const recurrence = metadataBody.match(/🔁\s*(.+?)(?=(?:📅|⏳|🛫|✅|⏫|🔺|🔼|🔽|⏬|\[[A-D]\]|\|\s*[A-D])|$)/u)?.[1]?.trim();
    const tags = Array.from(metadataBody.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu), item => item[2]).filter((tag): tag is string => Boolean(tag));
    const title = cleanTitle(metadataBody);
    while (stack.length && (stack[stack.length - 1]?.indent ?? -1) >= indent) stack.pop();
    if (!title && !includeEmptyTasks) return;
    const task: TaskItem = {
      id: syncKey ? `mst:${syncKey}` : `${path}:${line}:${rawLine}`,
      path, line, indent, marker, statusChar,
      status: statusChar === " " ? "open" : "done", syncKey,
      title, rawLine, dates, priority, priorityLabel, inlineMetadataOrder, recurrence, tags, children: []
    };
    const parent = stack[stack.length - 1];
    if (parent) {
      task.parentId = parent.id;
      parent.children.push(task);
    } else tasks.push(task);
    stack.push(task);
  });
  return tasks;
}

export function flattenTasks(tasks: TaskItem[]): TaskItem[] {
  return tasks.flatMap(task => [task, ...flattenTasks(task.children)]);
}

export function taskDate(task: TaskItem): string | undefined {
  return task.dates.due ?? task.dates.scheduled ?? task.dates.start;
}
