import { TFile, Vault } from "obsidian";
import type { TaskStore } from "../task-store";
import type { CalmTasksSettings } from "../types";
import { calmImportCandidates, type CalmImportCandidate } from "./calm";
import { GraphClient } from "./graph";
import { graphToLocal, localTaskMarkdown, normalizePath, parseMarkdown, renderMarkdown, syncMarker, taskHash } from "./markdown";
import type { ConflictRecord, GraphList, GraphTask, LocalTask, PluginSettings, TaskSnapshot } from "./types";

interface RemoteTask { list: GraphList; task: GraphTask; local: LocalTask; }

class LocalFileChangedDuringSync extends Error {
  constructor() { super("동기화 중 Obsidian task가 변경되었습니다."); }
}

function calmCandidateHash(candidate: CalmImportCandidate): string {
  return JSON.stringify([
    candidate.title.trim(), candidate.completed, candidate.note.trim(),
    candidate.dueDate ?? "", candidate.importance
  ]);
}

export class SyncEngine {
  private running: Promise<string> | null = null;
  private suppressFileEventUntil = 0;

  constructor(
    private readonly vault: Vault,
    private readonly store: TaskStore,
    private readonly getCalmSettings: () => CalmTasksSettings,
    private readonly graph: GraphClient,
    private readonly getSettings: () => PluginSettings,
    private readonly persist: () => Promise<void>
  ) {}

  shouldIgnoreFileEvent(): boolean { return Date.now() < this.suppressFileEventUntil; }

  sync(): Promise<string> {
    if (this.running) return this.running;
    this.running = this.performWithRetry().finally(() => { this.running = null; });
    return this.running;
  }

