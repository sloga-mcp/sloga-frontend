// Specs for the model-cache cleanup. Run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/transcription/modelCache.test.ts
//
// The poisoned entry modelled here is the real one: production answered
// `/models/whisper-tiny/config.json` with the app's index.html (200,
// text/html; charset=utf-8), and transformers.js cached it under that URL.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ModelCacheStorage,
  MODEL_CACHE_NAME,
  purgeHtmlFromModelCache,
} from "./modelCache.ts";

const ORIGIN = "https://app.sloga.gg";
const HTML = "text/html; charset=utf-8";

/** A Cache Storage holding one named cache, with a log of what was opened. */
function fakeStorage(
  entries: Record<string, string>,
  name = MODEL_CACHE_NAME,
): ModelCacheStorage & { opened: string[]; left: () => string[] } {
  const store = new Map<string, Response>();
  for (const [path, type] of Object.entries(entries)) {
    store.set(
      ORIGIN + path,
      new Response("x", { headers: { "content-type": type } }),
    );
  }
  const cache = {
    keys: async () => [...store.keys()].map((url) => new Request(url)),
    match: async (request: Request) => store.get(request.url),
    delete: async (request: Request) => store.delete(request.url),
  } as unknown as Cache;
  const opened: string[] = [];
  return {
    opened,
    left: () => [...store.keys()].map((url) => url.slice(ORIGIN.length)),
    has: async (wanted: string) => wanted === name,
    open: async (wanted: string) => {
      opened.push(wanted);
      return cache;
    },
  };
}

test("removes the cached index.html stored under a model file's URL", async () => {
  const storage = fakeStorage({
    "/models/whisper-tiny/config.json": HTML,
    "/models/whisper-tiny/tokenizer.json": HTML,
  });
  assert.equal(await purgeHtmlFromModelCache(storage, "/models/"), 2);
  assert.deepEqual(storage.left(), []);
});

test("keeps real model files, whatever their type", async () => {
  const storage = fakeStorage({
    "/models/whisper-tiny/config.json": "application/json; charset=utf-8",
    "/models/whisper-tiny/merges.txt": "text/plain; charset=utf-8",
    "/models/whisper-tiny/onnx/encoder_model_quantized.onnx":
      "application/octet-stream",
    "/models/whisper-tiny/vocab.json": "",
  });
  assert.equal(await purgeHtmlFromModelCache(storage, "/models/"), 0);
  assert.equal(storage.left().length, 4);
});

test("removes only the HTML entries from a mixed cache", async () => {
  const storage = fakeStorage({
    "/models/whisper-tiny/config.json": "TEXT/HTML",
    "/models/whisper-tiny/merges.txt": "text/plain",
  });
  assert.equal(await purgeHtmlFromModelCache(storage, "/models/"), 1);
  assert.deepEqual(storage.left(), ["/models/whisper-tiny/merges.txt"]);
});

test("leaves entries outside the model path alone, even if HTML", async () => {
  const storage = fakeStorage({
    "/index.html": HTML,
    "/modelsX/page": HTML,
    "/models/whisper-tiny/config.json": HTML,
  });
  assert.equal(await purgeHtmlFromModelCache(storage, "/models/"), 1);
  assert.deepEqual(storage.left(), ["/index.html", "/modelsX/page"]);
});

test("does not create the cache in a browser that never transcribed", async () => {
  const storage = fakeStorage({}, "some-other-cache");
  assert.equal(await purgeHtmlFromModelCache(storage, "/models/"), 0);
  assert.deepEqual(storage.opened, []);
});

test("no Cache Storage at all is a no-op", async () => {
  assert.equal(await purgeHtmlFromModelCache(undefined, "/models/"), 0);
});

test("never rejects when the cache cannot be read", async () => {
  const storage: ModelCacheStorage = {
    has: async () => true,
    open: async () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };
  assert.equal(await purgeHtmlFromModelCache(storage, "/models/"), 0);
});
