// Environment, read once. Bun loads .env automatically.

import { randomBytes } from "node:crypto";

export type EmbeddingProvider = "relaxai" | "voyage" | "ollama" | "hash" | "none";

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

/** Production booted without SETUP_TOKEN: a random one, which server.ts prints while there are no
 *  accounts, so a fresh public deploy can't be claimed by whoever finds it first. */
export const generatedSetupToken = process.env.SETUP_TOKEN === undefined && process.env.NODE_ENV === "production" ? randomBytes(18).toString("base64url") : "";

export const settings = {
  /** New collections give their new notes an AI-XF id (F9). Off only in tests of exact note text. */
  aixfIds: process.env.AIXF_IDS !== "false",
  /** The iPhone app (ios/) as `TEAMID.bundle.id`, comma-separated: when set, the server says the
   *  app may open its links and fill its passwords (src/iosApp.ts). Unset = no app is claimed. */
  appleAppIds: (process.env.APPLE_APP_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://commonplace:commonplace@localhost:5434/commonplace",
  port: Number(process.env.PORT ?? 3000),
  /** Off unless set: the first account is always allowed, and after that an admin adds people. */
  allowSignup: bool(process.env.ALLOW_SIGNUP, false),
  /** When set, GET /api/backup with `Authorization: Bearer <token>` returns every vault as a zip. */
  backupToken: process.env.BACKUP_TOKEN?.trim() ?? "",
  /** When set, creating the first (admin) account requires this token (generated in production
   *  when unset, above; set it empty to turn the check off). */
  setupToken: process.env.SETUP_TOKEN?.trim() ?? generatedSetupToken,
  embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "hash") as EmbeddingProvider,
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",
  /** relaxAI (Civo, UK): the server's own key, for embeddings only. People's assistants use
   *  their own keys (src/assistants.ts). */
  relaxApiKey: process.env.RELAX_API_KEY?.trim() ?? "",
  relaxBaseUrl: (process.env.RELAX_BASE_URL?.trim() || "https://api.relax.ai/v1").replace(/\/+$/, ""),
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  /** undefined = decide per request from the protocol (x-forwarded-proto aware). */
  cookieSecure: process.env.COOKIE_SECURE ? bool(process.env.COOKIE_SECURE, false) : undefined,
  /** The database disk size (Render doesn't expose it): admins see how full it is, and near it
   *  writes that add data stop (src/storage.ts). 1 GB unless set; 0 turns the guard off. */
  dbDiskBytes: Number(process.env.DB_DISK_GB?.trim() || 1) * 1024 ** 3,
  /** For timestamps the server writes into notes (captured items). */
  timeZone: process.env.TIME_ZONE?.trim() || "Europe/London",
  /** Encrypts people's AI API keys at rest (F13). Any long random string; changing it means
   *  everyone re-enters their key. Unset = assistants can't be added. */
  secretsKey: process.env.SECRETS_KEY?.trim() ?? "",
  /** GitHub's REST API (F14); tests point it at a fake. */
  githubApi: (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, ""),
  /** F19: how often due automatic pushes are looked for, and how long a note must go untouched
   *  before "keep a branch in sync" sends it. Shorter only in tests. */
  gitTickMs: Number(process.env.GIT_TICK_MS ?? 60_000),
  /** Brave Search's API, for the assistant's web search; a fake one in tests. */
  braveApi: (process.env.BRAVE_API_URL?.trim() || "https://api.search.brave.com/res/v1").replace(/\/+$/, ""),
  /** Recall's MCP server (F30): the address the Recall connection signs in to and calls. */
  recallMcp: process.env.RECALL_MCP_URL?.trim() || "https://backend.getrecall.ai/mcp/",
  /** Floe's MCP address, for the Floe preset (F33); empty: the person gives it when connecting. */
  floeMcp: process.env.FLOE_MCP_URL ?? "",
  /** Connections (Longview, Recall) to private addresses: tests and a kit on the same Mac only. */
  connectionsAllowLocal: process.env.CONNECTIONS_ALLOW_LOCAL === "true",
  gitIdleMs: Number(process.env.GIT_IDLE_MS ?? 120_000),
  maxImportBytes: Number(process.env.MAX_IMPORT_MB ?? 200) * 1024 * 1024,
  /** F22: the folder (inside the container, the laptop kit mounts COMMONPLACE_FOLDERS there)
   *  that folder vaults live under. Unset = no folder vaults on this server (the cloud). */
  foldersRoot: (process.env.FOLDERS_ROOT?.trim() ?? "").replace(/\/+$/, ""),
  /** How FOLDERS_ROOT is shown to people: the Mac path it was mounted from ("~/Notes"). */
  foldersLabel: process.env.FOLDERS_LABEL?.trim() || process.env.FOLDERS_ROOT?.trim() || "",
  /** F22: how often every folder vault is rescanned, besides file events (which a Docker mount
   *  doesn't always pass on). Shorter in tests. */
  folderScanMs: Number(process.env.FOLDER_SCAN_MS ?? 30_000),
  /** F23: this server (the Mac's) can sign in to a cloud library and show its collections. */
  cloudLink: process.env.CLOUD_LINK === "true",
};