  private async performWithRetry(): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.perform();
      } catch (error) {
        if (!(error instanceof LocalFileChangedDuringSync) || attempt === 2) throw error;
      }
    }
    throw new LocalFileChangedDuringSync();
  }

  private async perform(): Promise<string> {
    const settings = this.getSettings();
    if (!settings.enabled) throw new Error("Microsoft To Do sync is disabled.");
    const localRevision = this.store.getStateRevision();
    const path = normalizePath(settings.markdownPath);
    const file = this.vault.getAbstractFileByPath(path);
    const initialLocalContent = file instanceof TFile ? await this.vault.read(file) : undefined;
    const localTasks = initialLocalContent === undefined ? [] : parseMarkdown(initialLocalContent);
    const lists = await this.graph.listLists();
    const listById = new Map(lists.map((list) => [list.id, list]));
    const listByKey = new Map(lists.map((list) => [syncMarker("l", list.id), list]));
    const uniqueListName = new Map<string, GraphList>();
    for (const list of lists) {
      if (uniqueListName.has(list.displayName)) uniqueListName.delete(list.displayName);
      else uniqueListName.set(list.displayName, list);
    }
    for (const task of localTasks) {
      if (!task.listId && task.listKey) task.listId = listByKey.get(task.listKey)?.id;
      if (!task.listId) task.listId = uniqueListName.get(task.listName)?.id;
    }

    const remote = new Map<string, RemoteTask>();
    for (const list of lists) {
      for (const task of await this.graph.listTasks(list.id)) remote.set(task.id, { list, task, local: graphToLocal(list, task) });
    }
    if (localRevision !== this.store.getStateRevision()) throw new LocalFileChangedDuringSync();
    const remoteByKey = new Map([...remote.values()].map((item) => [syncMarker("t", item.task.id), item]));
    const historicalByKey = new Map<string, { taskId: string; listId: string }>();
    Object.values(settings.snapshots).forEach(snapshot => historicalByKey.set(syncMarker("t", snapshot.taskId), snapshot));
    Object.values(settings.deletions).forEach(deletion => historicalByKey.set(syncMarker("t", deletion.taskId), deletion));
    for (const local of localTasks) {
      if (!local.taskId && local.syncKey) {
        const matched = remoteByKey.get(local.syncKey);
        if (matched && (!local.listId || local.listId === matched.list.id)) {
          local.taskId = matched.task.id;
          local.listId = matched.list.id;
        } else {
          // Keep a deleted remote task attached to its historical identity.
          // Without this lookup the surviving Markdown line would look new and
          // be POSTed back to Microsoft, resurrecting the deleted task.
          const historical = historicalByKey.get(local.syncKey);
          if (historical && (!local.listId || local.listId === historical.listId)) {
            local.taskId = historical.taskId;
            local.listId = historical.listId;
          }
        }
      }
    }
    const localMapped = new Map(localTasks.filter((task) => task.taskId).map((task) => [task.taskId as string, task]));
    const nextSnapshots: Record<string, TaskSnapshot> = {};
    const conflicts = settings.conflicts.slice(-49);
    const calmTaskIdsAtStart = new Set(Object.values(settings.calmImports).map((record) => record.taskId));
    let created = 0, calmCreated = 0, calmUpdated = 0, calmDeleted = 0, updatedRemote = 0, deletedRemote = 0, conflictsAdded = 0;
    let calmMessage = "";
    const now = new Date().toISOString();
    const deletionCutoff = Date.now() - 180 * 24 * 60 * 60_000;
    settings.deletions = Object.fromEntries(Object.entries(settings.deletions)
      .filter(([, deletion]) => (Date.parse(deletion.detectedAt) || Date.now()) >= deletionCutoff));

    const recordDeletion = (taskId: string, listId: string, source: "obsidian" | "microsoft", details?: { createdAt?: string; sourcePath?: string; sourceTitle?: string }): void => {
      settings.deletions[taskId] = { taskId, listId, source, detectedAt: now, ...details };
    };

    const addConflict = (reason: string, task: LocalTask): void => {
      const record: ConflictRecord = { createdAt: new Date().toISOString(), reason, listName: task.listName, taskMarkdown: localTaskMarkdown(task) };
      conflicts.push(record); conflictsAdded++;
    };

    for (const [taskId, snapshot] of Object.entries(settings.snapshots)) {
      // Calm-imported tasks are owned by their original Calm task. Do not let
      // the managed Markdown mirror edit or delete them a second time.
      if (calmTaskIdsAtStart.has(taskId)) continue;
      const local = localMapped.get(taskId);
      const currentRemote = remote.get(taskId);
      if (local && currentRemote) {
        const localHash = taskHash(local), remoteHash = taskHash(currentRemote.local);
        const localChanged = localHash !== snapshot.localHash;
        if (localChanged && localHash !== remoteHash) {
          // Obsidian is authoritative when both sides changed the same task.
          try {
            const saved = await this.graph.updateTask(currentRemote.list.id, taskId, local.title, local.completed, local.note, currentRemote.task["@odata.etag"] ?? snapshot.etag);
            currentRemote.task = saved; currentRemote.local = graphToLocal(currentRemote.list, saved); updatedRemote++;
          } catch (error) {
            addConflict(`원격 업데이트 실패: ${error instanceof Error ? error.message : String(error)}`, local);
          }
        }
        const finalRemote = currentRemote.local;
        const finalHash = taskHash(finalRemote);
        nextSnapshots[taskId] = {
          listId: currentRemote.list.id, taskId, localHash: finalHash, remoteHash: finalHash,
          remoteModified: currentRemote.task.lastModifiedDateTime, etag: currentRemote.task["@odata.etag"],
          createdAt: snapshot.createdAt ?? currentRemote.task.createdDateTime ?? now,
          lastSeenLocalAt: now, lastSeenRemoteAt: now
        };
      } else if (!local && currentRemote) {
        // The task existed at the last common snapshot, so absence in
        // Obsidian is a local deletion. Obsidian wins even if the remote copy
        // was edited meanwhile, preventing deleted tasks from resurrecting.
        try {
          await this.graph.deleteTask(currentRemote.list.id, taskId, currentRemote.task["@odata.etag"] ?? snapshot.etag);
          remote.delete(taskId);
          recordDeletion(taskId, currentRemote.list.id, "obsidian", { createdAt: snapshot.createdAt ?? currentRemote.task.createdDateTime });
          deletedRemote++;
        }
        catch (error) {
          addConflict(`삭제 실패; 다음 동기화에서 다시 시도: ${error instanceof Error ? error.message : String(error)}`, currentRemote.local);
          // Keep the optimistic local deletion hidden while the remote retry
          // remains pending. Never render the stale task back into Markdown.
          nextSnapshots[taskId] = { ...snapshot, pendingLocalDeleteAt: snapshot.pendingLocalDeleteAt ?? Date.now() };
        }
      } else if (local && !currentRemote) {
        const localChanged = taskHash(local) !== snapshot.localHash;
        if (localChanged && local.listId && listById.has(local.listId)) {
          // Remote deletion and local editing happened together. Keep the
          // edited Obsidian task and recreate its Microsoft counterpart.
          try {
            const made = await this.graph.createTask(local.listId, local.title, local.completed, local.note);
            const list = listById.get(local.listId) as GraphList;
            remote.set(made.id, { list, task: made, local: graphToLocal(list, made) });
            local.taskId = made.id;
            recordDeletion(taskId, snapshot.listId, "microsoft", { createdAt: snapshot.createdAt });
            created++;
          } catch (error) {
            addConflict(`원격 재생성 실패: ${error instanceof Error ? error.message : String(error)}`, local);
          }
        } else {
          // The local copy is unchanged, so the Microsoft deletion is newer
          // than the last common state and must be propagated to Markdown.
          recordDeletion(taskId, snapshot.listId, "microsoft", { createdAt: snapshot.createdAt });
        }
      }
    }

    const knownRemoteIds = new Set(Object.keys(settings.snapshots));
    const adoptedRemoteIds = new Set<string>();
    for (const local of localTasks.filter((task) => !task.taskId)) {
      if (!local.listId || !listById.has(local.listId)) { addConflict("목록을 찾을 수 없어 생성하지 못함", local); continue; }
      const candidates = [...remote.values()].filter((item) => !knownRemoteIds.has(item.task.id) && !adoptedRemoteIds.has(item.task.id) && item.list.id === local.listId && taskHash(item.local) === taskHash(local));
      const soleCandidate = candidates.length === 1 ? candidates[0] : undefined;
      if (soleCandidate) { local.taskId = soleCandidate.task.id; adoptedRemoteIds.add(soleCandidate.task.id); continue; }
      try {
        const made = await this.graph.createTask(local.listId, local.title, local.completed, local.note);
        const list = listById.get(local.listId) as GraphList;
        remote.set(made.id, { list, task: made, local: graphToLocal(list, made) });
        local.taskId = made.id; created++;
      } catch (error) { addConflict(`원격 생성 실패: ${error instanceof Error ? error.message : String(error)}`, local); }
    }

    if (settings.calmImportEnabled) {
      const targetName = settings.calmTargetListName.trim() || "Tasks";
      const targetList = lists.find((list) => list.displayName.toLocaleLowerCase() === targetName.toLocaleLowerCase());
      const calm = calmImportCandidates(this.store, this.getCalmSettings(), path);
      if (!calm.available) {
        calmMessage = " · Calm: 플러그인을 찾지 못함";
      } else {
        const claimed = new Set<string>();
        for (const candidate of calm.candidates) {
          const matched = this.findCalmImport(candidate, settings.calmImports, claimed);
          if (matched) {
            let record = matched.record;
            let current = remote.get(record.taskId);
            if (!current) {
              // Calm Tasks is the source of truth. A missing Microsoft item
              // must never delete a task line from an ordinary Obsidian note.
              if (!targetList) {
                calmMessage = ` · Calm: '${targetName}' 목록을 찾지 못함`;
                claimed.add(record.taskId);
                continue;
              }
              try {
                const made = await this.graph.createTask(targetList.id, candidate.title, candidate.completed, candidate.note, { dueDate: candidate.dueDate, importance: candidate.importance });
                current = { list: targetList, task: made, local: graphToLocal(targetList, made) };
                remote.set(made.id, current);
                recordDeletion(record.taskId, record.listId, "microsoft", { createdAt: record.remoteCreatedAt ?? record.createdAt, sourcePath: record.sourcePath, sourceTitle: record.sourceTitle });
                record = { ...record, taskId: made.id, listId: targetList.id, createdAt: now, remoteCreatedAt: made.createdDateTime ?? now };
                calmCreated++;
              } catch (error) {
                calmMessage = ` · Calm 재등록 실패: ${error instanceof Error ? error.message : String(error)}`;
                claimed.add(record.taskId);
                continue;
              }
            } else {
              const desired: LocalTask = { listId: current.list.id, listName: current.list.displayName, taskId: current.task.id, title: candidate.title, completed: candidate.completed, note: candidate.note };
              if (taskHash(desired) !== taskHash(current.local) || !this.calmMetadataMatches(current.task, candidate)) {
                try {
                  const saved = await this.graph.updateTask(current.list.id, current.task.id, candidate.title, candidate.completed, candidate.note, current.task["@odata.etag"], { dueDate: candidate.dueDate, importance: candidate.importance });
                  current.task = saved;
                  current.local = graphToLocal(current.list, saved);
                  calmUpdated++;
                } catch (error) {
                  calmMessage = ` · Calm 수정 실패: ${error instanceof Error ? error.message : String(error)}`;
                }
              }
            }
            claimed.add(record.taskId);
            const stableMarker = syncMarker("t", current.task.id);
            const stableFingerprint = `mst:${stableMarker}`;
            if (matched.key !== stableFingerprint) delete settings.calmImports[matched.key];
            settings.calmImports[stableFingerprint] = {
              ...record,
              sourcePath: candidate.path,
              sourceLine: candidate.line,
              sourceTitle: candidate.sourceTitle,
              sourceHash: calmCandidateHash(candidate),
              lastSyncedAt: now,
              remoteCreatedAt: record.remoteCreatedAt ?? current.task.createdDateTime ?? record.createdAt
            };
            continue;
          }
          // Completed Calm tasks are only synchronized when they were already
          // imported. This prevents historical completed tasks from being added
          // to Microsoft To Do while still allowing an existing task to close.
          if (candidate.completed) continue;
          if (!targetList) {
            calmMessage = ` · Calm: '${targetName}' 목록을 찾지 못함`;
            continue;
          }
          const alreadyImported = new Set(Object.values(settings.calmImports).map((record) => record.taskId));
          const comparableTitle = (value: string): string => value
            .replace(/<!--\s*mst:[a-z0-9]+\s*-->/giu, " ")
            .replace(/(?:\s*\|\s*(?:\d{4}-\d{2}-\d{2}|[A-D]))+\s*$/gu, "")
            .replace(/\s{2,}/gu, " ").trim().toLocaleLowerCase();
          const adoptable = [...remote.values()].filter(item =>
            item.list.id === targetList.id
            && !claimed.has(item.task.id)
            && !alreadyImported.has(item.task.id)
            && comparableTitle(item.local.title) === comparableTitle(candidate.sourceTitle)
          );
          if (adoptable.length === 1) {
            const current = adoptable[0] as RemoteTask;
            const desired: LocalTask = {
              listId: current.list.id,
              listName: current.list.displayName,
              taskId: current.task.id,
              title: candidate.title,
              completed: candidate.completed,
              note: candidate.note
            };
            if (taskHash(desired) !== taskHash(current.local) || !this.calmMetadataMatches(current.task, candidate)) {
              try {
                const saved = await this.graph.updateTask(current.list.id, current.task.id, candidate.title, candidate.completed, candidate.note, current.task["@odata.etag"], { dueDate: candidate.dueDate, importance: candidate.importance });
                current.task = saved;
                current.local = graphToLocal(current.list, saved);
                calmUpdated++;
              } catch (error) {
                calmMessage = ` · Calm 연결 실패: ${error instanceof Error ? error.message : String(error)}`;
                continue;
              }
            }
            const stableMarker = syncMarker("t", current.task.id);
            settings.calmImports[`mst:${stableMarker}`] = {
              taskId: current.task.id,
              listId: current.list.id,
              sourcePath: candidate.path,
              sourceLine: candidate.line,
              sourceTitle: candidate.sourceTitle,
              createdAt: now,
              sourceHash: calmCandidateHash(candidate),
              lastSyncedAt: now,
              remoteCreatedAt: current.task.createdDateTime ?? now
            };
            delete nextSnapshots[current.task.id];
            claimed.add(current.task.id);
            continue;
          }
          try {
            const made = await this.graph.createTask(targetList.id, candidate.title, false, candidate.note, { dueDate: candidate.dueDate, importance: candidate.importance });
            remote.set(made.id, { list: targetList, task: made, local: graphToLocal(targetList, made) });
            const stableMarker = syncMarker("t", made.id);
            settings.calmImports[`mst:${stableMarker}`] = {
              taskId: made.id,
              listId: targetList.id,
              sourcePath: candidate.path,
              sourceLine: candidate.line,
              sourceTitle: candidate.sourceTitle,
              createdAt: now,
              sourceHash: calmCandidateHash(candidate),
              lastSyncedAt: now,
              remoteCreatedAt: made.createdDateTime ?? now
            };
            claimed.add(made.id);
            calmCreated++;
          } catch (error) {
            calmMessage = ` · Calm 등록 실패: ${error instanceof Error ? error.message : String(error)}`;
          }
        }

        // A previously imported task that is no longer in Calm's allowed
        // candidate set was deleted or moved into the excluded group.
        for (const [fingerprint, record] of Object.entries(settings.calmImports)) {
          if (claimed.has(record.taskId)) continue;
          const current = remote.get(record.taskId);
          if (current) {
            try {
              await this.graph.deleteTask(current.list.id, current.task.id, current.task["@odata.etag"]);
              remote.delete(current.task.id);
              recordDeletion(record.taskId, current.list.id, "obsidian", {
                createdAt: record.remoteCreatedAt ?? current.task.createdDateTime ?? record.createdAt,
                sourcePath: record.sourcePath,
                sourceTitle: record.sourceTitle
              });
              calmDeleted++;
            } catch (error) {
              calmMessage = ` · Calm 삭제 실패: ${error instanceof Error ? error.message : String(error)}`;
              continue;
            }
          } else {
            recordDeletion(record.taskId, record.listId, "obsidian", {
              createdAt: record.remoteCreatedAt ?? record.createdAt,
              sourcePath: record.sourcePath,
              sourceTitle: record.sourceTitle
            });
          }
          delete settings.calmImports[fingerprint];
        }
      }
    }

    const calmTaskIds = new Set(Object.values(settings.calmImports).map((record) => record.taskId));
    for (const [taskId, item] of [...remote]) {
      const deletion = settings.deletions[taskId];
      if (deletion?.source !== "obsidian") continue;
      try {
        await this.graph.deleteTask(item.list.id, taskId, item.task["@odata.etag"]);
        remote.delete(taskId);
        deletedRemote++;
      } catch {
        // The tombstone continues to suppress the stale remote item and the
        // next scheduled sync retries the deletion.
      }
    }
    for (const [taskId, item] of remote) {
      if (calmTaskIds.has(taskId)) continue;
      if (settings.deletions[taskId]?.source === "obsidian") continue;
      if (nextSnapshots[taskId]?.pendingLocalDeleteAt) continue;
      const hash = taskHash(item.local);
      const previous = nextSnapshots[taskId] ?? settings.snapshots[taskId];
      nextSnapshots[taskId] = {
        listId: item.list.id, taskId, localHash: hash, remoteHash: hash,
        remoteModified: item.task.lastModifiedDateTime, etag: item.task["@odata.etag"],
        createdAt: previous?.createdAt ?? item.task.createdDateTime ?? now,
        lastSeenLocalAt: now, lastSeenRemoteAt: now
      };
    }

    const tasksByList = new Map<string, LocalTask[]>();
    const newestFirst = [...remote.values()].sort((a, b) => {
      const aCreated = Date.parse(a.task.createdDateTime ?? a.task.lastModifiedDateTime ?? "") || 0;
      const bCreated = Date.parse(b.task.createdDateTime ?? b.task.lastModifiedDateTime ?? "") || 0;
      return bCreated - aCreated;
    });
    for (const item of newestFirst) {
      // Do not render Calm-owned remote tasks into the managed Markdown file;
      // otherwise Calm Tasks would see the source and its mirror as duplicates.
      if (calmTaskIds.has(item.task.id)) continue;
      if (nextSnapshots[item.task.id]?.pendingLocalDeleteAt) continue;
      const bucket = tasksByList.get(item.list.id) ?? [];
      bucket.push(item.local); tasksByList.set(item.list.id, bucket);
    }
    // Show newly created Microsoft To Do tasks first. renderMarkdown separates
    // active and completed tasks while retaining this order inside each list.
    await this.writeFile(path, renderMarkdown(lists, tasksByList, conflicts), initialLocalContent);
    settings.snapshots = nextSnapshots;
    settings.conflicts = conflicts.slice(-50);
    settings.lastSyncAt = new Date().toISOString();
    settings.lastSyncMessage = `완료: 생성 ${created}, Calm 등록 ${calmCreated}, Calm 수정 ${calmUpdated}, Calm 삭제 ${calmDeleted}, 원격 수정 ${updatedRemote}, 원격 삭제 ${deletedRemote}, 충돌 ${conflictsAdded}${calmMessage}`;
    await this.persist();
    return settings.lastSyncMessage;
  }

  private findCalmImport(
    candidate: CalmImportCandidate,
    imports: PluginSettings["calmImports"],
    claimed: Set<string>
  ): { key: string; record: PluginSettings["calmImports"][string] } | undefined {
    const exact = imports[candidate.fingerprint];
    if (exact && !claimed.has(exact.taskId)) return { key: candidate.fingerprint, record: exact };
    const available = Object.entries(imports).filter(([, record]) => !claimed.has(record.taskId));
    const samePathAndLine = available.find(([, record]) => record.sourcePath === candidate.path && record.sourceLine === candidate.line);
    if (samePathAndLine) return { key: samePathAndLine[0], record: samePathAndLine[1] };
    const samePathAndTitle = available.filter(([, record]) => record.sourcePath === candidate.path && record.sourceTitle.toLocaleLowerCase() === candidate.sourceTitle.toLocaleLowerCase());
    const pathAndTitle = samePathAndTitle.length === 1 ? samePathAndTitle[0] : undefined;
    if (pathAndTitle) return { key: pathAndTitle[0], record: pathAndTitle[1] };
    const sameTitle = available.filter(([, record]) => record.sourceTitle.toLocaleLowerCase() === candidate.sourceTitle.toLocaleLowerCase());
    const title = sameTitle.length === 1 ? sameTitle[0] : undefined;
    if (title) return { key: title[0], record: title[1] };
    return undefined;
  }

  private calmMetadataMatches(task: GraphTask, candidate: CalmImportCandidate): boolean {
    const remoteDue = task.dueDateTime?.dateTime?.slice(0, 10);
    return (task.importance ?? "normal") === candidate.importance && remoteDue === candidate.dueDate;
  }

  private async writeFile(path: string, content: string, expectedContent?: string): Promise<void> {
    await this.store.runExclusive(async () => {
      if (!path.toLocaleLowerCase().endsWith(".md")) throw new Error("Sync can only write to a Markdown file.");
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder && !this.vault.getAbstractFileByPath(folder)) await this.vault.createFolder(folder);
      const existing = this.vault.getAbstractFileByPath(path);
      this.suppressFileEventUntil = Date.now() + 2500;
      if (existing instanceof TFile) {
        await this.vault.process(existing, current => {
          if (expectedContent === undefined || current !== expectedContent) throw new LocalFileChangedDuringSync();
          return content;
        });
      } else {
        if (expectedContent !== undefined) throw new LocalFileChangedDuringSync();
        await this.vault.create(path, content);
      }
    });
  }
}
