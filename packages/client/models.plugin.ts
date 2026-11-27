import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

import type { Connect, Plugin } from "vite";

/**
 * Serves the speech model and the ONNX runtime from OUTSIDE the repository.
 *
 * ## Why not `public/`
 *
 * `public/mediapipe/` is the precedent for self-hosting a model here, and it is
 * 23 MB committed to git. Whisper plus the ONNX runtime is closer to 120 MB,
 * this repository is public, and git history is permanent — that is a
 * disproportionate, irreversible cost for a feature most people will never turn
 * on. So the files live in a directory beside the checkout and are served from
 * there, versioned as deployment assets rather than as source.
 *
 * ## Why they must be same-origin at all
 *
 * transformers.js otherwise fetches models from huggingface.co and
 * onnxruntime-web fetches its `.wasm` runtime from a jsDelivr CDN — two
 * third-party requests made while a private call is in progress, one of which
 * the desktop shell's CSP blocks outright. See `transcriptionEngine.ts`.
 *
 * ## Dev and preview only, NOT production
 *
 * Both hooks share one handler, so `vite dev` and `vite preview` serve the
 * same files. Production does not run vite at all: since the 2026-08-24 move
 * to heart1 the web app is served by Caddy straight from `dist`, and
 * `/models/` there needs its own Caddy route onto a copy of these files on
 * that host. Without that route every model request falls through to the
 * single-page-app fallback and gets `index.html` (200, text/html), which is
 * how transcription was broken on the web from that move until 2026-11-27.
 */

const ROUTE = "/models/";

/** Content types for what actually lives under there. */
const TYPES: Record<string, string> = {
  ".wasm": "application/wasm",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".onnx": "application/octet-stream",
};

function handler(root: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? "";
    if (!url.startsWith(ROUTE)) return next();

    // Strip the query and decode before any path work, so `%2e%2e` cannot
    // sneak past the traversal check below.
    let relative: string;
    try {
      relative = decodeURIComponent(url.slice(ROUTE.length).split("?")[0]);
    } catch {
      res.statusCode = 400;
      return res.end("bad path");
    }

    const target = resolve(join(root, normalize(relative)));
    // Containment check: everything served must sit under the models root.
    if (target !== root && !target.startsWith(root + sep)) {
      res.statusCode = 403;
      return res.end("forbidden");
    }

    let size: number;
    try {
      const stat = statSync(target);
      if (!stat.isFile()) throw new Error("not a file");
      size = stat.size;
    } catch {
      // Loud on purpose. A missing runtime file is otherwise a silent
      // fallback to a CDN fetch (or a cryptic wasm error), and this line is
      // the fastest way to find out which name was actually requested.
      console.warn(`[models] 404 ${url} -> ${target}`);
      res.statusCode = 404;
      return res.end("not found");
    }

    res.setHeader(
      "Content-Type",
      TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    );
    res.setHeader("Content-Length", String(size));
    // Content is immutable per model version; the client caches it once and
    // never revalidates. Publishing a changed model means a new path.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    // These are inert data files; make sure nothing can coax a browser into
    // treating one as a document.
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method === "HEAD") return res.end();
    createReadStream(target).pipe(res);
  };
}

export default function modelsPlugin(): Plugin {
  // Overridable so a machine that keeps its assets elsewhere does not have to
  // patch the config.
  const root = resolve(
    process.env.SLOGA_MODELS_DIR ?? "/home/mcp/frontend-assets/models",
  );

  return {
    name: "sloga-models",
    configureServer(server) {
      server.middlewares.use(handler(root));
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler(root));
    },
  };
}
