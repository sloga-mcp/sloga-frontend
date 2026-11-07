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

/** Follows one folder while it is zipped */
export interface ZipObserver {
  /**
   * Fraction of the folder's bytes read so far, or null while the folder is
   * still being listed (the total is not known yet)
   */
  progress(fraction: number | null): void;

  /** The zip is finished, failed or cancelled; always called once */
  done(): void;

  /**
   * Aborted when the user cancels this zip: the folder is then dropped
   * quietly (neither attached nor reported as a failure)
   */
  signal?: AbortSignal;
}

/** Starts following a folder about to be zipped, by its name */
export type WatchZip = (name: string) => ZipObserver;

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
 * @param signal Stops the walk (rejecting with its reason) once aborted
 * @returns Entries; empty subfolders are kept as directory entries
 */
export async function walkFolder(
  root: FileSystemDirectoryEntry,
  signal?: AbortSignal,
) {
  const entries: ZipEntry[] = [];

  async function walk(dir: FileSystemDirectoryEntry, prefix: string) {
    signal?.throwIfAborted();
    const children = await readAll(dir);
    if (!children.length) {
      entries.push({ path: prefix });
      return;
    }

    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      signal?.throwIfAborted();
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
 * @param watch Follows each folder while it is zipped
 * @returns Files to attach, and what could not be attached
 */
export async function resolveDroppedItems(
  items: DroppedItem[],
  watch?: WatchZip,
) {
  const files: File[] = [];
  const failures: DropFailure[] = [];

  for (const item of items) {
    if (item.kind === "file") {
      if (await readable(item.file)) files.push(item.file);
      else failures.push({ name: item.file.name, reason: "unreadable" });
      continue;
    }

    const entry = item.entry;
    const zipped = await zipFolder(
      entry.name,
      (signal) => walkFolder(entry, signal),
      watch,
    );
    if (zipped instanceof File) files.push(zipped);
    else if (zipped) failures.push(zipped);
  }

  return { files, failures };
}

/**
 * Zip a folder's entries into `<name>.zip`
 * @param name Folder name
 * @param entries Gets the folder's entries
 * @param watch Follows the zip while it is made
 * @returns The zip, why it could not be made, or null if it was cancelled
 */
async function zipFolder(
  name: string,
  entries: (signal?: AbortSignal) => Promise<ZipEntry[]>,
  watch?: WatchZip,
): Promise<File | DropFailure | null> {
  const observer = watch?.(name);
  const signal = observer?.signal;
  try {
    observer?.progress(null);
    const blob = await zipStore(
      await entries(signal),
      (fraction) => observer?.progress(fraction),
      signal,
    );
    // Cancelled during the last read: still dropped, as the user asked
    if (signal?.aborted) return null;
    return new File([blob], `${name}.zip`, {
      type: "application/zip",
      lastModified: Date.now(),
    });
  } catch (error) {
    if (signal?.aborted) return null;
    console.warn("[attachments] couldn't zip folder", name, error);
    return {
      name,
      reason: error instanceof ZipTooLargeError ? "too_large" : "read_failed",
    };
  } finally {
    observer?.done();
  }
}

/**
 * Turn the files of a folder chosen in a `webkitdirectory` picker into one
 * `<folder>.zip`. The picker hands over every file in the folder, flat,
 * each with its path from the chosen folder down in `webkitRelativePath`
 * (empty subfolders are not listed, so they are not in the archive).
 * @param picked Files from the picker
 * @param watch Follows the folder while it is zipped
 * @returns The zip (none for an empty folder), and what went wrong
 */
export async function resolvePickedFolder(picked: File[], watch?: WatchZip) {
  const files: File[] = [];
  const failures: DropFailure[] = [];

  const withPath = picked.filter((file) => file.webkitRelativePath);
  if (!withPath.length) return { files, failures };

  const name = withPath[0].webkitRelativePath.split("/")[0];
  const zipped = await zipFolder(
    name,
    async () =>
      withPath
        .map((file) => ({
          path: file.webkitRelativePath,
          file,
          lastModified: file.lastModified,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    watch,
  );
  if (zipped instanceof File) files.push(zipped);
  else if (zipped) failures.push(zipped);

  return { files, failures };
}
