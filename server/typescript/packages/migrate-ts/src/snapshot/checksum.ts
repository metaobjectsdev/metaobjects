// src/snapshot/checksum.ts
import { createHash } from "node:crypto";
import type { SchemaSnapshot } from "../types.js";
import { serializeSnapshot } from "./serialize.js";

/**
 * Deterministic sha256 of a schema snapshot. Reuses the canonical
 * (order-stable, byte-identical) serializer, so the hash is independent of
 * table/column ordering and depends only on the schema's content. Used to make
 * the committed snapshot tamper-evident (record the hash; a later hand-edit
 * changes it) and as the baseline marker's payload.
 */
export function snapshotChecksum(snapshot: SchemaSnapshot): string {
  return createHash("sha256").update(serializeSnapshot(snapshot), "utf8").digest("hex");
}
