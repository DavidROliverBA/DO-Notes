// The iPhone app end to end on the simulator (ios/README.md): a scratch server with its own
// database, the app signing in to it, the token the app makes, and shares sent with that token
// landing in the Inbox, sent directly and through the real share sheet (Safari, Photos).
// Needs Xcode, XcodeGen and the docker database (`docker compose up -d db`).
//
//   bun scripts/ios-e2e.ts [simulator name]

import { SQL } from "bun";

const PORT = 3299;
const BASE = `http://localhost:${PORT}`;
const ADMIN = "postgres://commonplace:commonplace@localhost:5434/commonplace";
const DB_NAME = "commonplace_ios_test";
const DB = `postgres://commonplace:commonplace@localhost:5434/${DB_NAME}`;
const SIM = process.argv[2] ?? "iPhone 18 Pro";
const BUNDLE = "com.davidroliver.commonplace";
const DEVELOPER_DIR = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const EMAIL = "phone@example.com";
const PASSWORD = "a-long-test-password";

function run(cmd: string[], opts: { env?: Record<string, string>; mayFail?: boolean } = {}) {
  console.log(`$ ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: "ios", env: { ...process.env, DEVELOPER_DIR, ...opts.env }, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString() + p.stderr.toString();
  // IOS_E2E_LOG=<dir> keeps each command's full output, for when a UI test needs looking into.
  if (process.env.IOS_E2E_LOG) Bun.write(`${process.env.IOS_E2E_LOG}/${Date.now()}.log`, out);
  for (const line of out.split("\n")) if (/error:|Test Case .*(passed|failed|skipped)|\*\* (TEST|BUILD)/.test(line)) console.log("  " + line.trim());
  if (p.exitCode !== 0 && !opts.mayFail) throw new Error(`${cmd[0]} failed (exit ${p.exitCode})`);
}

const admin = new SQL(ADMIN);
await admin.unsafe(`drop database if exists ${DB_NAME} with (force)`);
await admin.unsafe(`create database ${DB_NAME}`);
await admin.close();

const server = Bun.spawn(["bun", "src/server.ts"], {
  env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), SETUP_TOKEN: "", AIXF_IDS: "false", EMBEDDING_PROVIDER: "hash", NODE_ENV: "production" },
  stdout: "ignore",
  stderr: "inherit",
});

let failed = false;
try {
  for (let i = 0; ; i++) {
    if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) break;
    if (i > 100) throw new Error("the scratch server didn't start");
    await Bun.sleep(200);
  }
  const reg = await fetch(`${BASE}/api/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Phone" }) });
  if (!reg.ok) throw new Error(`register: ${reg.status} ${await reg.text()}`);
  const cookie = reg.headers.get("set-cookie")!.split(";")[0]!;
  const api = (path: string) => fetch(`${BASE}/api${path}`, { headers: { Cookie: cookie } }).then((r) => r.json() as Promise<any>);

  const xcode = ["xcodebuild", "-project", "Commonplace.xcodeproj", "-scheme", "Commonplace", "-destination", `platform=iOS Simulator,name=${SIM}`, "-derivedDataPath", "build/e2e", `SERVER_HOST=localhost:${PORT}`];
  run(["xcodegen", "-q"]);
  // A fresh start: no sign-in cookie left from an earlier run.
  run(["xcrun", "simctl", "boot", SIM], { mayFail: true });
  run(["xcrun", "simctl", "uninstall", SIM, BUNDLE], { mayFail: true });
  run([...xcode, "test", "-only-testing:CommonplaceUITests/SignInTests"], { env: { TEST_RUNNER_CP_EMAIL: EMAIL, TEST_RUNNER_CP_PASSWORD: PASSWORD } });

  const tokens: { name: string; scope: string }[] = await api("/me/tokens");
  const made = tokens.find((t) => t.scope === "capture");
  if (!made || !/^iPhone app · [A-Z2-9]{4}$/.test(made.name)) throw new Error(`the app should have made an "iPhone app · XXXX" capture token: ${JSON.stringify(tokens)}`);
  console.log(`✓ the app made its token: ${made.name}`);

  run([...xcode, "test", "-only-testing:CommonplaceTests/LiveCaptureTests"], { env: { TEST_RUNNER_CP_LIVE: "1" } });
  // Through the real share sheet: a page from Safari and a photo from Photos.
  run([...xcode, "test", "-only-testing:CommonplaceUITests/ShareSheetTests"], { env: { TEST_RUNNER_CP_SHARE_URL: `${BASE}/health` } });

  const vaults: { id: number }[] = await api("/vaults");
  const list: { id: number; path: string }[] = await api(`/vaults/${vaults[0]!.id}/notes`);
  const inbox = list.find((n) => n.path === "Inbox.md");
  if (!inbox) throw new Error("no Inbox note");
  const note = await api(`/vaults/${vaults[0]!.id}/notes/${inbox.id}`);
  const content: string = note.content ?? note.note?.content ?? "";
  for (const want of [/^- \[ \] .*(tiling|How to tile)/m, /^- \[ \] Ring the electrician/m, /^- \[ \] !\[\[attachments\/.*\.jpe?g\]\]/m])
    if (!want.test(content)) throw new Error(`Inbox is missing ${want}:\n${content}`);
  console.log("✓ the link, the text and the photo are in the Inbox");
  if (!content.includes(`](${BASE}/health)`)) throw new Error(`Inbox is missing the page shared from Safari:\n${content}`);
  if ((content.match(/^- \[ \] !\[\[attachments\//gm) ?? []).length < 2) throw new Error(`Inbox is missing the photo shared from Photos:\n${content}`);
  console.log("✓ the share sheet saved a page from Safari and a photo from Photos");
} catch (e) {
  failed = true;
  console.error(String(e));
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
