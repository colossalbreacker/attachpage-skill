// End-to-end tests of where `attachpage login` keeps the key, against a local mock of the API.
// They use the real operating-system password store when one is usable (an entry for a
// http://127.0.0.1:<port> account, removed again by `logout`) and otherwise the file fallback.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/attachpage.mjs", import.meta.url));
const KEY = "ap_test_key_0123456789";
let server;
let origin;
let dir;
let credentialsFile;

before(async () => {
  server = createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/v1/device/start")
      return reply(200, {
        deviceCode: "dev",
        userCode: "ABCD-EFGH",
        verificationUrl: `${origin}/link`,
        interval: 0.05,
        expiresIn: 30,
      });
    if (req.url === "/api/v1/device/poll") return reply(200, { status: "approved", apiKey: KEY });
    if (req.url === "/api/auth/me") {
      const auth = req.headers.authorization ?? "";
      return auth === `Bearer ${KEY}` || auth === "Bearer ap_env_key"
        ? reply(200, { user: { email: auth.includes("env") ? "env@example.com" : "owner@example.com" } })
        : reply(401, { error: { message: "Sign in required" } });
    }
    reply(404, { error: { message: "not found" } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  dir = await mkdtemp(join(tmpdir(), "attachpage-cli-"));
  credentialsFile = join(dir, "credentials");
});

after(async () => {
  await cli(["logout"]).catch(() => {});
  server.close();
  await rm(dir, { recursive: true, force: true });
});

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args, "--origin", origin, "--json"],
      {
        env: { ...process.env, ATTACHPAGE_API_KEY: "", ATTACHPAGE_CREDENTIALS_FILE: credentialsFile, ...env },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        try {
          resolve({ ...JSON.parse(stdout.trim().split("\n").filter(Boolean).join("\n") || "{}"), stderr });
        } catch {
          reject(error ?? new Error(`unexpected output: ${stdout} ${stderr}`));
        }
      },
    );
  });
}

async function fileText() {
  return readFile(credentialsFile, "utf8").catch(() => "");
}

test("login keeps the key out of the plain file when a password store is usable", async () => {
  const login = await cli(["login", "--no-browser"]);
  assert.equal(login.ok, true);
  assert.equal(login.email, "owner@example.com");
  const who = await cli(["whoami"]);
  assert.equal(who.signedIn, true);
  if (login.savedTo.includes("readable only by you")) {
    // No password store on this machine: the file fallback holds it.
    assert.match(await fileText(), new RegExp(`ATTACHPAGE_API_KEY=${KEY}`));
    assert.equal(who.source, credentialsFile);
  } else {
    assert.doesNotMatch(await fileText(), /ATTACHPAGE_API_KEY/);
    assert.equal(who.source, login.savedTo);
  }

  const out = await cli(["logout"]);
  assert.ok(out.removedFrom.length >= 1);
  assert.equal((await cli(["whoami"])).signedIn, false);
});

test("--store file writes an owner-only file, and logout clears it", async () => {
  const login = await cli(["login", "--no-browser", "--store", "file"]);
  assert.match(login.savedTo, /readable only by you/);
  assert.match(await fileText(), new RegExp(`ATTACHPAGE_API_KEY=${KEY}`));
  if (process.platform !== "win32") assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
  assert.equal((await cli(["whoami"])).source, credentialsFile);
  const out = await cli(["logout"]);
  assert.deepEqual(out.removedFrom, [credentialsFile]);
  assert.doesNotMatch(await fileText(), /ATTACHPAGE_API_KEY/);
});

test("ATTACHPAGE_API_KEY wins over saved keys", async () => {
  const who = await cli(["whoami"], { ATTACHPAGE_API_KEY: "ap_env_key" });
  assert.equal(who.email, "env@example.com");
  assert.equal(who.source, "environment");
});
