import { type ZipEntry, ZipTooLargeError, zipStore } from "./zipStore";

/**
 * Turning dropped or pasted folders into attachments.
 *
 * A browser hands a folder over as a fake File: its name, 0 bytes, no type,
 * and every read of it fails. Taken as-is it shows up in the draft as
 * "<folder> · 0 B" and then vanishes on send. Here each folder is walked
 * through the entries API and sent as one `<folder>.zip` instead (the draft
 * only takes a handful of attachments, so the folder's files cannot go one
 * by one).
 */

/** Something taken off a DataTransfer while the event was still live */
export type DroppedItem =
  | { kind: "file"; file: File }
  | { kind: "folder"; entry: FileSystemDirectoryEntry };

/** Why a dropped item could not be attached */
export type DropFailure =
  | { name: string; reason: "unreadable" }
  | { name: string; reason: "too_large" }
  | { name: string; reason: "read_failed" };

/**
 * Take every file and folder off a DataTransfer. Must run synchronously
 * inside the event handler: the item list is emptied once it returns.
 * @param data Drop or clipboard data
 * @returns Items, in order
 */
export function takeDroppedItems(data: DataTransfer | null | undefined) {
  const out: DroppedItem[] = [];
  if (!data) return out;

  const items = data.items ? [...data.items] : [];
  if (items.length) {
    for (const item of items) {
      if (item.kind !== "file") continue;

      // Not in every webview; without it a folder still arrives as a
      // phantom File, which `resolveDroppedItems` refuses by reading it.
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        out.push({ kind: "folder", entry: entry as FileSystemDirectoryEntry });
        continue;
      }

      const file = item.getAsFile();
      if (file) out.push({ kind: "file", file });
    }
    return out;
  }

  for (const file of data.files ? [...data.files] : []) {
    out.push({ kind: "file", file });
  }
  return out;
}

/**
 * Whether a File can actually be read. A folder that got through as a File
 * (no entries API) has size 0 and no type, like a real empty file, but its
 * read fails.
 * @param file File
 * @returns Whether it is readable
 */
async function readable(file: File) {
  if (file.size !== 0 || file.type) return true;
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * Every entry of a directory (readEntries returns them in batches)
 * @param dir Directory
 * @returns Child entries
 */
async function readAll(dir: FileSystemDirectoryEntry) {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/**
 * The File behind a file entry
 * @param entry File entry
 * @returns File
 */
function entryFile(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

/**
 * Walk a folder into ZIP entries, paths starting with the folder's own name
 * so the archive unpacks into one folder
 * @param root Folder
 * @returns Entries; empty subfolders are kept as directory entries
 */
export async function walkFolder(root: FileSystemDirectoryEntry) {
  const entries: ZipEntry[] = [];

  async function walk(dir: FileSystemDirectoryEntry, prefix: string) {
    const children = await readAll(dir);
    if (!children.length) {
      entries.push({ path: prefix });
      return;
    }

    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.isDirectory) {
        await walk(
          child as FileSystemDirectoryEntry,
          `${prefix}${child.name}/`,
        );
      } else if (child.isFile) {
        const file = await entryFile(child as FileSystemFileEntry);
        entries.push({
          path: `${prefix}${child.name}`,
          file,
          lastModified: file.lastModified,
        });
      }
    }
  }

  await walk(root, `${root.name}/`);
  return entries;
}

/**
 * Turn taken items into attachable Files: folders become `<name>.zip`,
 * unreadable phantoms are refused
 * @param items From `takeDroppedItems`
 * @returns Files to attach, and what could not be attached
 */
export async function resolveDroppedItems(items: DroppedItem[]) {
  const files: File[] = [];
  const failures: DropFailure[] = [];

  for (const item of items) {
    if (item.kind === "file") {
      if (await readable(item.file)) files.push(item.file);
      else failures.push({ name: item.file.name, reason: "unreadable" });
      continue;
    }

    const name = item.entry.name;
    try {
      const blob = await zipStore(await walkFolder(item.entry));
      files.push(
        new File([blob], `${name}.zip`, {
          type: "application/zip",
          lastModified: Date.now(),
        }),
      );
    } catch (error) {
      console.warn("[attachments] couldn't zip folder", name, error);
      failures.push({
        name,
        reason: error instanceof ZipTooLargeError ? "too_large" : "read_failed",
      });
    }
  }

  return { files, failures };
}
