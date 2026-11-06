// server/typescript/packages/cli/src/lib/zip-read.ts
//
// A minimal, read-only ZIP reader for the `maven` and `nuget` dependency
// transports: a JAR and a `.nupkg` are both plain ZIP archives, and `meta deps
// sync` only ever needs a handful of small files out of one. It reads the central
// directory, supports the two methods every archiver emits (stored and deflate),
// and refuses everything else (ZIP64, encryption, other compression) by name
// rather than guess. No dependency: `node:zlib` does the inflating.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x1;

/** One file inside an archive: its name (forward slashes) and uncompressed bytes. */
export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** The archive is not one this reader understands, or is damaged. */
export class ZipError extends Error {}

function findEndOfCentralDirectory(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError("not a ZIP archive (no end-of-central-directory record)");
}

/**
 * Every file entry whose name starts with `prefix` (use `""` for all), read from
 * the archive at `path`. Directory entries are skipped. Entry names are returned
 * as stored; a name that is absolute or climbs out with `..` is refused, since a
 * caller will write them under a directory of its own.
 */
export function readZipEntries(path: string, prefix = ""): ZipEntry[] {
  const buf = readFileSync(path);
  const eocd = findEndOfCentralDirectory(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || offset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");

  const out: ZipEntry[] = [];
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new ZipError("corrupt central directory");
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/") || !name.startsWith(prefix)) continue;
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw new ZipError(`entry "${name}" would escape the extraction directory`);
    }
    if ((flags & FLAG_ENCRYPTED) !== 0) throw new ZipError(`entry "${name}" is encrypted`);
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new ZipError(`corrupt local header for "${name}"`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === METHOD_STORED) out.push({ name, data: Buffer.from(raw) });
    else if (method === METHOD_DEFLATE) out.push({ name, data: inflateRawSync(raw) });
    else throw new ZipError(`entry "${name}" uses compression method ${method}, which is not supported`);
  }
  return out;
}
