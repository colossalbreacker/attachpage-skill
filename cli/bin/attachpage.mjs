#!/usr/bin/env node
/**
 * AttachPage command line: publish a folder, send it to people, read their feedback.
 *
 *   npx attachpage ./dist                      publish (signed in: private; signed out: public for 48 h)
 *   npx attachpage send ./dist --to a@b.com    publish privately and email personal links
 *   npx attachpage login                       sign in from the terminal (approve in your browser)
 *   npx attachpage feedback <siteId>           what recipients said (open items)
 *   npx attachpage connect                     add AttachPage to the AI apps on this computer
 *
 * No dependencies. Credentials: ATTACHPAGE_API_KEY, or the key `login` saved in the operating system's
 * password store (or in ~/.attachpage/credentials with `login --store file`).
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const VERSION = "0.1.1";
const CREDENTIALS = process.env.ATTACHPAGE_CREDENTIALS_FILE || join(homedir(), ".attachpage", "credentials");
const SKIP_DIRS = new Set([".git", "node_modules", ".svn", ".hg"]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

// ---------- arguments ----------

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) flags.set(k, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags.set(k, argv[++i]);
    else flags.set(k, true);
  } else positional.push(a);
}
const asJson = flags.has("json");

function out(human, data) {
  if (asJson) console.log(JSON.stringify(data, null, 2));
  else console.log(human);
}
function fail(message, code = 1) {
  if (asJson) console.log(JSON.stringify({ error: message }));
  else console.error(`attachpage: ${message}`);
  process.exit(code);
}

// ---------- credentials ----------
//
// Where the key lives, first match wins: ATTACHPAGE_API_KEY, the credentials file (written only with
// `login --store file` or when no password store exists), then the operating system's password
// store: Windows Credential Manager (Web Credentials), the macOS Keychain, or the Secret Service
// keyring through secret-tool. Entries are per server: resource/service "attachpage", account = the
// server origin. Keys reach these tools on standard input, never on the command line.

const STORE_RESOURCE = "attachpage";
/** Characters allowed in keys and origins handed to password-store tools (no quoting needed). */
const SAFE = /^[A-Za-z0-9._:/-]+$/;

