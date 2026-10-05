// Minimal static file server (Node, no dependencies). Browsers need http://localhost, not file://.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "web");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
                ".wasm": "application/wasm", ".onnx": "application/octet-stream" };
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const requestedPath = resolve(root, `.${pathname}`);
    const file = pathname.endsWith("/") ? join(requestedPath, "index.html") : requestedPath;
    const relativePath = relative(root, file);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(8080, "127.0.0.1", () => console.log("http://localhost:8080"));
