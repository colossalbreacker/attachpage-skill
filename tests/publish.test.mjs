// End-to-end tests for scripts/publish.mjs against a local mock of the AttachPage API.
// Run with `node --test tests/`. Credential manager tests create and remove entries for a
// 127.0.0.1 origin only; set REQUIRE_OS_STORE=1 to fail instead of skipping when none is usable.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/publish.mjs", import.meta.url));
const env = { ...process.env };
for (const name of ["ATTACHPAGE_API_KEY", "ATTACHPAGE_ORIGIN", "ATTACHPAGE_CREDENTIALS_FILE"]) delete env[name];

let dir, credentialsFile, folder, documentFile, api, storage, origin, osStore;
let state;

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      state.requests.push({ ...request, server: server === storage?.server ? "storage" : "api" });
      const [status, json] = handler(request);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

function apiHandler({ method, url, headers, body }) {
  if (method === "POST" && url === "/api/v1/device/start")
    return [201, { deviceCode: "dc-1", userCode: "WXYZ-1234", verificationUrl: `${origin}/device`, interval: 1 }];
  if (method === "POST" && url === "/api/v1/device/poll") {
    if (JSON.parse(body).deviceCode !== "dc-1") return [400, { error: { message: "unknown device code" } }];
    return [200, state.device === "approved" ? { status: "approved", apiKey: state.deviceKey } : { status: state.device }];
  }
  if (!headers.authorization) return [401, { error: { message: "unauthorized" } }];
  if (method === "POST" && url === "/api/v1/documents/publish") return [200, { url: `${origin}/p/document`, siteId: "s1" }];
  if (method === "POST" && url === "/api/v1/publish") {
    const targets = JSON.parse(body).files.map(({ path }) =>
      path === "index.html"
        ? { path, url: `${origin}/upload/${path}`, method: "PUT", headers: {} }
        : { path, url: `${storage.origin}/bucket/${path}`, method: "PUT", headers: { "x-signature": "signed" } },
    );
    return [200, { uploadSessionId: "u1", targets, findings: [] }];
  }
  if (method === "PUT" && url.startsWith("/upload/")) return [200, {}];
  if (method === "POST" && url === "/api/v1/publish/u1/finalize")
    return state.finalizeFails ? [500, { error: { message: "finalize failed" } }] : [200, { url: `${origin}/p/site`, siteId: "s1" }];
  if (method === "POST" && url === "/api/v1/sites/s1/send") return [200, { expiresAt: new Date().toISOString() }];
  return [404, { error: { message: "not found" } }];
}

function run(argv, { extraEnv = {}, input = "" } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [script, ...argv],
      { env: { ...env, ATTACHPAGE_CREDENTIALS_FILE: credentialsFile, ...extraEnv }, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

function runTool(file, argv, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(file, argv, { encoding: "utf8" }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(input);
  });
}

const bearer = () => state.requests.find((r) => r.server === "api" && r.headers.authorization)?.headers.authorization;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "attachpage-test-"));
  credentialsFile = join(dir, "credentials");
  folder = join(dir, "site");
  await mkdir(join(folder, "assets"), { recursive: true });
  await writeFile(join(folder, "index.html"), "<!doctype html><title>Report</title>");
  await writeFile(join(folder, "assets", "app.css"), "body { margin: 0 }");
  documentFile = join(dir, "data.csv");
  await writeFile(documentFile, "a,b\n1,2\n");
  state = { requests: [] };
  storage = await listen(() => [200, {}]);
  api = await listen(apiHandler);
  origin = api.origin;
  // logout reads the credential manager first, so it doubles as an availability probe.
  const probe = await run(["logout", "--origin", origin]);
  osStore = probe.code === 0;
  if (!osStore && process.env.REQUIRE_OS_STORE) throw new Error(`credential manager unavailable: ${probe.stderr}`);
});

beforeEach(async () => {
  state = { requests: [], device: "approved", deviceKey: "ap_device_key", finalizeFails: false };
  await rm(credentialsFile, { force: true });
});

after(async () => {
  if (osStore) await run(["logout", "--origin", origin]);
  api?.server.close();
  storage?.server.close();
  await rm(dir, { recursive: true, force: true });
});

