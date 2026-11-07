/**
 * Run with:
 *
 *     node --test components/ui/components/utils/files/folderAttachments.test.ts
 *
 * Covers sending a folder as an attachment: the stored-ZIP writer (checked
 * against Python's zipfile when python3 is on PATH, and against a CRC-32
 * known answer), the folder walk, and the refusal of the 0-byte phantom File
 * a browser hands over for a folder when the entries API is missing. Before
 * this a dropped folder showed as "<folder> · 0 B" and vanished on send.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// The modules import their siblings extensionless, as Vite allows
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./zipStore") {
      return nextResolve("./zipStore.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const { crc32, zipStore, ZipTooLargeError } = await import("./zipStore.ts");
const {
  resolveDroppedItems,
  resolvePickedFolder,
  takeDroppedItems,
  walkFolder,
} = await import("./folderAttachments.ts");

/** A File as a webkitdirectory picker hands it over */
function picked(path: string, body: string) {
  const file = new File([body], path.split("/").pop()!);
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

/** Fake FileSystemFileEntry */
function fileEntry(name: string, body: string) {
  const file = new File([body], name, { lastModified: Date.UTC(2026, 0, 2) });
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (ok: (f: File) => void) => ok(file),
  };
}

/** Fake FileSystemDirectoryEntry; readEntries hands children out in batches of 2 */
function dirEntry(name: string, children: unknown[]) {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let i = 0;
      return {
        readEntries(ok: (batch: unknown[]) => void) {
          ok(children.slice(i, (i += 2)));
        },
      };
    },
  };
}

/**
 * Parse a stored ZIP's central directory
 * @param bytes Archive
 * @returns Entry paths and bodies
 */
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: Record<string, string> = {};
  for (let n = 0; n < count; n++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(at + 46, at + 46 + nameLen),
    );
    const localNameLen = view.getUint16(local + 26, true);
    const body = bytes.subarray(
      local + 30 + localNameLen,
      local + 30 + localNameLen + size,
    );
    assert.equal(crc32(0, body), crc, `crc of ${name}`);
    out[name] = new TextDecoder().decode(body);
    at += 46 + nameLen;
  }
  return out;
}

describe("zipStore", () => {
  it("CRC-32 matches the standard check value", () => {
    assert.equal(crc32(0, new TextEncoder().encode("123456789")), 0xcbf43926);
  });

  it("writes an archive whose entries read back exactly", async () => {
    const blob = await zipStore([
      { path: "photos/", file: undefined },
      { path: "photos/a.txt", file: new Blob(["alpha"]) },
      { path: "photos/ünï/b.txt", file: new Blob(["beta"]) },
      { path: "photos/empty.txt", file: new Blob([]) },
    ]);
    assert.equal(blob.type, "application/zip");
    const entries = readZip(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual(entries, {
      "photos/": "",
      "photos/a.txt": "alpha",
      "photos/ünï/b.txt": "beta",
      "photos/empty.txt": "",
    });
  });

  it("is a valid zip to Python's zipfile", async (t) => {
    const probe = spawnSync("python3", ["--version"]);
    if (probe.status !== 0) return t.skip("python3 not available");

    const blob = await zipStore([
      { path: "f/", file: undefined },
      { path: "f/x.txt", file: new Blob(["x".repeat(10_000)]) },
      { path: "f/sub/", file: undefined },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "zipstore-"));
    try {
      const path = join(dir, "f.zip");
      writeFileSync(path, new Uint8Array(await blob.arrayBuffer()));
      const run = spawnSync("python3", [
        "-I",
        "-c",
        "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(','.join(z.namelist()))\nprint(len(z.read('f/x.txt')))",
        path,
      ]);
      assert.equal(run.status, 0, run.stderr.toString());
      assert.equal(run.stdout.toString().trim(), "f/,f/x.txt,f/sub/\n10000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses more entries than classic ZIP allows", async () => {
    const many = Array.from({ length: 0x10000 }, (_, i) => ({ path: `${i}/` }));
    await assert.rejects(zipStore(many), ZipTooLargeError);
  });
});

describe("folders", () => {
  it("walks every batch and nests paths under the folder's name", async () => {
    const root = dirEntry("trip", [
      fileEntry("b.txt", "B"),
      dirEntry("day1", [fileEntry("x.txt", "X")]),
      fileEntry("a.txt", "A"),
      dirEntry("empty", []),
    ]);
    const paths = (await walkFolder(root as never)).map((e) => e.path);
    assert.deepEqual(paths, [
      "trip/a.txt",
      "trip/b.txt",
      "trip/day1/x.txt",
      "trip/empty/",
    ]);
  });

  it("a dropped folder becomes <name>.zip", async () => {
    const root = dirEntry("trip", [fileEntry("a.txt", "A")]);
    const { files, failures } = await resolveDroppedItems([
      { kind: "folder", entry: root as never },
    ]);
    assert.deepEqual(failures, []);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "trip.zip");
    assert.equal(files[0].type, "application/zip");
    assert.deepEqual(readZip(new Uint8Array(await files[0].arrayBuffer())), {
      "trip/a.txt": "A",
    });
  });

  it("takeDroppedItems separates folders from files", () => {
    const folder = dirEntry("trip", []);
    const plain = new File(["hi"], "hi.txt", { type: "text/plain" });
    const data = {
      items: [
        { kind: "file", webkitGetAsEntry: () => folder, getAsFile: () => null },
        {
          kind: "file",
          webkitGetAsEntry: () => ({ isDirectory: false }),
          getAsFile: () => plain,
        },
        { kind: "string", getAsFile: () => null },
      ],
      files: [],
    };
    const items = takeDroppedItems(data as never);
    assert.deepEqual(
      items.map((i) => i.kind),
      ["folder", "file"],
    );
  });

  it("refuses a phantom folder File but keeps a real empty file", async () => {
    class Phantom extends File {
      override slice() {
        return {
          arrayBuffer: () =>
            Promise.reject(new DOMException("not found", "NotFoundError")),
        } as never;
      }
    }
    const { files, failures } = await resolveDroppedItems([
      { kind: "file", file: new Phantom([], "My Folder") },
      { kind: "file", file: new File([], "empty.txt") },
    ]);
    assert.deepEqual(
      files.map((f) => f.name),
      ["empty.txt"],
    );
    assert.deepEqual(failures, [{ name: "My Folder", reason: "unreadable" }]);
  });
});

describe("folder picker", () => {
  it("zips the picked files under the chosen folder's name", async () => {
    const { files, failures } = await resolvePickedFolder([
      picked("trip/day1/x.txt", "X"),
      picked("trip/a.txt", "A"),
    ]);
    assert.deepEqual(failures, []);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, "trip.zip");
    assert.deepEqual(
      Object.keys(readZip(new Uint8Array(await files[0].arrayBuffer()))),
      ["trip/a.txt", "trip/day1/x.txt"],
    );
  });

  it("attaches nothing for an empty pick", async () => {
    assert.deepEqual(await resolvePickedFolder([]), {
      files: [],
      failures: [],
    });
  });
});
