// Thin fetch wrapper: JSON in and out, server errors surfaced as ApiError with the server's message.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Call /api<path>: a body means POST unless method says otherwise; throws ApiError on failure. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"), credentials: "same-origin" };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "Content-Type": "application/json" };
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.");
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export interface User {
  id: number;
  email: string;
  name: string;
  is_admin: boolean;
}
export type Role = "owner" | "editor" | "viewer";
export interface Vault {
  id: number;
  name: string;
  role: Role;
  /** Your home collection (F20): where shares go and the app opens. */
  home?: boolean;
  note_count: number;
  member_count: number;
  /** "owner/name" when it's a copy of a GitHub repo (F14). */
  git_repo?: string | null;
  /** Its folder under the Mac's folders, when it's kept in one (F22). */
  folder?: string | null;
  /** In the cloud library, reached through this Mac (F23). */
  cloud?: boolean;
  /** New notes get an AI-XF id (F9). */
  note_ids?: boolean;
  /** Your id in the cloud library, for a cloud collection (it differs from yours here). */
  me?: number;
  /** The cloud couldn't be reached: the collection as it was last seen. */
  offline?: boolean;
}
export interface NoteSummary {
  id: number;
  path: string;
  title: string;
  tags: string[];
  updated_at: string;
  /** Its type (F16), from `type:` in its frontmatter. */
  type?: string | null;
  created_at?: string;
  /** Other names links can use (its aliases and id, lowercased); null if none. */
  aliases?: string[] | null;
  /** Its aliases as written, for the [[ suggestions; null if none. */
  names?: string[] | null;
  /** Its look (F28), from its properties: `icon` (shown only if an emoji), `cover`, `width`. */
  icon?: string | null;
  cover?: string | null;
  width?: "wide" | "full" | null;
}
export interface Note extends NoteSummary {
  vault_id: number;
  content: string;
  frontmatter: Record<string, unknown>;
  version: number;
  updated_by_name: string | null;
  role: Role;
}
export interface Session {
  /** This database's identity, for naming offline copies (F4). */
  instance: string;
  /** The library's name ("David's Library"), shown above the collections. */
  library: string;
  user: User | null;
  needsSetup: boolean;
  setupTokenRequired: boolean;
  allowSignup: boolean;
  search: { semantic: boolean; provider: string };
  /** This server can keep collections in folders on the Mac (F22, the laptop kit). */
  folders?: boolean;
  /** Admins only: how full the database is (src/storage.ts). */
  storage?: { state: "ok" | "warn" | "full"; used: number; limit: number | null };
}
