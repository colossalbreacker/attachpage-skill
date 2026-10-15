// Tests for `attachpage connect` against a throwaway home folder. App CLIs are kept off PATH, so only
// the config-file paths (Cursor, VS Code) are exercised; nothing on this machine is touched.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/attachpage.mjs", import.meta.url));
let home;
let vscodeDir;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "attachpage-connect-"));
  vscodeDir =
    process.platform === "win32"
      ? join(home, "AppData", "Roaming", "Code", "User")
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Code", "User")
        : join(home, ".config", "Code", "User");
});
after(() => rm(home, { recursive: true, force: true }));

function connect(args = []) {
  const systemOnly =
    process.platform === "win32"
      ? join(process.env.SystemRoot || "C:\\Windows", "System32")
      : "/usr/bin:/bin";
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, "connect", "--json", ...args],
      {
        env: {
          ...process.env,
          PATH: systemOnly,
          Path: systemOnly,
          ATTACHPAGE_CONNECT_HOME: home,
          APPDATA: join(home, "AppData", "Roaming"),
          ATTACHPAGE_API_KEY: "",
          ATTACHPAGE_CREDENTIALS_FILE: join(home, "credentials"),
        },
        timeout: 60_000,
      },
      (error, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(error ?? new Error(stdout));
        }
      },
    );
  });
}

const status = (r, app) => r.results.find((x) => x.app === app)?.status;

test("adds AttachPage to Cursor without touching other servers, once", async () => {
  await mkdir(join(home, ".cursor"), { recursive: true });
  const file = join(home, ".cursor", "mcp.json");
  await writeFile(file, JSON.stringify({ mcpServers: { other: { url: "https://example.com/mcp" } } }));
  const dry = await connect(["--client", "cursor", "--dry-run"]);
  assert.equal(status(dry, "Cursor"), "would-add");
  assert.doesNotMatch(await readFile(file, "utf8"), /attachpage/);

  const first = await connect(["--client", "cursor"]);
  assert.equal(status(first, "Cursor"), "added");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.mcpServers.other, { url: "https://example.com/mcp" });
  assert.deepEqual(saved.mcpServers.attachpage, { url: "https://attachpage.com/mcp" });
  assert.match(await readFile(`${file}.bak-attachpage`, "utf8"), /example\.com/);

  assert.equal(status(await connect(["--client", "cursor"]), "Cursor"), "already");
});

test("never rewrites a VS Code file with comments, and reports apps that are not installed", async () => {
  await mkdir(vscodeDir, { recursive: true });
  const file = join(vscodeDir, "mcp.json");
  const original = '{\n  // my servers\n  "servers": {}\n}\n';
  await writeFile(file, original);
  const r = await connect();
  assert.equal(status(r, "VS Code"), "manual");
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal(status(r, "Claude Code"), "not-found");
  assert.equal(status(r, "OpenAI Codex"), "not-found");
});

test("creates the VS Code entry in a new file", async () => {
  await rm(join(vscodeDir, "mcp.json"));
  const r = await connect(["--client", "vscode"]);
  assert.equal(status(r, "VS Code"), "added");
  const saved = JSON.parse(await readFile(join(vscodeDir, "mcp.json"), "utf8"));
  assert.deepEqual(saved.servers.attachpage, { type: "http", url: "https://attachpage.com/mcp" });
});