function runTool(file, args, { input = "", env } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(file, args, {
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return done({ code: -1, missing: true, stdout: "", stderr: "" });
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, missing: e.code === "ENOENT", stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, missing: false, stdout, stderr: stderr.trim() });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Windows PowerShell 5.1 projects the WinRT PasswordVault (Credential Manager > Web Credentials).
const VAULT_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $vault = New-Object Windows.Security.Credentials.PasswordVault
} catch { [Console]::Error.Write($_.Exception.Message); exit 2 }
$resource = $env:ATTACHPAGE_STORE_RESOURCE
$account = $env:ATTACHPAGE_STORE_ACCOUNT
function Find-Entry { try { return $vault.Retrieve($resource, $account) } catch { return $null } }
switch ($env:ATTACHPAGE_STORE_OP) {
  'get' { $c = Find-Entry; if ($null -eq $c) { exit 3 }; $c.RetrievePassword(); [Console]::Out.Write($c.Password) }
  'set' {
    $key = [Console]::In.ReadToEnd().Trim()
    $old = Find-Entry; if ($null -ne $old) { $vault.Remove($old) }
    $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($resource, $account, $key)))
  }
  'delete' { $c = Find-Entry; if ($null -eq $c) { exit 3 }; $vault.Remove($c) }
}
`;

async function windowsVault(op, origin, input) {
  // Full path, so a powershell.exe in the current folder can never run instead.
  const ps = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = Buffer.from(VAULT_SCRIPT, "utf16le").toString("base64");
  return runTool(
    ps,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", script],
    {
      input,
      env: {
        ATTACHPAGE_STORE_OP: op,
        ATTACHPAGE_STORE_RESOURCE: STORE_RESOURCE,
        ATTACHPAGE_STORE_ACCOUNT: origin,
      },
    },
  );
}

/** The password store for this platform: `get` → key | null, `set`, `remove` → removed?; throw when unusable. */
const passwordStore = {
  win32: {
    name: "Windows Credential Manager",
    async get(origin) {
      const r = await windowsVault("get", origin);
      if (r.code === 3) return null;
      if (r.code !== 0)
        throw new Error(r.missing ? "Windows PowerShell was not found" : r.stderr || `exit ${r.code}`);
      return r.stdout.trim() || null;
    },
    async set(origin, key) {
      const r = await windowsVault("set", origin, key);
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
    },
    async remove(origin) {
      const r = await windowsVault("delete", origin);
      if (r.code !== 0 && r.code !== 3) throw new Error(r.stderr || `exit ${r.code}`);
      return r.code === 0;
    },
  },
  darwin: {
    name: "the macOS Keychain",
    async get(origin) {
      const r = await runTool("/usr/bin/security", [
        "find-generic-password",
        "-s",
        STORE_RESOURCE,
        "-a",
        origin,
        "-w",
      ]);
      if (r.code === 44) return null; // item not found
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
      return r.stdout.trim() || null;
    },
    async set(origin, key) {
      // `security -i` reads the command from stdin, which keeps the key out of the process list.
      const r = await runTool("/usr/bin/security", ["-i"], {
        input: `add-generic-password -U -s ${STORE_RESOURCE} -a ${origin} -w ${key}\n`,
      });
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
    },
    async remove(origin) {
      const r = await runTool("/usr/bin/security", [
        "delete-generic-password",
        "-s",
        STORE_RESOURCE,
        "-a",
        origin,
      ]);
      if (r.code === 44) return false;
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
      return true;
    },
  },
  linux: {
    name: "the system keyring (Secret Service)",
    async get(origin) {
      const r = await runTool("secret-tool", ["lookup", "service", STORE_RESOURCE, "account", origin]);
      if (r.missing) throw new Error("secret-tool is not installed");
      if (r.code !== 0 && !r.stderr) return null;
      if (r.code !== 0) throw new Error(r.stderr);
      return r.stdout.trim() || null;
    },
    async set(origin, key) {
      const label = `AttachPage key (${origin})`;
      const r = await runTool(
        "secret-tool",
        ["store", "--label", label, "service", STORE_RESOURCE, "account", origin],
        {
          input: key,
        },
      );
      if (r.missing) throw new Error("secret-tool is not installed");
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
    },
    async remove(origin) {
      if (!(await this.get(origin))) return false;
      const r = await runTool("secret-tool", ["clear", "service", STORE_RESOURCE, "account", origin]);
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
      return true;
    },
  },
}[process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux"];

async function readCredentialsFile() {
  const found = { key: null, origin: null };
  try {
    for (const line of (await readFile(CREDENTIALS, "utf8")).split(/\r?\n/)) {
      const at = line.indexOf("=");
      if (at < 0) continue;
      const k = line.slice(0, at).trim();
      const v = line.slice(at + 1).trim();
      if (k === "ATTACHPAGE_API_KEY" && v) found.key ??= v;
      if (k === "ATTACHPAGE_ORIGIN" && v) found.origin ??= v;
    }
  } catch {
    /* no file */
  }
  return found;
}

/** Key and server for this run, plus where the key came from. */
async function readCredentials() {
  const file = await readCredentialsFile();
  const origin = (
    (typeof flags.get("origin") === "string" ? flags.get("origin") : null) ||
    process.env.ATTACHPAGE_ORIGIN ||
    file.origin ||
    "https://attachpage.com"
  ).replace(/\/$/, "");
  if (process.env.ATTACHPAGE_API_KEY)
    return { key: process.env.ATTACHPAGE_API_KEY, origin, source: "environment" };
  if (file.key) return { key: file.key, origin, source: CREDENTIALS };
  if (SAFE.test(origin)) {
    try {
      const key = await passwordStore.get(origin);
      if (key) return { key, origin, source: passwordStore.name };
    } catch {
      /* no usable password store: not signed in */
    }
  }
  return { key: null, origin, source: null };
}

/** Write the credentials file (owner-only), keeping or dropping the key line. */
async function writeCredentialsFile({ key, origin }) {
  const lines = [];
  if (key) lines.push(`ATTACHPAGE_API_KEY=${key}`);
  if (origin && origin !== "https://attachpage.com") lines.push(`ATTACHPAGE_ORIGIN=${origin}`);
  if (!lines.length) return rm(CREDENTIALS, { force: true });
  await mkdir(dirname(CREDENTIALS), { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS, `${lines.join("\n")}\n`, { mode: 0o600 });
  await chmod(CREDENTIALS, 0o600).catch(() => {});
}

/**
 * Save a new key: the password store unless `--store file` (or none is usable), verified by reading
 * it back. Any key left in the plain file is removed once the store holds it.
 * @returns where it was saved.
 */
async function saveCredentials(key, origin) {
  const wantFile = flags.get("store") === "file";
  if (!wantFile && SAFE.test(key) && SAFE.test(origin)) {
    try {
      await passwordStore.set(origin, key);
      if ((await passwordStore.get(origin)) === key) {
        await writeCredentialsFile({ key: null, origin });
        return passwordStore.name;
      }
    } catch (e) {
      console.error(
        `attachpage: could not use ${passwordStore.name} (${e.message}); saving to ${CREDENTIALS}.`,
      );
    }
  }
  await writeCredentialsFile({ key, origin });
  return `${CREDENTIALS} (readable only by you)`;
}

// ---------- HTTP ----------

async function api(origin, method, path, { key, body } = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${origin}${path}`, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "User-Agent": `attachpage-cli/${VERSION}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: text.slice(0, 200) } };
  }
  if (!res.ok) {
    const err = data.error || {};
    const findings = err.details?.findings;
    const detail = Array.isArray(findings)
      ? `\n${findings.map((f) => `  - ${f.path ?? ""} ${f.message}`).join("\n")}`
      : "";
    const e = new Error(`${err.message || res.statusText} (${res.status})${detail}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

