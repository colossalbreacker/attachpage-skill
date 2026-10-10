#!/usr/bin/env node
/**
 * Publish a static folder through AttachPage and optionally send it.
 *
 *   node publish.mjs <folder> --name "Q3 report" [--slug q3-report] [--site <siteId>]
 *                    [--to a@b.com,c@d.com] [--message "…"] [--expires 7] [--origin https://attachpage.com]
 *   node publish.mjs login [--store os|file] [--key-stdin] [--origin …]
 *   node publish.mjs logout [--store os|file] [--origin …]
 *
 * Credentials, first match wins: ATTACHPAGE_API_KEY (+ optional ATTACHPAGE_ORIGIN, default
 * https://attachpage.com) in the environment, ~/.attachpage/credentials (or ATTACHPAGE_CREDENTIALS_FILE),
 * then the operating system's credential manager (Windows Credential Manager, macOS Keychain, or the
 * Secret Service via secret-tool).
 * `login` signs in through the browser and saves the key to the credential manager, or to the file with
 * `--store file`; `--key-stdin` saves a key piped on standard input instead of signing in.
 * Exit code 0 on success; the page URL is printed on its own line.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_ORIGIN = "https://attachpage.com";
const CREDENTIALS_FILE = process.env.ATTACHPAGE_CREDENTIALS_FILE || join(homedir(), ".attachpage", "credentials");

const args = process.argv.slice(2);
const command = ["login", "logout"].includes(args[0]) ? args[0] : undefined;
const folder = command ? undefined : args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (!command && !folder) {
  console.error(
    "usage: publish.mjs <folder> --name <name> [--slug <slug>] [--site <id>] [--to a@b.com,…] [--message …] [--expires 7]\n" +
      "       publish.mjs login [--store os|file] [--key-stdin] [--origin <url>]\n" +
      "       publish.mjs logout [--store os|file] [--origin <url>]",
  );
  process.exit(2);
}

async function readCredentialsFile() {
  const found = {};
  try {
    const text = await readFile(CREDENTIALS_FILE, "utf8");
    for (const line of text.split("\n")) {
      const [k, v] = line.split("=");
      if (k?.trim() === "ATTACHPAGE_API_KEY") found.key ??= v?.trim();
      if (k?.trim() === "ATTACHPAGE_ORIGIN") found.origin ??= v?.trim();
    }
  } catch {
    /* no credentials file */
  }
  return found;
}

async function credentials() {
  const env = { key: process.env.ATTACHPAGE_API_KEY, origin: process.env.ATTACHPAGE_ORIGIN };
  if (env.key && env.origin) return { ...env, origin: opt("origin", env.origin) };
  const file = await readCredentialsFile();
  env.key ??= file.key;
  env.origin ??= file.origin;
  env.origin = opt("origin", env.origin ?? DEFAULT_ORIGIN);
  // The credential manager is the last resort, so it is only consulted when nothing else is configured.
  let unavailable;
  if (!env.key) {
    try {
      env.key = await credentialManager.get(env.origin);
    } catch (error) {
      unavailable = error.message;
    }
  }
  if (!env.key) {
    console.error(
      `Missing credentials: set ATTACHPAGE_API_KEY, add it to ~/.attachpage/credentials, or run ` +
        `"publish.mjs login" to sign in and save a key to ${credentialManager.name}.`,
    );
    if (unavailable) console.error(`${capitalize(credentialManager.name)} is unavailable: ${unavailable}`);
    process.exit(2);
  }
  return env;
}

// The operating system's default credential manager. Entries are per origin so keys for different
// AttachPage deployments can coexist: the generic credential "attachpage:<origin>" on Windows, and
// service "attachpage" with account "<origin>" in the macOS Keychain and the Secret Service.
const SERVICE = "attachpage";

