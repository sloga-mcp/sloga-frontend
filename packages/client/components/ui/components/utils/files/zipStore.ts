/**
 * Minimal ZIP writer for sending a folder as one attachment.
 *
 * Entries are STORED (no compression): the archive is a Blob made of the
 * headers plus the original File objects, so the bytes are not copied into
 * memory. Each file is read once, in chunks, to get its CRC-32. Classic ZIP
 * only (no ZIP64), so it refuses more than 65,535 entries or 4 GB in total.
 * That is well above any attachment size limit.
 */

/** One file (or empty directory, `file` omitted) inside the archive */
export interface ZipEntry {
  /** Path inside the archive, "/"-separated; directories end with "/" */
  path: string;
  file?: Blob;
  /** Modification time in ms since the epoch */
  lastModified?: number;
}

/** Thrown when the folder does not fit in a classic ZIP */
export class ZipTooLargeError extends Error {
  constructor() {
    super("Folder is too large to zip");
    this.name = "ZipTooLargeError";
  }
}

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

let crcTable: Uint32Array | undefined;

/**
 * CRC-32 lookup table (IEEE polynomial), built on first use
 * @returns Table
 */
function table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/**
 * Continue a CRC-32 over more bytes
 * @param crc Running value (start with 0)
 * @param bytes Bytes
 * @returns Updated value
 */
export function crc32(crc: number, bytes: Uint8Array) {
  const t = table();
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++)
    c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const CHUNK = 4 * 1024 * 1024;

/**
 * CRC-32 of a whole blob, read a slice at a time so a large file is never
 * held in memory at once
 * @param blob Blob
 * @returns CRC-32
 */
async function blobCrc(blob: Blob) {
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    const part = await blob.slice(offset, offset + CHUNK).arrayBuffer();
    crc = crc32(crc, new Uint8Array(part));
  }
  return crc;
}

/**
 * DOS date and time fields for a timestamp (local time, 2 s resolution)
 * @param ms Milliseconds since the epoch
 * @returns [time, date]
 */
function dosDateTime(ms: number): [number, number] {
  const d = new Date(ms);
  const year = d.getFullYear();
  if (!Number.isFinite(year) || year < 1980) return [0, (1 << 5) | 1];
  return [
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((Math.min(year, 2107) - 1980) << 9) |
      ((d.getMonth() + 1) << 5) |
      d.getDate(),
  ];
}

/**
 * Build a stored ZIP archive
 * @param entries Files and empty directories, in archive order
 * @returns Archive bytes as a Blob
 * @throws ZipTooLargeError past the classic ZIP limits
 */
export async function zipStore(entries: ZipEntry[]): Promise<Blob> {
  if (entries.length > MAX_ENTRIES) throw new ZipTooLargeError();

  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const size = entry.file?.size ?? 0;
    const crc = entry.file ? await blobCrc(entry.file) : 0;
    const [time, date] = dosDateTime(entry.lastModified ?? Date.now());

    if (offset + 30 + name.length + size > MAX_BYTES) {
      throw new ZipTooLargeError();
    }

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed (2.0)
    lv.setUint16(6, 0x0800, true); // flags: names are UTF-8
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(name, 30);

    const isDir = entry.path.endsWith("/");
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, isDir ? 0x10 : 0, true); // external: MS-DOS directory bit
    cv.setUint32(42, offset, true); // local header offset
    cd.set(name, 46);

    parts.push(local);
    if (entry.file) parts.push(entry.file);
    central.push(cd);
    offset += local.length + size;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  if (offset + centralSize + 22 > MAX_BYTES) throw new ZipTooLargeError();

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset

  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
