import { readFile, stat } from "node:fs/promises";
import type { AnyRecord } from "../records/any.js";
import { AnyRecord as AnyRecordSchema } from "../records/any.js";
import type { RecordType } from "../records/core.js";
import { recordPath } from "../paths.js";
import { ForgeRecordNotFoundError, ForgeRecordParseError } from "./errors.js";

export async function readRecord(
  metaRoot: string,
  type: RecordType,
  id: string,
  opts: { pending?: boolean } = {},
): Promise<AnyRecord> {
  const path = recordPath(metaRoot, type, id, opts);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNoEntError(err)) throw new ForgeRecordNotFoundError(path);
    throw err;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new ForgeRecordParseError(path, err);
  }
  const result = AnyRecordSchema.safeParse(parsedJson);
  if (!result.success) throw new ForgeRecordParseError(path, result.error);
  return result.data;
}

export async function recordExists(
  metaRoot: string,
  type: RecordType,
  id: string,
  opts: { pending?: boolean } = {},
): Promise<boolean> {
  try {
    await stat(recordPath(metaRoot, type, id, opts));
    return true;
  } catch {
    return false;
  }
}

function isNoEntError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
