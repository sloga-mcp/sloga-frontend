import { lingui as linguiSolidPlugin } from "@lingui-solid/vite-plugin";
import devtools from "@solid-devtools/transform";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import babelMacrosPlugin from "vite-plugin-babel-macros";
import Inspect from "vite-plugin-inspect";
import { VitePWA } from "vite-plugin-pwa";
import solidPlugin from "vite-plugin-solid";
import solidSvg from "vite-plugin-solid-svg";

import codegenPlugin from "./codegen.plugin";
import modelsPlugin from "./models.plugin";

const base = process.env.BASE_PATH ?? "/";

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
    Inspect(),
    devtools(),
    codegenPlugin(),
    modelsPlugin(),
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
        // The entry chunk is precached so the app opens offline. It reached
        // 4,000,039 bytes at v0.65.0 (3,961,346 at v0.64.0) and failed the build
        // at the old 4,000,000 cap; 6 MB leaves room to grow.
        maximumFileSizeToCacheInBytes: 6000000,
        // MediaPipe segmentation WASM (~9.4MB each) exceeds the precache cap and
        // vite-plugin-pwa THROWS (fails the build) on any globbed asset over it.
        // These are self-hosted, lazily fetched by @livekit/track-processors at
        // runtime — never precache them. Excludes the model too for good measure.
        // ONNX Runtime's wasm is pulled into the bundle by the transformers.js
        // import graph (21.6MB for the jsep build), and vite-plugin-pwa FAILS
        // THE BUILD on any globbed asset over the cap rather than skipping it.
        // Never precache it: transcription fetches its runtime from `/models/`
        // at toggle time, so the bundled copy is never even loaded.
        // The transcription worker chunk carries transformers.js (~900KB) for
        // an opt-in feature; keep it out of every PWA install. No runtime SW
        // route exists, so the page fetches it straight from the network.
        globIgnores: [
          "**/mediapipe/**",
          "**/ort-wasm*",
          "**/*.wasm",
          "**/transcriptionWorker*",
        ],
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
