import type { AnyRecord } from "../records/any.js";
import type { RecordType } from "../records/core.js";
import { readRecord, recordExists } from "./read.js";
import { writeRecord, removeRecord } from "./write.js";
import { ForgeAlreadyPromotedError, ForgeRecordNotFoundError } from "./errors.js";
import { recordPath } from "../paths.js";

export async function promoteRecord(
  metaRoot: string,
  type: RecordType,
  id: string,
): Promise<void> {
  if (!(await recordExists(metaRoot, type, id, { pending: true }))) {
    throw new ForgeRecordNotFoundError(recordPath(metaRoot, type, id, { pending: true }));
  }
  if (await recordExists(metaRoot, type, id)) {
    throw new ForgeAlreadyPromotedError(recordPath(metaRoot, type, id));
  }
  const record = await readRecord(metaRoot, type, id, { pending: true });
  await writeRecord(metaRoot, record);
  await removeRecord(metaRoot, type, id, { pending: true });
}

export async function supersede(
  metaRoot: string,
  oldId: string,
  newRecord: AnyRecord,
): Promise<void> {
  if (!(await recordExists(metaRoot, newRecord.type, oldId))) {
    throw new ForgeRecordNotFoundError(recordPath(metaRoot, newRecord.type, oldId));
  }
  // Write the new record first, so a failure leaves the old record intact.
  await writeRecord(metaRoot, newRecord);
  // Then update the old record to mark it superseded.
  const old = await readRecord(metaRoot, newRecord.type, oldId);
  const updated = { ...old, superseded_by: newRecord.id };
  await writeRecord(metaRoot, updated);
}
