import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = resolve(repositoryRoot, "scripts/static-server.mjs");

async function availablePort() {
  const reservation = createServer();
  await new Promise((resolveListen, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolveListen);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port.");
  await new Promise((resolveClose, reject) => {
    reservation.close((error) => error ? reject(error) : resolveClose());
  });
  return address.port;
}

test("production static server handles assets, SPA paths, errors, and headers", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "worlds-fair-static-"));
  const assets = resolve(directory, "assets");
  await mkdir(assets);
  await writeFile(resolve(directory, "index.html"), "<!doctype html><h1>Static app</h1>");
  await writeFile(resolve(assets, "app-12345678.js"), "window.appReady = true;");

  const port = await availablePort();
  const child = spawn(process.execPath, [serverScript, directory], {
    cwd: repositoryRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  t.after(async () => {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Static server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Wait briefly for the child server to bind its port.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.equal(ready, true, "server should become ready");

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-cache");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(await page.text(), /Static app/);

  const route = await fetch(`${baseUrl}/config/preview`);
  assert.equal(route.status, 200);
  assert.match(await route.text(), /Static app/);

  const asset = await fetch(`${baseUrl}/assets/app-12345678.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const missingAsset = await fetch(`${baseUrl}/assets/missing.js`);
  assert.equal(missingAsset.status, 404);
  const traversal = await fetch(`${baseUrl}/..%2Fsecret.txt`);
  assert.equal(traversal.status, 403);
  const malformedPath = await fetch(`${baseUrl}/%ZZ`);
  assert.equal(malformedPath.status, 400);
  const method = await fetch(baseUrl, { method: "POST" });
  assert.equal(method.status, 405);

  const head = await fetch(baseUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});
