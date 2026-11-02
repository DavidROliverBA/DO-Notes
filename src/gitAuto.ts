// How a GitHub vault's changes go to GitHub (F19), chosen per vault by an owner:
//
//   ask       someone presses Push and it opens or adds to the PR (F14, the default)
//   review    one PR every hour, day or week at a UK time; a new period's changes join the open
//             PR, and once it's merged the next period opens a fresh one
//   sync      each note goes to the working branch once nobody has typed in it for a while;
//             a person opens the PR when they choose
//   publish   straight onto the base branch (main included), on the schedule or once idle;
//             deletions wait for a person
//
// Every automatic run merges first (src/git.ts `update`): a real clash pauses sending until it's
// settled, never a force push or conflict markers. Held notes stay out. Runs are sent with the
// token of the owner who chose the mode; if they disconnect GitHub or stop being an editor,
// sending pauses and the branch bar says why. The next run time is stored, so a restart or deploy
// loses nothing and a missed run happens once at boot. One instance (L4), so a lock per vault in
// memory is enough to stop a slow push overlapping the next check.

import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { emit } from "./events";
import { branchHead, clientFor, repoPath, treeAt } from "./github";
import { type Change, changes, gitRow, leftOut, publish, push, type SendMode, type Status, status, update, type VaultGit } from "./git";
import { nextRun } from "./schedule";
import { settings } from "./settings";

export interface AutoSettings {
  mode: SendMode;
  every: VaultGit["send_every"];
  at: string;
  day: number;
  soon: boolean;
  coauthorEmails: boolean;
  /** Publish only: the branch to publish to, if not the vault's base branch. */
  branch?: string;
}

const scheduled = (g: Pick<VaultGit, "send_mode" | "send_soon">) => g.send_mode === "review" || (g.send_mode === "publish" && !g.send_soon);

// ── settings ─────────────────────────────────────────────────────────────────────────────

/** An owner chooses how changes are sent; they become the one who sends. */
export async function configure(vaultId: number, user: User, s: AutoSettings): Promise<Status> {
  let g = await gitRow(vaultId);
  if (s.mode !== "ask") await clientFor(user.id); // connected, or a clear "Connect GitHub first"
  if (s.mode === "publish") {
    if (g.head_sha) throw new HttpError(409, `Finish or cancel the branch ${g.branch} first: publishing sends straight to a branch, without one of its own`);
    const target = s.branch?.trim();
    if (target && target !== g.base_branch) {
      await switchBase(g, user, target);
      g = await gitRow(vaultId);
    }
  }
  const next = scheduled({ send_mode: s.mode, send_soon: s.soon }) ? nextRun(s.every, s.at, s.day) : null;
  await sql`update vault_git set send_mode = ${s.mode}, send_every = ${s.every}, send_at = ${s.at}, send_day = ${s.day}, send_soon = ${s.soon},
              coauthor_emails = ${s.coauthorEmails}, send_as = ${s.mode === "ask" ? null : user.id}, next_run_at = ${next},
              paused_at = null, paused_why = null, last_error = null
            where vault_id = ${vaultId}`;
  emit(vaultId, { type: "vault.changed" });
  return status(vaultId, user.id);
}

