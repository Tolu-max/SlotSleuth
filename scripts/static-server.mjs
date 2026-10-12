import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const outputDirectory = resolve(process.cwd(), process.argv[2] ?? "dist");
const portText = process.env.PORT ?? "4173";
const port = Number(portText);

if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const baseHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

async function resolveFile(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return { status: 400 };
  }

  const relativePath = decodedPath.replace(/^[/\\]+/, "");
  let filePath = resolve(outputDirectory, relativePath);
  if (filePath !== outputDirectory && !filePath.startsWith(`${outputDirectory}${sep}`)) {
    return { status: 403 };
  }

  try {
    let metadata = await stat(filePath);
    if (metadata.isDirectory()) {
      filePath = resolve(filePath, "index.html");
      metadata = await stat(filePath);
    }
    if (metadata.isFile()) return { filePath, metadata, relativePath };
  } catch {
    // Unknown extensionless paths are client-side routes; missing assets stay 404s.
  }

  if (extname(relativePath)) return { status: 404 };
  filePath = resolve(outputDirectory, "index.html");
  try {
    const metadata = await stat(filePath);
    if (metadata.isFile()) return { filePath, metadata, relativePath: "index.html" };
  } catch {
    // The startup check normally catches a missing output directory.
  }
  return { status: 404 };
}

const outputInfo = await stat(outputDirectory);
if (!outputInfo.isDirectory()) throw new Error("The static output path must be a directory.");

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { ...baseHeaders, Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    response.writeHead(400, baseHeaders).end("Bad request");
    return;
  }

  const result = await resolveFile(pathname);
  if (!result.filePath || !result.metadata) {
    const status = result.status ?? 404;
    response.writeHead(status, { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" });
    response.end(status === 404 ? "Not found" : status === 403 ? "Forbidden" : "Bad request");
    return;
  }

  const extension = extname(result.filePath).toLowerCase();
  const assetDirectory = resolve(outputDirectory, "assets");
  const isHashedAsset = result.filePath.startsWith(`${assetDirectory}${sep}`);
  const cacheControl = extension === ".html"
    ? "no-cache"
    : isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300";
  response.writeHead(200, {
    ...baseHeaders,
    "Content-Type": mimeTypes.get(extension) ?? "application/octet-stream",
    "Content-Length": result.metadata.size,
    "Cache-Control": cacheControl,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(result.filePath);
  stream.on("error", () => {
    if (response.headersSent) response.destroy();
    else response.writeHead(500, baseHeaders).end("Server error");
  });
  stream.pipe(response);
});

server.requestTimeout = 15_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Static site listening on 0.0.0.0:${port}\n`);
});
