#!/usr/bin/env node
/**
 * Publish a static folder through AttachPage and optionally send it.
 *
 *   node publish.mjs <folder> --name "Q3 report" [--slug q3-report] [--site <siteId>]
 *                    [--to a@b.com,c@d.com] [--message "…"] [--expires 7] [--origin https://attachpage.com]
 *
 * Credentials: ATTACHPAGE_API_KEY (+ optional ATTACHPAGE_ORIGIN, default https://attachpage.com) in the
 * environment or ~/.attachpage/credentials.
 * Exit code 0 on success; the page URL is printed on its own line.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (!folder) {
  console.error(
    "usage: publish.mjs <folder> --name <name> [--slug <slug>] [--site <id>] [--to a@b.com,…] [--message …] [--expires 7]",
  );
  process.exit(2);
}

async function credentials() {
  const env = { key: process.env.ATTACHPAGE_API_KEY, origin: process.env.ATTACHPAGE_ORIGIN };
  if (env.key && env.origin) return { ...env, origin: opt("origin", env.origin) };
  try {
    const text = await readFile(join(homedir(), ".attachpage", "credentials"), "utf8");
    for (const line of text.split("\n")) {
      const [k, v] = line.split("=");
      if (k?.trim() === "ATTACHPAGE_API_KEY") env.key ??= v?.trim();
      if (k?.trim() === "ATTACHPAGE_ORIGIN") env.origin ??= v?.trim();
    }
  } catch {
    /* no credentials file */
  }
  env.origin = opt("origin", env.origin ?? "https://attachpage.com");
  if (!env.key) {
    console.error("Missing credentials: set ATTACHPAGE_API_KEY (or ~/.attachpage/credentials).");
    process.exit(2);
  }
  return env;
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
      Authorization: `Bearer ${key}`,
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
