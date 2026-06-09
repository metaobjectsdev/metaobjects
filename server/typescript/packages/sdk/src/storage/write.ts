import { mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { AnyRecord } from "../records/any.js";
import { AnyRecord as AnyRecordSchema } from "../records/any.js";
import { recordPath } from "../paths.js";
import { ForgeRecordNotFoundError } from "./errors.js";
import { recordExists } from "./read.js";

export async function writeRecord(
  metaRoot: string,
  record: AnyRecord,
  opts: { pending?: boolean } = {},
): Promise<void> {
  // Validate before any IO
  AnyRecordSchema.parse(record);

  const path = recordPath(metaRoot, record.type, record.id, opts);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8");
}

export async function removeRecord(
  metaRoot: string,
  type: AnyRecord["type"],
  id: string,
  opts: { pending?: boolean } = {},
): Promise<void> {
  if (!(await recordExists(metaRoot, type, id, opts))) {
    throw new ForgeRecordNotFoundError(recordPath(metaRoot, type, id, opts));
  }
  await unlink(recordPath(metaRoot, type, id, opts));
}
