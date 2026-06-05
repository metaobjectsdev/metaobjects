// Pre-pass: inject voRequest/voResponse field.object columns onto entities that
// extend LlmCallBase and carry a nested template.prompt with @payloadRef/@responseRef.
//
// This runs before any generator reads the entity's fields, so the injected
// field.object nodes are visible to the existing column mapper + entity emitter
// without any generator-level changes. The fields are injected as owned children
// of the concrete entity — they behave identically to hand-authored field.object
// nodes with @storage:jsonb.

import { MetaField, TypeId } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_TEMPLATE,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
  STORAGE_JSONB,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_RESPONSE_REF,
} from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";

export const LLM_CALL_BASE = "LlmCallBase";

/** Walk the super chain looking for a node whose name matches `baseName`. */
function extendsBase(obj: MetaData, baseName: string): boolean {
  let cur: MetaData | undefined = obj.superResolved;
  while (cur !== undefined) {
    if (cur.name === baseName) return true;
    cur = cur.superResolved;
  }
  return false;
}

/**
 * Inject a field.object child onto `entity` if a field of that name does not
 * already exist (idempotent). The injected field carries @objectRef and
 * @storage:jsonb so the existing column mapper emits a jsonb() Postgres column.
 */
function injectObjField(entity: MetaData, fieldName: string, objectRef: string): void {
  // Idempotent: skip if an own field with this name already exists.
  if (entity.ownChildren().some((c) => c.type === TYPE_FIELD && c.name === fieldName)) {
    return;
  }
  const f = new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_OBJECT), fieldName);
  f.setAttr(FIELD_ATTR_OBJECT_REF, objectRef);
  f.setAttr(FIELD_ATTR_STORAGE, STORAGE_JSONB);
  entity.addChild(f);
}

/**
 * Codegen pre-pass: for every concrete entity that:
 *   1. extends LlmCallBase (directly or transitively), and
 *   2. has a nested template.prompt carrying @payloadRef and/or @responseRef,
 *
 * inject field.object children named voRequest/voResponse (respectively) with
 * @storage:jsonb onto that entity before generators run.
 *
 * Call this on the loaded MetaRoot immediately before running generators.
 */
export function deriveTraceFields(root: MetaData): void {
  for (const obj of root.ownChildren()) {
    if (obj.type !== TYPE_OBJECT) continue;
    if (!extendsBase(obj, LLM_CALL_BASE)) continue;

    const prompt = obj.ownChildren().find(
      (c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_PROMPT,
    );
    if (prompt === undefined) continue;

    const payloadRef = prompt.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
    const responseRef = prompt.ownAttr(TEMPLATE_ATTR_RESPONSE_REF);

    if (typeof payloadRef === "string") {
      injectObjField(obj, "voRequest", payloadRef);
    }
    if (typeof responseRef === "string") {
      injectObjField(obj, "voResponse", responseRef);
    }
  }
}