/** Publish to another branch: the vault follows it from now on (made from the base if it's new). */
async function switchBase(g: VaultGit, user: User, branch: string): Promise<void> {
  if (!/^(?!\/|.*(?:\.\.|\/\/|@\{|\.lock$|\/$|\.$))[\w./-]{1,100}$/.test(branch)) throw new HttpError(400, "A branch name is letters, numbers, - _ . and /, with no spaces or ..");
  const gh = await clientFor(user.id);
  let exists = true;
  try {
    await branchHead(gh, g.repo, branch);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
    exists = false;
  }
  if (exists) {
    // Following a branch that lacks some of this collection's files would treat them as deleted
    // there, and Update would send those notes to Trash. Refuse before anything changes.
    const there = new Set((await treeAt(gh, g.repo, (await branchHead(gh, g.repo, branch)).tree)).map((e) => e.path));
    const ours = await sql<{ repo_path: string }[]>`select repo_path from git_files where vault_id = ${g.vault_id}`;
    const missing = ours.filter((f) => !there.has(f.repo_path)).length;
    if (missing)
      throw new HttpError(
        409,
        `${branch} doesn't have ${missing === 1 ? "one of this collection's files" : `${missing} of this collection's files`}, so following it would send ${missing === 1 ? "that note" : "those notes"} to Trash. Choose a branch made from ${g.base_branch}, or a new name and DO Notes makes the branch.`,
      );
  } else await gh.post(`${repoPath(g.repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha: g.base_sha });
  await sql`update vault_git set base_branch = ${branch} where vault_id = ${g.vault_id}`;
  if (exists) await update(g.vault_id, user); // its newer notes come in, merged as Update does
}

/** Pause automatic pushes, or carry on (from the next scheduled time, not a burst of missed ones). */
export async function pause(vaultId: number, user: User, paused: boolean): Promise<Status> {
  const g = await gitRow(vaultId);
  if (g.send_mode === "ask") throw new HttpError(400, "Nothing is sent automatically in this collection");
  if (paused) await sql`update vault_git set paused_at = now(), paused_why = null where vault_id = ${vaultId}`;
  else {
    const problem = await senderProblem(g);
    if (problem) throw new HttpError(409, `${problem} An owner can choose again in Settings → This collection.`);
    const next = scheduled(g) ? nextRun(g.send_every, g.send_at, g.send_day) : null;
    await sql`update vault_git set paused_at = null, paused_why = null, last_error = null, next_run_at = ${next} where vault_id = ${vaultId}`;
  }
  emit(vaultId, { type: "vault.changed" });
  return status(vaultId, user.id);
}

/** Why the chosen sender can't send any more, or null. */
async function senderProblem(g: VaultGit): Promise<string | null> {
  if (!g.send_as) return "Nobody is set to send.";
  const [u] = await sql`select u.name, m.role, gh.user_id is not null as connected
                        from users u left join vault_members m on m.user_id = u.id and m.vault_id = ${g.vault_id}
                        left join user_github gh on gh.user_id = u.id where u.id = ${g.send_as}`;
  if (!u) return "The person who sends has gone.";
  if (!u.role || u.role === "viewer") return `${u.name} can't edit this collection any more, so can't send.`;
  if (!u.connected) return `${u.name} disconnected GitHub, so can't send.`;
  return null;
}

// ── a run ────────────────────────────────────────────────────────────────────────────────

const running = new Set<number>();

/** Send now (by a person, with their token: deletions go too, and nothing waits to go quiet),
 *  or an automatic run (by the scheduler, as the vault's sender). */
export async function run(vaultId: number, by?: User): Promise<Status | null> {
  if (running.has(vaultId)) {
    if (by) throw new HttpError(409, "Already sending: try again in a moment");
    return null;
  }
  running.add(vaultId);
  try {
    return await runLocked(vaultId, by);
  } finally {
    running.delete(vaultId);
  }
}

async function runLocked(vaultId: number, by?: User): Promise<Status | null> {
  const g = await gitRow(vaultId);
  const mode = g.send_mode;
  if (mode === "ask") {
    if (by) throw new HttpError(400, "This collection sends when you push: use Open pull request");
    return null;
  }
  let sender = by;
  if (!sender) {
    const problem = await senderProblem(g);
    if (problem) return (await stop(vaultId, `sender:${problem}`), null);
    [sender] = await sql<User[]>`select * from users where id = ${g.send_as}`;
  }
  const idleOnly = !by && (mode === "sync" || (mode === "publish" && g.send_soon));
  const send = (c: Change) => (by ? true : !leftOut(c, mode)) && (!idleOnly || !c.updatedAt || Date.now() - +c.updatedAt >= settings.gitIdleMs);
  const due = (list: Change[]) => list.filter((c) => !c.held && c.unpushed && send(c));
  const next = !by && scheduled(g) ? nextRun(g.send_every, g.send_at, g.send_day) : g.next_run_at;

  // Nothing to send: nothing is asked of GitHub, and no empty commit or PR.
  if (!due(await changes(vaultId, g)).length) {
    if (!by) await sql`update vault_git set next_run_at = ${next} where vault_id = ${vaultId}`;
    return by ? status(vaultId, by.id) : null;
  }
  try {
    // Merge first: GitHub's newer notes come in; a merged PR ends the branch.
    await update(vaultId, sender!);
    const [{ n: clashes }] = (await sql`select count(*)::int as n from git_clashes where vault_id = ${vaultId}`) as any;
    if (clashes) {
      if (by) throw new HttpError(409, `Settle the ${clashes === 1 ? "clash" : `${clashes} clashes`} in Review changes first`);
      return (await stop(vaultId, "clashes"), null);
    }
    const st = await status(vaultId);
    const list = due(st.changes);
    if (list.length) {
      const g2 = await gitRow(vaultId);
      const others = st.authors.filter((a) => a.id !== sender!.id);
      const message = commitMessage(list, others, g2.coauthor_emails);
      if (mode === "publish") await publish(vaultId, sender!, { message, send });
      else
        await push(vaultId, sender!, {
          message,
          send,
          // An old branch of the same name may still be on GitHub (merged PRs often keep theirs).
          ...(g2.head_sha ? {} : { branch: await freeBranch(sender!, g2.repo, st.branch) }),
          ...(mode === "review" && !g2.pr_number ? { title: prTitle(g2), body: prBody(st.changes.filter((c) => !c.held)) } : {}),
        });
    }
    await sql`update vault_git set last_error = null, next_run_at = ${next} where vault_id = ${vaultId}`;
    emit(vaultId, { type: "vault.changed" });
    return status(vaultId, sender!.id);
  } catch (err) {
    if (by) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // GitHub busy, unreachable, or the branch moved meanwhile: try again a little later.
    // Anything else (refused, protected branch, token can't) pauses, saying why.
    const transient = !(err instanceof HttpError) || err.status === 429 || err.status >= 500 || /changed on GitHub meanwhile/.test(message);
    if (transient) {
      const later = new Date(Date.now() + Math.max(5 * 60_000, settings.gitTickMs));
      await sql`update vault_git set last_error = ${message}, next_run_at = ${scheduled(g) && next && next > later ? next : later} where vault_id = ${vaultId}`;
    } else await stop(vaultId, `github:${message}`);
    console.warn(`automatic push for vault ${vaultId} ${transient ? "will retry" : "paused"}: ${message}`);
    emit(vaultId, { type: "vault.changed" });
    return null;
  }
}

/** `want`, or `want-2`, `want-3`… whichever isn't on GitHub yet. */
async function freeBranch(user: User, repo: string, want: string): Promise<string> {
  const gh = await clientFor(user.id);
  for (let i = 1; i <= 20; i++) {
    const name = i === 1 ? want : `${want}-${i}`;
    try {
      await branchHead(gh, repo, name);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return name;
      throw err;
    }
  }
  throw new HttpError(409, `Branches ${want} to ${want}-20 are all on GitHub already: delete some old ones there`);
}

async function stop(vaultId: number, why: string) {
  await sql`update vault_git set paused_at = now(), paused_why = ${why} where vault_id = ${vaultId}`;
  emit(vaultId, { type: "vault.changed" });
}

// ── messages ─────────────────────────────────────────────────────────────────────────────

const title = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");

function summary(list: Change[]): string {
  const names = list.map((c) => title(c.path));
  if (names.length === 1) return `${list[0]!.kind === "added" ? "Add" : list[0]!.kind === "deleted" ? "Remove" : "Update"} ${names[0]}`;
  if (names.length <= 3) return `Update ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Update ${names.length} notes: ${names.slice(0, 2).join(", ")} and more`;
}

/** Other editors are named; their emails only if the vault opts in (the repo may be public). */
function commitMessage(list: Change[], others: { name: string; email: string }[], emails: boolean): string {
  const credit = !others.length ? [] : emails ? ["", ...others.map((a) => `Co-authored-by: ${a.name} <${a.email}>`)] : ["", `Also edited by ${others.map((a) => a.name).join(", ")}.`];
  return [summary(list), "", "Sent automatically by DO Notes.", ...credit].join("\n");
}

function prTitle(g: VaultGit): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(new Date());
  return `Notes from DO Notes, ${g.send_every === "week" ? "week to " : ""}${day}`;
}

function prBody(list: Change[]): string {
  return list.map((c) => `- ${c.kind === "moved" ? `Moved ${c.from} to ${c.path}` : `${c.kind[0]!.toUpperCase()}${c.kind.slice(1)} ${c.path}`}`).join("\n") + "\n\nOpened automatically by DO Notes; later changes are added to it until it's merged.";
}

// ── the clock ────────────────────────────────────────────────────────────────────────────

let ticking = false;

/** Once a minute: settle pauses that have cleared, pause for a sender who can't send, and run
 *  what's due. */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const rows = await sql<VaultGit[]>`select * from vault_git where send_mode <> 'ask'`;
    for (const g of rows) {
      try {
        if (g.paused_at) {
          if (g.paused_why !== "clashes") continue;
          const [{ n }] = (await sql`select count(*)::int as n from git_clashes where vault_id = ${g.vault_id}`) as any;
          if (n) continue;
          await sql`update vault_git set paused_at = null, paused_why = null where vault_id = ${g.vault_id}`;
          emit(g.vault_id, { type: "vault.changed" });
        }
        const problem = await senderProblem(g);
        if (problem) {
          await stop(g.vault_id, `sender:${problem}`);
          continue;
        }
        if (g.next_run_at && +g.next_run_at > Date.now()) continue;
        await run(g.vault_id);
      } catch (err) {
        console.error(`automatic push check for vault ${g.vault_id} failed:`, err);
      }
    }
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  setTimeout(() => void tick(), Math.min(5_000, settings.gitTickMs)).unref();
  setInterval(() => void tick(), settings.gitTickMs).unref();
}
