export type TaskStatus = "open" | "done";
export type TaskPriority = "highest" | "high" | "normal" | "low" | "lowest";
export type WorkspaceMode = "agenda" | "priority" | "all";

export interface TaskDates {
  due?: string;
  scheduled?: string;
  start?: string;
  completed?: string;
}

export interface TaskItem {
  id: string;
  path: string;
  line: number;
  indent: number;
  marker: string;
  statusChar: string;
  status: TaskStatus;
  title: string;
  rawLine: string;
  dates: TaskDates;
  priority: TaskPriority;
  priorityLabel?: "A" | "B" | "C" | "D";
  inlineMetadataOrder?: Array<"due" | "priority">;
  note?: string;
  recurrence?: string;
  tags: string[];
  parentId?: string;
  children: TaskItem[];
}

export interface TaskFilters {
  status: "open" | "done" | "all";
  date: "any" | "today" | "overdue" | "upcoming" | "none";
  tag: string;
  query: string;
}

export interface CalmTasksSettings {
  upcomingDays: number;
  excludedFolders: string[];
  newTaskFile: string;
  taskSpacingPx: number;
  taskLineHeightPx: number;
  subtaskCircleOpacityPercent: number;
  highlightTaskMetadataInMarkdown: boolean;
  dimCompletedTasksInMarkdown: boolean;
  completedMetadataOpacityPercent: number;
  dailyCompletionArchiveEnabled: boolean;
  dailyCompletionArchiveTime: string;
  preserveDailyNoteTaskPlacement: boolean;
  showDetailPanel: boolean;
  detailPanelPosition: "right" | "bottom";
  groups: TaskGroup[];
  groupAssignments: Record<string, string>;
  fileGroupAssignments: Record<string, string>;
  taskOrder: Record<string, string[]>;
  smartFilters: SmartFilter[];
}

export interface TaskGroup {
  id: string;
  name: string;
}

export interface SmartFilter {
  id: string;
  name: string;
  mode: WorkspaceMode;
  completedRange: "all" | "3days" | "7days" | "30days";
  filters: TaskFilters;
}