function originId(origin) {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

function run(file, argv, { input = "", env, timeout = 60_000 } = {}) {
  return new Promise((done) => {
    const child = execFile(
      file,
      argv,
      { env: env && { ...process.env, ...env }, timeout, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) =>
        done({ code: error ? error.code : 0, killed: error?.killed, stdout, stderr: stderr.trim() }),
    );
    child.stdin.on("error", () => {}); // the tool may exit without reading its input
    child.stdin.end(input);
  });
}

function toolError(tool, result) {
  if (result.code === "ENOENT") return new Error(`${tool} is not installed`);
  if (result.killed) return new Error(`${tool} did not respond`);
  return new Error(result.stderr || `${tool} exited with code ${result.code}`);
}

// Generic credentials through advapi32. The secret is UTF-16, as the Credential Manager window and
// cmdkey store it, so an entry added by hand works too. Secrets only travel over stdin and stdout.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AttachPageCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr buffer);
  const int GENERIC = 1, PERSIST_LOCAL_MACHINE = 2, NOT_FOUND = 1168;

  public static byte[] Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, GENERIC, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == NOT_FOUND) return null;
      throw new Win32Exception(error);
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] blob = new byte[credential.CredentialBlobSize];
      if (blob.Length > 0) Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
      return blob;
    } finally { CredFree(pointer); }
  }

  public static void Write(string target, string user, byte[] blob) {
    CREDENTIAL credential = new CREDENTIAL();
    credential.Type = GENERIC; credential.TargetName = target; credential.UserName = user;
    credential.Persist = PERSIST_LOCAL_MACHINE; credential.CredentialBlobSize = blob.Length;
    credential.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, credential.CredentialBlob, blob.Length);
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(credential.CredentialBlob); }
  }

  public static bool Delete(string target) {
    if (CredDelete(target, GENERIC, 0)) return true;
    int error = Marshal.GetLastWin32Error();
    if (error == NOT_FOUND) return false;
    throw new Win32Exception(error);
  }
}
'@
  $target = $env:ATTACHPAGE_CREDENTIAL_TARGET
  switch ($env:ATTACHPAGE_CREDENTIAL_OP) {
    'get' {
      $blob = [AttachPageCredential]::Read($target)
      if ($null -eq $blob) { exit 3 }
      [Console]::Out.Write([Convert]::ToBase64String($blob))
    }
    'set' { [AttachPageCredential]::Write($target, 'api-key', [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) }
    'delete' { if (-not [AttachPageCredential]::Delete($target)) { exit 3 } }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

async function windowsCredential(op, origin, input) {
  // Full path: a powershell.exe in the folder being published must never run instead.
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
  const env = { ATTACHPAGE_CREDENTIAL_OP: op, ATTACHPAGE_CREDENTIAL_TARGET: `${SERVICE}:${originId(origin)}` };
  const result = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    input,
    env,
    timeout: 30_000,
  });
  if (result.code !== 0 && result.code !== 3) throw toolError("PowerShell", result);
  return result;
}

