import { requestUrl } from "obsidian";
import type { GraphList, GraphTask } from "./types";

interface Collection<T> { value: T[]; "@odata.nextLink"?: string; }
export interface GraphTaskMetadata { dueDate?: string; importance: "low" | "normal" | "high"; }

export class GraphClient {
  private readonly base = "https://graph.microsoft.com/v1.0";
  constructor(private readonly accessToken: () => Promise<string>) {}

  private async call<T>(method: string, pathOrUrl: string, body?: unknown, etag?: string): Promise<T> {
    const token = await this.accessToken();
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (etag) headers["If-Match"] = etag;
    const response = await requestUrl({ url, method, headers, contentType: body === undefined ? undefined : "application/json", body: body === undefined ? undefined : JSON.stringify(body), throw: false });
    let payload: unknown;
    if (response.text.trim()) {
      try { payload = JSON.parse(response.text) as unknown; }
      catch { payload = undefined; }
    }
    if (response.status >= 400) {
      const graphError = typeof payload === "object" && payload !== null && "error" in payload
        && typeof payload.error === "object" && payload.error !== null
        ? payload.error as Record<string, unknown>
        : undefined;
      const message = typeof graphError?.message === "string" ? graphError.message : response.text || `Graph API 오류 (${response.status})`;
      const innerError = typeof graphError?.innerError === "object" && graphError.innerError !== null
        ? graphError.innerError as Record<string, unknown>
        : undefined;
      const detailCode = typeof innerError?.code === "string" ? innerError.code : typeof graphError?.code === "string" ? graphError.code : undefined;
      throw new Error(`${message}${detailCode ? ` (${detailCode})` : ""} [HTTP ${response.status}]`);
    }
    // Successful DELETE calls normally return HTTP 204 with an empty body.
    // Do not touch response.json in that case: Obsidian's lazy JSON getter
    // throws "Unexpected end of JSON input" for a valid empty response.
    return payload as T;
  }

  private async collection<T>(path: string): Promise<T[]> {
    const result: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: Collection<T> = await this.call<Collection<T>>("GET", next);
      result.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return result;
  }

  // Some Microsoft consumer mailboxes reject $select on this endpoint with
  // RequestBroker--ParseUri. The unfiltered endpoint works for all account types.
  listLists(): Promise<GraphList[]> { return this.collection<GraphList>("/me/todo/lists"); }
  listTasks(listId: string): Promise<GraphTask[]> {
    // Do not use $select here: Graph includes @odata.etag in the full response,
    // which lets conditional PATCH/DELETE reject a race instead of overwriting it.
    return this.collection<GraphTask>(`/me/todo/lists/${encodeURIComponent(listId)}/tasks`);
  }
  createTask(listId: string, title: string, completed: boolean, note: string, metadata?: GraphTaskMetadata): Promise<GraphTask> {
    return this.call<GraphTask>("POST", `/me/todo/lists/${encodeURIComponent(listId)}/tasks`, this.payload(title, completed, note, metadata, false));
  }
  updateTask(listId: string, taskId: string, title: string, completed: boolean, note: string, etag?: string, metadata?: GraphTaskMetadata): Promise<GraphTask> {
    return this.call<GraphTask>("PATCH", `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, this.payload(title, completed, note, metadata, true), etag);
  }
  async deleteTask(listId: string, taskId: string, etag?: string): Promise<void> {
    await this.call<void>("DELETE", `/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, undefined, etag);
  }
  private payload(title: string, completed: boolean, note: string, metadata?: GraphTaskMetadata, clearMissingMetadata = false): object {
    const payload: Record<string, unknown> = { title, status: completed ? "completed" : "notStarted", body: { contentType: "text", content: note } };
    if (metadata) {
      payload.importance = metadata.importance;
      if (metadata.dueDate) payload.dueDateTime = { dateTime: `${metadata.dueDate}T23:59:59.0000000`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
      else if (clearMissingMetadata) payload.dueDateTime = null;
    }
    return payload;
  }
}
