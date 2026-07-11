import { lingui as linguiSolidPlugin } from "@lingui-solid/vite-plugin";
import devtools from "@solid-devtools/transform";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import babelMacrosPlugin from "vite-plugin-babel-macros";
import Inspect from "vite-plugin-inspect";
import { VitePWA } from "vite-plugin-pwa";
import solidPlugin from "vite-plugin-solid";
import solidSvg from "vite-plugin-solid-svg";

import codegenPlugin from "./codegen.plugin";

const base = process.env.BASE_PATH ?? "/";

// THROWAWAY (E2EE slice 6.0 platform spike): dev-server sink receiving probe
// evidence POSTed by components/rtc/e2eeMediaSpike.ts from the desktop
// WebView2 shells. Writes JSON snapshots under .spike-reports/ (untracked).
// Removed at the end of sub-slice 6.0 together with the spike module.
//
// GATED on VITE_E2EE_SPIKE=1 (6.2b crypto gate finding #2): production
// app.sloga.gg IS this Vite dev server (behind Caddy), so an always-on
// `apply:"serve"` middleware exposed an UNAUTHENTICATED disk-writing POST
// endpoint to the whole internet on the host that also holds the updater
// signing key. Prod's `mise dev` never sets the flag, so the endpoint is not
// registered there; set VITE_E2EE_SPIKE=1 to run the harness locally.
function e2eeSpikeReportSink(): Plugin {
  return {
    name: "e2ee-spike-report-sink",
    apply: "serve",
    configureServer(server) {
      if (process.env.VITE_E2EE_SPIKE !== "1") return;
      server.middlewares.use("/__e2ee_spike_report", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const payload = JSON.parse(body) as {
              reason?: string;
              report?: { bootId?: string; localIdentity?: string };
            };
            const dir = resolve(__dirname, ".spike-reports");
            mkdirSync(dir, { recursive: true });
            const label = `${payload.report?.localIdentity ?? "anon"}-${
              payload.report?.bootId ?? "noboot"
            }`.replace(/[^A-Za-z0-9_-]/g, "_");
            writeFileSync(
              resolve(dir, `${label}.latest.json`),
              JSON.stringify(payload, null, 2),
            );
            appendFileSync(
              resolve(dir, `${label}.jsonl`),
              JSON.stringify({ at: new Date().toISOString(), ...payload }) + "\n",
            );
            res.statusCode = 200;
            res.end("ok");
          } catch {
            res.statusCode = 400;
            res.end("bad payload");
          }
        });
      });
    },
  };
}

export default defineConfig({
  base,
  server: {
    port: 5174,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 1000,
    },
    allowedHosts: true,
  },
  plugins: [
    e2eeSpikeReportSink(),
    Inspect(),
    devtools(),
    codegenPlugin(),
    babelMacrosPlugin(),
    linguiSolidPlugin(),
    solidPlugin(),
    solidSvg({
      defaultAsComponent: false,
    }),
    VitePWA({
      srcDir: "src",
      registerType: "autoUpdate",
      filename: "serviceWorker.ts",
      strategies: "injectManifest",
      injectManifest: {
        maximumFileSizeToCacheInBytes: 4000000,
        // MediaPipe segmentation WASM (~9.4MB each) exceeds the precache cap and
        // vite-plugin-pwa THROWS (fails the build) on any globbed asset over it.
        // These are self-hosted, lazily fetched by @livekit/track-processors at
        // runtime — never precache them. Excludes the model too for good measure.
        globIgnores: ["**/mediapipe/**"],
      },
      devOptions: {
        enabled: true,
      },
      manifest: {
        name: "Sloga",
        short_name: "Sloga",
        description: "User-first open source chat platform.",
        categories: ["communication", "chat", "messaging"],
        start_url: base,
        orientation: "any",
        display_override: ["window-controls-overlay"],
        display: "standalone",
        background_color: "#101823",
        theme_color: "#101823",
        icons: [
          {
            src: `${base}assets/web/android-chrome-192x192.png`,
            type: "image/png",
            sizes: "192x192",
          },
          {
            src: `${base}assets/web/android-chrome-512x512.png`,
            type: "image/png",
            sizes: "512x512",
          },
          {
            src: `${base}assets/web/monochrome.svg`,
            type: "image/svg+xml",
            sizes: "48x48 72x72 96x96 128x128 256x256",
            purpose: "monochrome",
          },
          {
            src: `${base}assets/web/masking-512x512.png`,
            type: "image/png",
            sizes: "512x512",
            purpose: "maskable",
          },
        ],
        // TODO: take advantage of shortcuts
      },
    }),
  ],
  build: {
    target: "esnext",
    rollupOptions: {
      external: ["hast"],
      output: {
        manualChunks: {
          markdown: [
            "lowlight",
            "rehype-highlight",
            "rehype-katex",
            "remark-breaks",
            "remark-gfm",
            "remark-math",
            "remark-parse",
            "remark-rehype",
            "vfile",
          ],
        },
      },
    },
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ["hast"],
  },
  resolve: {
    alias: {
      "styled-system": resolve(__dirname, "styled-system"),
      ...readdirSync(resolve(__dirname, "components")).reduce(
        (p, f) => ({
          ...p,
          [`@revolt/${f}`]: resolve(__dirname, "components", f),
        }),
        {},
      ),
    },
  },
});
