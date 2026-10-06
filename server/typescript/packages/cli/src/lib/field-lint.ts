// `meta verify` — the field AUTHORING lint.
//
// Two metadata mistakes about an object's FIELDS load with no error on every port:
//
//   1. An `identity.reference` whose `@fields` names a field the object does not have.
//      The loader resolves `@references` (the target) and never looks at `@fields`, so a
//      typo there produces a foreign key over a column nothing declares.
//   2. Two `field.*` children with the same `name` in one object's `children` list. The
//      later declaration is folded into the first, and one of a different subtype is
//      dropped, both silently.
//
// WHY THESE ARE WARNINGS AND NOT LOAD ERRORS. docs/compatibility-policy.md does not allow
// a new load error for metadata that loads today — name-lint.ts's header has the same
// ruling for whitespace names. So, like every sibling lint in this directory:
//
// EVERY FINDING IS A WARNING, BY CONSTRUCTION. Nothing here reaches the exit code.
//
// THE TWO HALVES READ DIFFERENT THINGS, and have to. The reference half reads the LOADED
// model, because "does this object have that field" is a question about the EFFECTIVE
// field set — inherited through `extends` and merged from overlay files. The duplicate
// half reads the RAW DOCUMENTS, because the merge has already erased the duplicate from
// the model by the time anything can ask (overlay-lint.ts reads files for the same reason).
//
// The codes, the message text and the fixtures are shared with the C#, Java and Python
// CLIs: fixtures/field-lint-conformance/.

import {
  IDENTITY_ATTR_FIELDS,
  IDENTITY_SUBTYPE_REFERENCE,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_OBJECT,
  type MetaData,
  type MetaDataSource,
} from "@metaobjectsdev/metadata";
import { declaredDuplicateFields, type DeclaredDuplicateField } from "@metaobjectsdev/metadata/core";
import type { Diagnostic } from "./requirement-check.js";

/** An `identity.reference` lists a field its object does not have. */
export const WARN_REFERENCE_FIELD_NOT_FOUND = "WARN_REFERENCE_FIELD_NOT_FOUND";
/** One `children` list declares the same field name more than once. */
export const WARN_DUPLICATE_FIELD_NAME = "WARN_DUPLICATE_FIELD_NAME";

/** Resolve one metadata file path to the source the duplicate scan reads it through. */
export type ReadSource = (path: string) => MetaDataSource;

function warn(path: string, code: string, message: string): Diagnostic {
  return { severity: "warn", code, path, message };
}

/**
 * Report every `identity.reference` whose `@fields` names a field its object lacks.
 * Returns `[]` for a model where every listed field exists.
 */
export function lintReferenceFields(root: MetaData): Diagnostic[] {
  const out: Diagnostic[] = [];
  // OWN-ONLY (ADR-0039 sanctioned case): a root has no super, and its own children are
  // the declared objects.
  for (const object of root.ownChildren()) {
    if (object.type !== TYPE_OBJECT) continue;
    const address = object.resolutionKey();
    // RESOLVING: the effective field set — a field inherited through `extends` or added
    // by an overlay file is a field the object has.
    const fields = new Set(object.children().filter((c) => c.type === TYPE_FIELD).map((c) => c.name));
    // OWN-ONLY (ADR-0039 sanctioned case): report each DECLARATION once, on the object
    // that declares it. The resolving `children()` would repeat an inherited reference
    // on every subtype.
    for (const identity of object.ownChildren()) {
      if (identity.type !== TYPE_IDENTITY || identity.subType !== IDENTITY_SUBTYPE_REFERENCE) continue;
      // RESOLVING: `@fields` may itself be inherited through the identity's `extends`.
      const listed = identity.attr(IDENTITY_ATTR_FIELDS);
      const names = Array.isArray(listed) ? listed : typeof listed === "string" ? [listed] : [];
      for (const name of names) {
        if (typeof name !== "string" || fields.has(name)) continue;
        out.push(warn(`${address}.${identity.name}`, WARN_REFERENCE_FIELD_NOT_FOUND, referenceFieldMessage(identity.name, name, address)));
      }
    }
  }
  return out;
}

function referenceFieldMessage(identity: string, field: string, object: string): string {
  return (
    `identity.reference ${JSON.stringify(identity)} lists ${JSON.stringify(field)} in @fields, but ` +
    `${object} has no field of that name, inherited and overlaid fields included. Nothing checks ` +
    `this at load, so the reference is built on a field that does not exist. Rename the entry to ` +
    `an existing field, or declare the field.`
  );
}

/** One raw-scan finding as a diagnostic. Exported so the scan and its text are testable
 *  without a filesystem. */
export function duplicateFieldDiagnostic(dup: DeclaredDuplicateField): Diagnostic {
  return warn(
    `${dup.object}.${dup.field}`,
    WARN_DUPLICATE_FIELD_NAME,
    `${dup.object} declares the field ${JSON.stringify(dup.field)} ${dup.count} times in one children ` +
      `list. Nothing reports this at load, and only the first declaration is certain to take effect. ` +
      `Remove or rename the duplicate.`,
  );
}

/**
 * Report every field name declared more than once in one object's `children` list,
 * scanning each of `files` as raw content.
 *
 * Unreadable or unparsable files are skipped — the loader reports those itself.
 */
export async function lintDuplicateFields(files: readonly string[], readSource: ReadSource): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  for (const path of files) {
    let declared: ReadonlyArray<DeclaredDuplicateField>;
    try {
      const source = readSource(path);
      declared = declaredDuplicateFields(await source.read(), source.format);
    } catch {
      continue;
    }
    out.push(...declared.map(duplicateFieldDiagnostic));
  }
  return out;
}
