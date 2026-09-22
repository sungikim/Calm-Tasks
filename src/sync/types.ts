export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountLabel?: string;
}

export interface TaskSnapshot {
  listId: string;
  taskId: string;
  localHash: string;
  remoteHash: string;
  remoteModified?: string;
  etag?: string;
  pendingLocalDeleteAt?: number;
  createdAt?: string;
  lastSeenLocalAt?: string;
  lastSeenRemoteAt?: string;
}

export interface DeletionRecord {
  taskId: string;
  listId: string;
  source: "obsidian" | "microsoft";
  detectedAt: string;
  createdAt?: string;
  sourcePath?: string;
  sourceTitle?: string;
}

export interface ConflictRecord {
  createdAt: string;
  reason: string;
  listName: string;
  taskMarkdown: string;
}

export interface CalmImportRecord {
  taskId: string;
  listId: string;
  sourcePath: string;
  sourceLine: number;
  sourceTitle: string;
  createdAt: string;
  sourceHash?: string;
  lastSyncedAt?: string;
  remoteCreatedAt?: string;
}

export interface PluginSettings {
  enabled: boolean;
  legacyMigrated: boolean;
  markdownPath: string;
  clientId: string;
  tenant: string;
  autoSyncMinutes: number;
  fileDebounceMs: number;
  childOpacity: number;
  childFontWeight: number;
  calmImportEnabled: boolean;
  calmTargetListName: string;
  calmImports: Record<string, CalmImportRecord>;
  deletions: Record<string, DeletionRecord>;
  token: TokenSet | null;
  snapshots: Record<string, TaskSnapshot>;
  conflicts: ConflictRecord[];
  lastSyncAt?: string;
  lastSyncMessage?: string;
}

export interface GraphList { id: string; displayName: string; }
export interface GraphTask {
  id: string;
  title: string;
  status: string;
  createdDateTime?: string;
  body?: { content?: string; contentType?: string };
  dueDateTime?: { dateTime?: string; timeZone?: string } | null;
  importance?: "low" | "normal" | "high";
  lastModifiedDateTime?: string;
  "@odata.etag"?: string;
}

export interface LocalTask {
  listId?: string;
  listKey?: string;
  listName: string;
  taskId?: string;
  syncKey?: string;
  title: string;
  completed: boolean;
  note: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  enabled: false,
  legacyMigrated: false,
  markdownPath: "80 📗 Resource/00 🏷️ Inbox/20 TO-DO/MS-ToDo",
  clientId: "",
  tenant: "common",
  autoSyncMinutes: 15,
  fileDebounceMs: 1500,
  childOpacity: 0.5,
  childFontWeight: 400,
  calmImportEnabled: true,
  calmTargetListName: "Tasks",
  calmImports: {},
  deletions: {},
  token: null,
  snapshots: {},
  conflicts: []
};