// `security -i` reads the command from stdin, which keeps the key out of the process list.
function securityArg(value) {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  if (/['\r\n]/.test(value)) throw new Error("the value cannot be stored in the Keychain");
  return `'${value}'`;
}

const credentialManagers = {
  win32: {
    name: "Windows Credential Manager",
    async get(origin) {
      const result = await windowsCredential("get", origin);
      if (result.code === 3 || !result.stdout) return undefined;
      const blob = Buffer.from(result.stdout, "base64");
      // Other tools store UTF-8; UTF-16 text has a zero high byte for every ASCII character.
      const utf16 = blob.length % 2 === 0 && blob.every((byte, i) => i % 2 === 0 || byte === 0);
      return blob.toString(utf16 ? "utf16le" : "utf8").trim() || undefined;
    },
    async set(origin, key) {
      await windowsCredential("set", origin, Buffer.from(key, "utf16le").toString("base64"));
    },
    async delete(origin) {
      return (await windowsCredential("delete", origin)).code === 0;
    },
  },
  darwin: {
    name: "the macOS Keychain",
    async get(origin) {
      const result = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", originId(origin), "-w"]);
      if (result.code === 44) return undefined; // errSecItemNotFound
      if (result.code !== 0) throw toolError("security", result);
      return result.stdout.trim() || undefined;
    },
    async set(origin, key) {
      const input = `add-generic-password -U -s ${SERVICE} -a ${securityArg(originId(origin))} -w ${securityArg(key)}\n`;
      const result = await run("/usr/bin/security", ["-i"], { input });
      if (result.code !== 0) throw toolError("security", result);
    },
    async delete(origin) {
      const result = await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", originId(origin)]);
      if (result.code === 44) return false;
      if (result.code !== 0) throw toolError("security", result);
      return true;
    },
  },
  secretService: {
    name: "the Secret Service keyring",
    async get(origin) {
      const result = await run("secret-tool", ["lookup", "service", SERVICE, "account", originId(origin)]);
      if (result.code === 1 && !result.stderr) return undefined; // no matching secret
      if (result.code !== 0) throw toolError("secret-tool", result);
      return result.stdout.trim() || undefined;
    },
    async set(origin, key) {
      const id = originId(origin);
      const argv = ["store", "--label", `AttachPage API key (${id})`, "service", SERVICE, "account", id];
      const result = await run("secret-tool", argv, { input: key });
      if (result.code !== 0) throw toolError("secret-tool", result);
    },
    async delete(origin) {
      if (!(await this.get(origin))) return false;
      const result = await run("secret-tool", ["clear", "service", SERVICE, "account", originId(origin)]);
      if (result.code !== 0) throw toolError("secret-tool", result);
      return true;
    },
  },
};
const credentialManager = credentialManagers[process.platform] ?? credentialManagers.secretService;
const capitalize = (text) => text[0].toUpperCase() + text.slice(1);

async function saveToFile(origin, key) {
  let lines = [];
  try {
    lines = (await readFile(CREDENTIALS_FILE, "utf8")).split("\n");
  } catch {
    /* no credentials file yet */
  }
  lines = lines.filter((line) => line.trim() && !/^\s*ATTACHPAGE_(API_KEY|ORIGIN)\s*=/.test(line));
  lines.push(`ATTACHPAGE_API_KEY=${key}`, `ATTACHPAGE_ORIGIN=${originId(origin)}`);
  await mkdir(dirname(CREDENTIALS_FILE), { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_FILE, `${lines.join("\n")}\n`, { mode: 0o600 });
  await chmod(CREDENTIALS_FILE, 0o600);
}

function storeOption() {
  const store = opt("store", "os");
  if (store !== "os" && store !== "file") throw new Error('--store must be "os" or "file".');
  return store;
}

async function defaultOrigin() {
  return opt("origin", process.env.ATTACHPAGE_ORIGIN ?? (await readCredentialsFile()).origin ?? DEFAULT_ORIGIN);
}

async function keyFromStdin() {
  if (process.stdin.isTTY)
    throw new Error("--key-stdin reads the key from a pipe, for example: <command> | node publish.mjs login --key-stdin");
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const key = text.trim();
  if (!key || /\s/.test(key)) throw new Error("Expected one API key on standard input.");
  return key;
}

async function deviceSignIn(origin) {
  const start = await api(origin, undefined, "/api/v1/device/start", {
    method: "POST",
    body: JSON.stringify({ clientName: "AttachPage publish.mjs" }),
  });
  console.error("To save an AttachPage key on this computer, open this page and enter the code:");
  console.error(`  ${start.verificationUrl}`);
  console.error(`  ${start.userCode}`);
  console.error("Waiting for approval…");
  const interval = Math.max(1, Number(start.interval) || 5) * 1000;
  for (const deadline = Date.now() + 15 * 60_000; Date.now() < deadline; ) {
    await sleep(interval);
    const poll = await api(origin, undefined, "/api/v1/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    });
    if (poll.status === "approved" && poll.apiKey) return poll.apiKey;
    if (poll.status !== "pending") throw new Error(`Sign-in ${poll.status ?? "failed"}.`);
  }
  throw new Error("Sign-in timed out.");
}

async function login() {
  const store = storeOption();
  const origin = await defaultOrigin();
  if (store === "os") {
    // A signed-in key is issued once, so make sure it has somewhere to go first.
    try {
      await credentialManager.get(origin);
    } catch (error) {
      throw new Error(
        `${capitalize(credentialManager.name)} is unavailable: ${error.message}\n` +
          `Run "publish.mjs login --store file" to save the key to ${CREDENTIALS_FILE} instead.`,
      );
    }
  }
  const key = args.includes("--key-stdin") ? await keyFromStdin() : await deviceSignIn(origin);

  let saved = store === "os" ? credentialManager.name : CREDENTIALS_FILE;
  if (store === "os") {
    try {
      await credentialManager.set(origin, key);
      if ((await credentialManager.get(origin)) !== key) throw new Error("the saved key did not read back");
    } catch (error) {
      console.error(`Could not save to ${credentialManager.name}: ${error.message}`);
      saved = CREDENTIALS_FILE;
    }
  }
  if (saved === CREDENTIALS_FILE) await saveToFile(origin, key);
  console.error(`Saved the AttachPage key for ${originId(origin)} to ${saved}.`);

  if (saved !== CREDENTIALS_FILE) {
    if (process.env.ATTACHPAGE_API_KEY)
      console.error("ATTACHPAGE_API_KEY is set in the environment and is used before the saved key.");
    else if ((await readCredentialsFile()).key)
      console.error(`${CREDENTIALS_FILE} also holds a key and is used first; remove it to use the saved key.`);
    if (originId(origin) !== originId(DEFAULT_ORIGIN) && !process.env.ATTACHPAGE_ORIGIN)
      console.error(`Publish with --origin ${originId(origin)} (or set ATTACHPAGE_ORIGIN) to use it.`);
  }
}

async function logout() {
  const store = storeOption();
  const origin = await defaultOrigin();
  if (store === "file") {
    let text = "";
    try {
      text = await readFile(CREDENTIALS_FILE, "utf8");
    } catch {
      /* no credentials file */
    }
    const lines = text.split("\n");
    const kept = lines.filter((line) => !/^\s*ATTACHPAGE_API_KEY\s*=/.test(line));
    if (kept.length !== lines.length) await writeFile(CREDENTIALS_FILE, kept.join("\n"));
    console.error(
      kept.length !== lines.length ? `Removed the key from ${CREDENTIALS_FILE}.` : `No key in ${CREDENTIALS_FILE}.`,
    );
  } else {
    const removed = await credentialManager.delete(origin);
    console.error(
      removed
        ? `Removed the AttachPage key for ${originId(origin)} from ${credentialManager.name}.`
        : `No AttachPage key for ${originId(origin)} in ${credentialManager.name}.`,
    );
  }
}

async function walk(dir, root = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...(await walk(full, root)));
    else if (entry.isFile())
      out.push({ full, path: relative(root, full).split(sep).join("/"), size: (await stat(full)).size });
  }
  return out;
}

async function api(origin, key, path, init = {}) {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      // Device sign-in runs before there is a key.
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const findings = body?.error?.details?.findings;
    if (findings)
      for (const f of findings) console.error(`${f.level}: ${f.message}${f.hint ? `: ${f.hint}` : ""}`);
    throw new Error(body?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return body;
}

async function publish() {
  const { key, origin } = await credentials();
  const root = resolve(folder);
  let published;
  if ((await stat(root)).isFile()) {
    // Multipart keeps documents out of JSON/base64 size limits and preserves the original filename.
    const form = new FormData();
    form.set("file", new Blob([await readFile(root)]), basename(root));
    for (const [flag, field] of [
      ["name", "siteName"],
      ["slug", "slug"],
      ["site", "siteId"],
    ]) {
      const value = opt(flag, undefined);
      if (value) form.set(field, value);
    }
    published = await api(origin, key, "/api/v1/documents/publish", { method: "POST", body: form });
  } else {
    const files = await walk(root);
    if (!files.some((f) => f.path === "index.html")) {
      console.error("The folder needs an index.html at its top level.");
      process.exit(1);
    }

    const created = await api(origin, key, "/api/v1/publish", {
      method: "POST",
      body: JSON.stringify({
        siteName: opt("name", undefined),
        slug: opt("slug", undefined),
        siteId: opt("site", undefined),
        files: files.map((f) => ({ path: f.path, size: f.size })),
      }),
    });
    for (const f of created.findings ?? []) if (f.level !== "error") console.error(`${f.level}: ${f.message}`);

    const byPath = new Map(files.map((f) => [f.path, f.full]));
    let done = 0;
    const queue = [...created.targets];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          const target = new URL(t.url);
          const uploadHeaders = new Headers(t.headers);
          // Direct storage URLs carry their own short-lived signature, never our account key.
          if (target.origin === new URL(origin).origin) uploadHeaders.set("Authorization", `Bearer ${key}`);
          else uploadHeaders.delete("Authorization");
          const res = await fetch(t.url, {
            method: t.method,
            headers: uploadHeaders,
            body: await readFile(byPath.get(t.path)),
          });
          if (!res.ok) throw new Error(`upload failed for ${t.path}: ${res.status}`);
          done++;
          process.stderr.write(`\ruploaded ${done}/${created.targets.length}`);
        }
      }),
    );
    process.stderr.write("\n");

    published = await api(origin, key, `/api/v1/publish/${created.uploadSessionId}/finalize`, {
      method: "POST",
    });
  }
  console.log(published.url);

  const to = opt("to", "");
  if (to) {
    const recipients = to
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const share = await api(origin, key, `/api/v1/sites/${published.siteId}/send`, {
      method: "POST",
      body: JSON.stringify({
        recipients,
        message: opt("message", ""),
        expiresInDays: Number(opt("expires", "7")),
      }),
    });
    console.error(
      `sent to ${recipients.length} recipient(s); access ends ${new Date(share.expiresAt).toISOString()}`,
    );
  }
}

if (command) {
  await (command === "login" ? login() : logout()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  await publish();
}
