// GitHub's REST API, for GitHub vaults (F14). No git on the server: reads use the Trees and Blobs
// endpoints, a push builds blobs, a tree on the base tree, a commit and a ref. Each person's own
// token, sealed with SECRETS_KEY (src/secrets.ts), travels only in the Authorization header, never
// in a URL, and isn't echoed in errors or logs.

import { HttpError } from "./auth";
import { sql } from "./db";
import { open, seal } from "./secrets";
import { settings } from "./settings";

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export class GitHub {
  constructor(private readonly token: string) {}

  async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(settings.githubApi + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "DO Notes",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      console.warn(`GitHub ${method} ${path.split("?")[0]} failed to connect:`, err instanceof Error ? err.message : err);
      throw new HttpError(502, "Couldn't reach GitHub. Try again in a moment.");
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as any;
    if (res.ok) return data as T;
    const said = typeof data?.message === "string" ? data.message : "";
    // What GitHub refused, for the server log: the path and GitHub's words, never the token.
    console.warn(`GitHub ${method} ${path.split("?")[0]} → ${res.status}${said ? `: ${said}` : ""}${Array.isArray(data?.errors) ? ` ${JSON.stringify(data.errors).slice(0, 300)}` : ""}`);
    if (res.status === 401) throw new HttpError(409, "GitHub refused the token: it may have expired or been revoked. Connect again in Settings → Connections.");
    if (res.status === 403 && /rate limit/i.test(said)) throw new HttpError(429, "GitHub's rate limit is used up for now. Try again in a few minutes.");
    if (res.status === 403) throw new HttpError(403, "The token isn't allowed to do that: give it Contents and Pull requests (read and write) for this repository.");
    if (res.status === 404) throw new HttpError(404, "GitHub can't find that, or the token can't see it: check the token includes this repository.");
    throw new HttpError(res.status === 409 || res.status === 422 ? 409 : 502, `GitHub said: ${said || `error ${res.status}`}`);
  }

  get = <T = any>(path: string) => this.req<T>("GET", path);
  post = <T = any>(path: string, body: unknown) => this.req<T>("POST", path, body);
}

export const repoPath = (repo: string) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new HttpError(400, "A repository is owner/name");
  return `/repos/${repo}`;
};
/** A path or branch for a URL: each segment encoded, the slashes kept. */
export const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");

// ── each person's connection ─────────────────────────────────────────────────────────────

export interface Connection {
  login: string;
  token_hint: string;
}

export async function connection(userId: number): Promise<Connection | null> {
  const [c] = await sql<Connection[]>`select login, token_hint from user_github where user_id = ${userId}`;
  return c ?? null;
}

/** Check a token with GitHub and keep it, sealed. */
export async function connect(userId: number, token: string): Promise<Connection> {
  const t = token.trim();
  if (!/^[\w-]{20,255}$/.test(t)) throw new HttpError(400, "That doesn't look like a GitHub token (github_pat_… or ghp_…)");
  const me = await new GitHub(t).get<{ login: string }>("/user");
  const sealed = seal(t);
  const hint = t.slice(-4);
  await sql`insert into user_github (user_id, token_sealed, token_hint, login) values (${userId}, ${sealed}, ${hint}, ${me.login})
            on conflict (user_id) do update set token_sealed = excluded.token_sealed, token_hint = excluded.token_hint, login = excluded.login, created_at = now()`;
  return { login: me.login, token_hint: hint };
}

export async function disconnect(userId: number): Promise<void> {
  await sql`delete from user_github where user_id = ${userId}`;
}

/** A client with this person's token, or a 409 asking them to connect. */
export async function clientFor(userId: number): Promise<GitHub> {
  const [c] = await sql`select token_sealed from user_github where user_id = ${userId}`;
  if (!c) throw new HttpError(409, "Connect GitHub first: Settings → Connections.");
  try {
    return new GitHub(open(c.token_sealed));
  } catch {
    throw new HttpError(409, "Your GitHub token can't be read any more (the server's SECRETS_KEY changed): connect GitHub again in Settings → Connections.");
  }
}

// ── reads ────────────────────────────────────────────────────────────────────────────────

export async function listRepos(gh: GitHub) {
  const out: { full_name: string; private: boolean; default_branch: string; description: string | null }[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh.get<any[]>(`/user/repos?per_page=100&sort=updated&page=${page}`);
    out.push(...batch.map((r) => ({ full_name: r.full_name, private: !!r.private, default_branch: r.default_branch, description: r.description ?? null })));
    if (batch.length < 100) break;
  }
  return out;
}

export async function listBranches(gh: GitHub, repo: string): Promise<string[]> {
  const b = await gh.get<{ name: string }[]>(`${repoPath(repo)}/branches?per_page=100`);
  return b.map((x) => x.name);
}

/** A branch's head commit and that commit's tree. */
export async function branchHead(gh: GitHub, repo: string, branch: string): Promise<{ sha: string; tree: string }> {
  const b = await gh.get(`${repoPath(repo)}/branches/${enc(branch)}`);
  return { sha: b.commit.sha, tree: b.commit.commit.tree.sha };
}

export async function treeAt(gh: GitHub, repo: string, treeSha: string): Promise<TreeEntry[]> {
  const t = await gh.get<{ tree: TreeEntry[]; truncated: boolean }>(`${repoPath(repo)}/git/trees/${treeSha}?recursive=1`);
  if (t.truncated) throw new HttpError(413, "That repository has too many files to list in one go; pick a smaller one, or a folder in a smaller repo");
  return t.tree;
}

export async function blob(gh: GitHub, repo: string, sha: string): Promise<Uint8Array> {
  const b = await gh.get<{ content: string; encoding: string }>(`${repoPath(repo)}/git/blobs/${sha}`);
  return new Uint8Array(Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8"));
}