test("publishes a folder and withholds the account key from direct storage uploads", async () => {
  const result = await run([folder, "--name", "Report"], { extraEnv: { ATTACHPAGE_API_KEY: "ap_env", ATTACHPAGE_ORIGIN: origin } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${origin}/p/site`);

  const declared = JSON.parse(state.requests.find((r) => r.url === "/api/v1/publish").body);
  assert.equal(declared.siteName, "Report");
  assert.deepEqual(
    declared.files.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "assets/app.css", size: 18 },
      { path: "index.html", size: 36 },
    ],
  );
  const own = state.requests.find((r) => r.url === "/upload/index.html");
  assert.equal(own.headers.authorization, "Bearer ap_env");
  assert.equal(own.body.toString(), "<!doctype html><title>Report</title>");
  const direct = state.requests.find((r) => r.server === "storage");
  assert.equal(direct.headers.authorization, undefined);
  assert.equal(direct.headers["x-signature"], "signed");
  assert.equal(direct.body.toString(), "body { margin: 0 }");
});

test("stops after a failed finalize and sends nothing", async () => {
  state.finalizeFails = true;
  const result = await run([folder, "--to", "a@example.com"], { extraEnv: { ATTACHPAGE_API_KEY: "ap_env", ATTACHPAGE_ORIGIN: origin } });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.ok(!state.requests.some((r) => r.url.endsWith("/send")));
});

test("publishes a document as multipart with its filename", async () => {
  const result = await run([documentFile, "--name", "Data"], { extraEnv: { ATTACHPAGE_API_KEY: "ap_env", ATTACHPAGE_ORIGIN: origin } });
  assert.equal(result.code, 0, result.stderr);
  const upload = state.requests.find((r) => r.url === "/api/v1/documents/publish");
  assert.match(upload.headers["content-type"], /^multipart\/form-data/);
  assert.match(upload.body.toString(), /filename="data\.csv"/);
  assert.match(upload.body.toString(), /name="siteName"\r\n\r\nData/);
});

test("reads the key and origin from the credentials file", async () => {
  await writeFile(credentialsFile, `ATTACHPAGE_API_KEY=ap_file\nATTACHPAGE_ORIGIN=${origin}\n`);
  const result = await run([documentFile]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(bearer(), "Bearer ap_file");
});

test("exits 2 with sign-in instructions when no credentials are configured", async () => {
  const result = await run([documentFile, "--origin", origin]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Missing credentials: .*publish\.mjs login/);
  assert.equal(state.requests.length, 0);
});

test("login --store file signs in through the browser and logout removes the key", async () => {
  const login = await run(["login", "--store", "file", "--origin", origin]);
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stderr, new RegExp(`${origin}/device[\\s\\S]*WXYZ-1234`));
  assert.ok(!`${login.stdout}${login.stderr}`.includes("ap_device_key"), "the key is never printed");
  assert.equal(await readFile(credentialsFile, "utf8"), `ATTACHPAGE_API_KEY=ap_device_key\nATTACHPAGE_ORIGIN=${origin}\n`);
  if (process.platform !== "win32") assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);

  const publish = await run([documentFile]);
  assert.equal(publish.code, 0, publish.stderr);
  assert.equal(bearer(), "Bearer ap_device_key");

  const logout = await run(["logout", "--store", "file"]);
  assert.equal(logout.code, 0, logout.stderr);
  assert.equal(await readFile(credentialsFile, "utf8"), `ATTACHPAGE_ORIGIN=${origin}\n`);
});

test("a denied sign-in saves nothing", async () => {
  state.device = "denied";
  const result = await run(["login", "--store", "file", "--origin", origin]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Sign-in denied\./);
  await assert.rejects(stat(credentialsFile));
});

test("credential manager: login saves the key, publish falls back to it, logout removes it", async (t) => {
  if (!osStore) return t.skip("no usable credential manager");
  const login = await run(["login", "--origin", origin]);
  assert.equal(login.code, 0, login.stderr);
  assert.match(login.stderr, /Saved the AttachPage key for http:\/\/127\.0\.0\.1:\d+ to (Windows Credential Manager|the macOS Keychain|the Secret Service keyring)\./);
  assert.ok(!`${login.stdout}${login.stderr}`.includes("ap_device_key"), "the key is never printed");
  await assert.rejects(stat(credentialsFile), "nothing is written to the credentials file");

  let publish = await run([documentFile, "--origin", origin]);
  assert.equal(publish.code, 0, publish.stderr);
  assert.equal(bearer(), "Bearer ap_device_key");

  state.requests = [];
  publish = await run([documentFile, "--origin", origin], { extraEnv: { ATTACHPAGE_API_KEY: "ap_env" } });
  assert.equal(bearer(), "Bearer ap_env", "the environment still comes first");

  const piped = await run(["login", "--key-stdin", "--origin", origin], { input: "ap_piped_key\n" });
  assert.equal(piped.code, 0, piped.stderr);
  state.requests = [];
  publish = await run([documentFile, "--origin", origin]);
  assert.equal(bearer(), "Bearer ap_piped_key");

  const logout = await run(["logout", "--origin", origin]);
  assert.equal(logout.code, 0, logout.stderr);
  assert.match(logout.stderr, /Removed the AttachPage key/);
  publish = await run([documentFile, "--origin", origin]);
  assert.equal(publish.code, 2);
});

test("credential manager: an entry added with the platform's own tools is used", async (t) => {
  if (!osStore) return t.skip("no usable credential manager");
  if (process.platform === "win32") await runTool("cmdkey.exe", [`/generic:attachpage:${origin}`, "/user:someone", "/pass:ap_by_hand"]);
  else if (process.platform === "darwin")
    await runTool("/usr/bin/security", ["add-generic-password", "-U", "-s", "attachpage", "-a", origin, "-w", "ap_by_hand"]);
  else await runTool("secret-tool",["store", "--label", "AttachPage", "service", "attachpage", "account", origin], "ap_by_hand");
  try {
    const publish = await run([documentFile, "--origin", origin]);
    assert.equal(publish.code, 0, publish.stderr);
    assert.equal(bearer(), "Bearer ap_by_hand");
  } finally {
    await run(["logout", "--origin", origin]);
  }
});
