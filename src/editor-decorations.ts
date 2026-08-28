import { Range } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const TASK_PREFIX = /^\s*[-*+]\s+\[([^\]])\]\s+/u;
const INLINE_DATE = /\|\s*(\d{4}-\d{2}-\d{2})(?=\s*(?:\||\[[A-D]\]|✅|📅|⏳|🛫|🔁|$))/u;
const INLINE_PRIORITY = /\|\s*([A-D])(?=\s*(?:\|\s*\d{4}-\d{2}-\d{2}|✅|📅|⏳|🛫|🔁|$))/u;
const LEGACY_PRIORITY = /\[([A-D])\](?=\s*$)/u;

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

function dateClass(value: string): string {
  const today = localDate();
  if (value < today) return "calm-inline-date is-past";
  if (value === today) return "calm-inline-date is-today";
  if (value <= addDays(today, 3)) return "calm-inline-date is-soon";
  return "calm-inline-date";
}

function separatorStart(text: string, pipe: number): number {
  let start = pipe;
  while (start > 0 && /\s/u.test(text[start - 1] ?? "")) start -= 1;
  return start;
}

function editorDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const visited = new Set<number>();
  for (const visible of view.visibleRanges) {
    let line = view.state.doc.lineAt(visible.from);
    while (line.from <= visible.to) {
      if (!visited.has(line.from)) {
        visited.add(line.from);
        const prefix = line.text.match(TASK_PREFIX);
        if (prefix) {
          const completed = prefix[1] !== " ";
          if (completed) {
            ranges.push(Decoration.line({ attributes: { class: "calm-markdown-completed-task" } }).range(line.from));
          }
          const date = line.text.match(INLINE_DATE);
          const priority = line.text.match(INLINE_PRIORITY) ?? line.text.match(LEGACY_PRIORITY);
          if (completed) {
            const metadataStarts = [date, priority].flatMap(match => {
              if (match?.index === undefined || !match[1]) return [];
              const pipe = match[0].includes("|") ? line.text.indexOf("|", match.index) : -1;
              return [pipe >= 0 ? separatorStart(line.text, pipe) : line.text.indexOf(match[1], match.index)];
            }).filter(start => start >= 0);
            const titleStart = prefix[0].length;
            const titleEnd = metadataStarts.length ? Math.min(...metadataStarts) : line.text.length;
            if (titleEnd > titleStart) {
              ranges.push(Decoration.mark({ class: "calm-completed-title-text" }).range(line.from + titleStart, line.from + titleEnd));
            }
          }
          if (date?.index !== undefined && date[1]) {
            const pipe = line.text.indexOf("|", date.index);
            const dateStart = line.text.indexOf(date[1], date.index);
            if (pipe >= 0) ranges.push(Decoration.mark({ class: "calm-inline-meta-separator" }).range(line.from + separatorStart(line.text, pipe), line.from + dateStart));
            ranges.push(Decoration.mark({ class: dateClass(date[1]) }).range(line.from + dateStart, line.from + dateStart + date[1].length));
          }
          if (priority?.index !== undefined && priority[1]) {
            const pipe = priority[0].includes("|") ? line.text.indexOf("|", priority.index) : -1;
            const valueStart = line.text.indexOf(priority[1], priority.index);
            if (pipe >= 0) ranges.push(Decoration.mark({ class: "calm-inline-meta-separator" }).range(line.from + separatorStart(line.text, pipe), line.from + valueStart));
            ranges.push(Decoration.mark({ class: `calm-inline-priority is-${priority[1].toLowerCase()}` }).range(line.from + valueStart, line.from + valueStart + priority[1].length));
          }
        }
      }
      if (line.to >= visible.to || line.number >= view.state.doc.lines) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(ranges.sort((a, b) => a.from - b.from), true);
}

export const calmTaskEditorExtension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) { this.decorations = editorDecorations(view); }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) this.decorations = editorDecorations(update.view);
  }
}, { decorations: plugin => plugin.decorations });

interface StyledRange { from: number; to: number; className: string }

export function decorateRenderedTaskMetadata(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("li.task-list-item").forEach(item => {
    const checkboxState = item.dataset.task;
    const completed = item.hasClass("is-checked") || (checkboxState !== undefined && checkboxState !== "" && checkboxState !== " ");
    item.toggleClass("calm-markdown-completed-task", completed);
    if (item.dataset.calmMetadataStyled === "true") return;
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, {
      acceptNode(node): number {
        const parent = node.parentElement;
        if (!parent || parent.closest("code, pre, .calm-inline-date, .calm-inline-priority")) return NodeFilter.FILTER_REJECT;
        const nestedList = parent.closest("ul, ol");
        if (nestedList && nestedList !== item.parentElement) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes: Array<{ node: Text; from: number; to: number }> = [];
    let text = "";
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const node = current as Text;
      const from = text.length;
      text += node.data;
      nodes.push({ node, from, to: text.length });
    }
    if (!TASK_PREFIX.test(`- [ ] ${text}`)) return;
    const ranges: StyledRange[] = [];
    const date = text.match(INLINE_DATE);
    const priority = text.match(INLINE_PRIORITY) ?? text.match(LEGACY_PRIORITY);
    if (date?.index !== undefined && date[1]) {
      const pipe = text.indexOf("|", date.index);
      const dateStart = text.indexOf(date[1], date.index);
      if (pipe >= 0) ranges.push({ from: separatorStart(text, pipe), to: dateStart, className: "calm-inline-meta-separator" });
      ranges.push({ from: dateStart, to: dateStart + date[1].length, className: dateClass(date[1]) });
    }
    if (priority?.index !== undefined && priority[1]) {
      const pipe = priority[0].includes("|") ? text.indexOf("|", priority.index) : -1;
      const valueStart = text.indexOf(priority[1], priority.index);
      if (pipe >= 0) ranges.push({ from: separatorStart(text, pipe), to: valueStart, className: "calm-inline-meta-separator" });
      ranges.push({ from: valueStart, to: valueStart + priority[1].length, className: `calm-inline-priority is-${priority[1].toLowerCase()}` });
    }
    if (completed) {
      const metadataStart = ranges.length ? Math.min(...ranges.map(range => range.from)) : text.length;
      if (metadataStart > 0) ranges.push({ from: 0, to: metadataStart, className: "calm-completed-title-text" });
    }
    if (!ranges.length) return;
    nodes.forEach(entry => {
      const overlaps = ranges
        .map(range => ({ from: Math.max(0, range.from - entry.from), to: Math.min(entry.to - entry.from, range.to - entry.from), className: range.className }))
        .filter(range => range.from < range.to)
        .sort((a, b) => a.from - b.from);
      if (!overlaps.length || !entry.node.parentNode) return;
      const fragment = createSpan();
      let cursor = 0;
      overlaps.forEach(range => {
        if (range.from > cursor) fragment.append(entry.node.data.slice(cursor, range.from));
        const span = createSpan({ cls: range.className, text: entry.node.data.slice(range.from, range.to) });
        fragment.append(span);
        cursor = range.to;
      });
      if (cursor < entry.node.data.length) fragment.append(entry.node.data.slice(cursor));
      entry.node.replaceWith(...Array.from(fragment.childNodes));
    });
    item.dataset.calmMetadataStyled = "true";
  });
}