// ---------- files ----------

async function walk(dir, root = dir, list = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, root, list);
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      list.push({ full, path: relative(root, full).split(sep).join("/"), size: (await stat(full)).size });
    }
  }
  return list;
}

async function loadFolder(folderArg) {
  const folder = resolve(folderArg || ".");
  let info;
  try {
    info = await stat(folder);
  } catch {
    fail(`${folder} does not exist`);
  }
  if (!info.isDirectory()) fail(`${folder} is not a folder`);
  const files = await walk(folder);
  if (!files.some((f) => f.path === "index.html")) {
    const hint = files.some((f) => f.path.startsWith("dist/index.html"))
      ? " Did you mean ./dist?"
      : files.some((f) => f.path.startsWith("build/index.html"))
        ? " Did you mean ./build?"
        : "";
    fail(`${folder} has no index.html at the top level.${hint}`);
  }
  return { folder, files };
}

async function uploadAll(targets, files, bearer, origin) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++];
      const file = byPath.get(t.path);
      if (!file) continue;
      const headers = { ...(t.headers || {}) };
      if (t.url.startsWith(origin)) headers.Authorization = `Bearer ${bearer}`;
      const res = await fetch(t.url, { method: t.method || "PUT", headers, body: await readFile(file.full) });
      if (!res.ok)
        throw new Error(`upload of ${t.path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      done++;
      if (!asJson && process.stderr.isTTY)
        process.stderr.write(`\r  uploaded ${done}/${targets.length} files`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
  if (!asJson && process.stderr.isTTY) process.stderr.write("\n");
}

// ---------- commands ----------

async function publish({ send = false } = {}) {
  const { key, origin } = await readCredentials();
  const { folder, files } = await loadFolder(positional[send ? 1 : positional[0] === "publish" ? 1 : 0]);
  const manifest = files.map((f) => ({ path: f.path, size: f.size }));
  const name = typeof flags.get("name") === "string" ? flags.get("name") : folder.split(sep).pop();
  const slug = typeof flags.get("slug") === "string" ? flags.get("slug") : undefined;
  const siteId = typeof flags.get("site") === "string" ? flags.get("site") : undefined;

  if (!key) {
    if (send) fail("Sending needs an account. Run `npx attachpage login` first.");
    const anon = await api(origin, "POST", "/api/v1/anonymous/publish", {
      body: { siteName: name, slug, files: manifest },
    }).catch((e) =>
      fail(e.status === 403 ? `${e.message}\nSign in to publish: npx attachpage login` : e.message),
    );
    await uploadAll(anon.targets, files, anon.uploadToken, origin);
    const fin = await api(origin, "POST", anon.next, { key: anon.uploadToken, body: {} });
    const url = fin.url || anon.url;
    return out(
      `Published (public, expires in 48 hours):\n${url}\n\nKeep it: open this link while signed in:\n${anon.claimUrl}`,
      { url, claimUrl: anon.claimUrl, expiresAt: anon.expiresAt, siteId: anon.siteId },
    );
  }

  const created = await api(origin, "POST", "/api/v1/publish", {
    key,
    body: {
      siteName: name,
      ...(siteId ? { siteId } : slug ? { slug } : {}),
      ...(flags.has("public") ? { visibility: "public" } : {}),
      files: manifest,
    },
  }).catch((e) => fail(e.message));
  await uploadAll(created.targets, files, key, origin);
  const fin = await api(origin, "POST", created.next, { key, body: {} });
  let sent = null;
  if (send) {
    const to = String(flags.get("to") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (to.length === 0) fail("Add --to name@example.com (comma-separated for several people).");
    sent = await api(origin, "POST", `/api/v1/sites/${fin.siteId}/send`, {
      key,
      body: {
        recipients: to,
        message: typeof flags.get("message") === "string" ? flags.get("message") : "",
        ...(flags.has("expires") ? { expiresInDays: Number(flags.get("expires")) } : {}),
      },
    });
  }
  let notified = null;
  if (siteId && flags.has("notify")) {
    notified = await api(origin, "POST", `/api/v1/sites/${siteId}/notify-update`, {
      key,
      body: { note: typeof flags.get("notify") === "string" ? flags.get("notify") : "" },
    });
  }
  const lines = [fin.url, ""];
  lines.push(
    fin.visibility === "public"
      ? "Public: anyone with the link can open it."
      : "Private: people need an invitation to open it.",
  );
  if (sent) lines.push(`Sent to ${String(flags.get("to"))}. Each person got their own link.`);
  if (notified)
    lines.push(
      `Told ${notified.notified} ${notified.notified === 1 ? "person" : "people"} about the update.`,
    );
  lines.push(`Page id: ${fin.siteId}`);
  out(lines.join("\n"), { ...fin, sent, notified });
}

async function login() {
  const { origin } = await readCredentials();
  const start = await api(origin, "POST", "/api/v1/device/start", {
    body: { clientName: "AttachPage CLI" },
  }).catch((e) => fail(e.message));
  console.error(`Open ${start.verificationUrl} and press Allow (code ${start.userCode}).`);
  if (!flags.has("no-browser")) openBrowser(start.verificationUrl);
  const deadline = Date.now() + (start.expiresIn || 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, (start.interval || 3) * 1000));
    const poll = await api(origin, "POST", "/api/v1/device/poll", { body: { deviceCode: start.deviceCode } });
    if (poll.status === "approved" && poll.apiKey) {
      const savedTo = await saveCredentials(poll.apiKey, origin);
      const me = await api(origin, "GET", "/api/auth/me", { key: poll.apiKey }).catch(() => ({}));
      return out(`Signed in${me.user ? ` as ${me.user.email}` : ""}. Key saved to ${savedTo}.`, {
        ok: true,
        email: me.user?.email ?? null,
        savedTo,
      });
    }
    if (poll.status === "denied" || poll.status === "expired" || poll.status === "claimed")
      fail(`Sign-in ${poll.status}.`);
  }
  fail("Sign-in timed out.");
}

function openBrowser(url) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    /* printing the link is enough */
  }
}

async function logout() {
  const { origin } = await readCredentials();
  const removed = [];
  const file = await readCredentialsFile();
  if (file.key) {
    await writeCredentialsFile({ key: null, origin: file.origin });
    removed.push(CREDENTIALS);
  }
  if (SAFE.test(origin)) {
    try {
      if (await passwordStore.remove(origin)) removed.push(passwordStore.name);
    } catch {
      /* no usable password store */
    }
  }
  out(
    removed.length
      ? `Signed out on this machine: removed the key from ${removed.join(" and ")}. (Revoke it under For agents if it may have leaked.)`
      : "No saved key on this machine.",
    { ok: true, removedFrom: removed },
  );
}

async function feedback() {
  const { key, origin } = await readCredentials();
  if (!key) fail("Run `npx attachpage login` first.");
  const siteId = positional[1];
  if (!siteId) fail("Usage: attachpage feedback <siteId> [--all]");
  const data = await api(
    origin,
    "GET",
    `/api/v1/sites/${siteId}/feedback${flags.has("all") ? "" : "?status=open"}`,
    {
      key,
    },
  ).catch((e) => fail(e.message));
  if (asJson) return out("", data);
  for (const d of data.decisions)
    console.log(`${d.decision === "approval" ? "APPROVED" : "CHANGES REQUESTED"}  ${d.email}`);
  if (data.items.length === 0) return console.log("No open feedback.");
  for (const i of data.items) {
    const where = i.anchor ? ` on "${i.anchor.text || i.anchor.selector}"` : "";
    console.log(`\n[${i.id}] ${i.authorEmail}${where} (${i.pagePath})\n  ${i.body.replace(/\n/g, "\n  ")}`);
  }
}

async function whoami() {
  const { key, origin, source } = await readCredentials();
  if (!key) return out(`Not signed in (${origin}).`, { signedIn: false, origin });
  const me = await api(origin, "GET", "/api/auth/me", { key }).catch((e) => fail(e.message));
  out(`${me.user?.email ?? "unknown"} on ${origin} (key from ${source})`, {
    signedIn: true,
    email: me.user?.email,
    origin,
    source,
  });
}

// ---------- connect ----------
//
// Add the AttachPage MCP server to the AI apps on this computer. Apps with their own command line
// (Claude Code, Codex, Gemini CLI) are set up through it; Cursor and VS Code through their user
// config file, backed up first. Existing AttachPage entries are left alone, and a file that cannot be
// read as plain JSON is never rewritten (the snippet to paste is printed instead).

const CONNECT_HOME = process.env.ATTACHPAGE_CONNECT_HOME || homedir();

/** Run an app's own CLI. Windows npm shims are .cmd files, which need a shell; every argument is a
 * fixed token or the validated server URL, so nothing needs quoting. */
function runCli(bin, args) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch {
      return done({ code: -1, missing: true, out: "" });
    }
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("error", () => done({ code: -1, missing: true, out }));
    child.on("close", (code) =>
      done({ code: code ?? -1, missing: code === 9009 || /not recognized|not found/i.test(out), out }),
    );
  });
}

async function readJsonFile(file) {
  try {
    return { ok: true, data: JSON.parse(await readFile(file, "utf8")) };
  } catch (e) {
    return e.code === "ENOENT" ? { ok: true, data: {} } : { ok: false };
  }
}

async function dirExists(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Add `entry` under `root[key].attachpage` in a JSON config file. */
async function addToJsonConfig(file, key, entry, dryRun) {
  const read = await readJsonFile(file);
  if (!read.ok)
    return {
      status: "manual",
      note: `could not read ${file} as plain JSON; add this yourself:\n${JSON.stringify({ [key]: { attachpage: entry } }, null, 2)}`,
    };
  const data = read.data && typeof read.data === "object" ? read.data : {};
  if (data[key]?.attachpage) return { status: "already" };
  if (dryRun) return { status: "would-add", note: file };
  try {
    const existing = await readFile(file, "utf8");
    await writeFile(`${file}.bak-attachpage`, existing, { flag: "wx" }).catch(() => {});
  } catch {
    /* new file */
  }
  data[key] = { ...(data[key] ?? {}), attachpage: entry };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
  return { status: "added", note: file };
}

function vscodeUserDir() {
  if (process.platform === "win32")
    return join(process.env.APPDATA || join(CONNECT_HOME, "AppData", "Roaming"), "Code", "User");
  if (process.platform === "darwin")
    return join(CONNECT_HOME, "Library", "Application Support", "Code", "User");
  return join(CONNECT_HOME, ".config", "Code", "User");
}

async function connect() {
  const { origin } = await readCredentials();
  if (!SAFE.test(origin)) fail("That --origin cannot be used here.");
  const url = `${origin}/mcp`;
  const dryRun = flags.has("dry-run");
  const only = typeof flags.get("client") === "string" ? String(flags.get("client")).split(",") : null;
  const viaCli = [
    {
      id: "claude-code",
      name: "Claude Code",
      bin: "claude",
      args: ["mcp", "add", "--transport", "http", "--scope", "user", "attachpage", url],
      next: "In Claude Code, run /mcp and sign in to AttachPage.",
    },
    {
      id: "codex",
      name: "OpenAI Codex",
      bin: "codex",
      args: ["mcp", "add", "attachpage", "--url", url],
      next: "Run: codex mcp login attachpage",
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      bin: "gemini",
      args: ["mcp", "add", "--transport", "http", "attachpage", url],
      next: "In Gemini CLI, run /mcp auth attachpage.",
    },
  ];
  const results = [];
  for (const c of viaCli) {
    if (only && !only.includes(c.id)) continue;
    const probe = await runCli(c.bin, ["--version"]);
    if (probe.missing || probe.code !== 0) {
      results.push({ app: c.name, status: "not-found" });
      continue;
    }
    if (dryRun) {
      results.push({ app: c.name, status: "would-add", note: `${c.bin} ${c.args.join(" ")}` });
      continue;
    }
    const r = await runCli(c.bin, c.args);
    if (r.code === 0) results.push({ app: c.name, status: "added", note: c.next });
    else if (/already exists|already configured|already added/i.test(r.out))
      results.push({ app: c.name, status: "already" });
    else results.push({ app: c.name, status: "failed", note: r.out.trim().split("\n").slice(-1)[0] });
  }
  if (!only || only.includes("cursor")) {
    const dir = join(CONNECT_HOME, ".cursor");
    results.push(
      (await dirExists(dir))
        ? { app: "Cursor", ...(await addToJsonConfig(join(dir, "mcp.json"), "mcpServers", { url }, dryRun)) }
        : { app: "Cursor", status: "not-found" },
    );
  }
  if (!only || only.includes("vscode")) {
    const dir = vscodeUserDir();
    results.push(
      (await dirExists(dir))
        ? {
            app: "VS Code",
            ...(await addToJsonConfig(join(dir, "mcp.json"), "servers", { type: "http", url }, dryRun)),
          }
        : { app: "VS Code", status: "not-found" },
    );
  }
  const label = {
    added: "added",
    already: "already set up",
    "would-add": "would add",
    "not-found": "not installed",
    manual: "needs a manual step",
    failed: "failed",
  };
  const lines = results.map((r) => `  ${r.app.padEnd(14)} ${label[r.status]}${r.note ? `: ${r.note}` : ""}`);
  lines.push(
    "",
    `Server: ${url}`,
    "Each app asks you to sign in to AttachPage the first time you use it.",
    "Claude and ChatGPT on the web: Settings > Connectors > Add custom connector, with the server above.",
  );
  out(lines.join("\n"), { server: url, dryRun, results });
}

const HELP = `attachpage ${VERSION}: send websites like attachments

Usage
  attachpage <folder> [--name "Q3 report"] [--slug q3-report] [--public] [--site <id> [--notify "note"]]
  attachpage send <folder> --to a@b.com,c@d.com [--message "..."] [--expires 7]
  attachpage login [--no-browser] [--store file] | logout | whoami
  attachpage connect [--client claude-code,codex,gemini,cursor,vscode] [--dry-run]
  attachpage feedback <siteId> [--all]

Sign in once with \`attachpage login\` (Google or Microsoft account). Signed-in pages are private by
default: only the people you send them to can open them. Without signing in, a folder is published
as a public page that expires in 48 hours, with a link to keep it.
Options: --json for machine-readable output, --origin to use another server.
\`login\` keeps the key in your system's password store (Windows Credential Manager, macOS Keychain,
or the Linux keyring); --store file keeps it in ~/.attachpage/credentials instead.`;

const command = positional[0];
try {
  if (flags.has("version")) console.log(VERSION);
  else if (!command || flags.has("help")) console.log(HELP);
  else if (command === "login") await login();
  else if (command === "logout") await logout();
  else if (command === "whoami") await whoami();
  else if (command === "connect") await connect();
  else if (command === "feedback") await feedback();
  else if (command === "send") await publish({ send: true });
  else await publish();
} catch (err) {
  fail(err.message);
}
