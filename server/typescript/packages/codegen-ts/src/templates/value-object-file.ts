// Value-object file composer — emits a streamlined "value-only" module for
// metaobjects with no writable source.rdb child. Output is the TS interface +
// the Zod schema (and enum type aliases when applicable); no Drizzle table, no
// Infer*Model aliases, no filter allowlists. An `object.value` also gets a
// field-rules constant (`<VO>.<field>.rules`), without `$table` or `$path`.
//
// Two objects land here that are more than a value: a TPH subtype (it shares the
// base's table) and a SOURCELESS ENTITY (identity, no source: a record in a store
// MetaObjects does not manage — see isSourcelessEntity). Both get the create + PATCH
// schemas and the filter/sort allowlists on top of the interface.
//
// Dispatch: entity-file.ts routes here when hasWritableRdbSource(entity) is
// false. The entity may still have read-only source.* children (those are
// handled by the projection path before this one is reached).

import type { MetaObject } from "@metaobjectsdev/metadata";
import { OBJECT_SUBTYPE_VALUE } from "@metaobjectsdev/metadata";
import type { RenderContext } from "../render-context.js";
import { writeValueObjectInterface, writeEnumTypeAliases } from "./inferred-types.js";
import {
  renderInsertSchemaOnly,
  renderZodValidators,
  renderTphSubtypeReadSchema,
} from "./zod-validators.js";
import { isTphSubtype, tphDiscriminatorPin } from "../tph.js";
import { writeEntityConstants, writeValueObjectConstants } from "./entity-constants.js";
import { writeFilterAllowlist, writeSortAllowlist } from "./filter-allowlist.js";
import { writeFilterType } from "./filter-type.js";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE, sidecarComment } from "../constants.js";
import { namesRef, namesConstArg } from "../names.js";
import { isSourcelessEntity } from "../source-detect.js";
import { isAbstract } from "../instance-artifacts.js";
import { TsWriter } from "../writer/ts-writer.js";

/** `_apiPrefix` is unused: no section of a value-only module names a route. Kept for the signature. */
export function renderValueObjectFile(obj: MetaObject, _apiPrefix = "", ctx?: RenderContext): string {
  const w = new TsWriter();
  writeValueObjectFile(w, obj, ctx);
  return w.toString();
}

/** Write {@link renderValueObjectFile}'s module, header included, into `w`. */
export function writeValueObjectFile(w: TsWriter, obj: MetaObject, ctx?: RenderContext): void {
  // ADR-0044/#228 — the hand-edit sidecar name follows this value object's EMITTED
  // module name (== the generated filename), so the `.extra.ts` hint is correct
  // even for a collision-qualified value object. Byte-identical (bare) otherwise.
  const emittedName = ctx ? ctx.valueObjectEmittedName(obj) : obj.name;
  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${obj.name} (${obj.fqn()})`,
    sidecarComment(`${emittedName}.extra.ts`),
  );
  const tphSubtype = isTphSubtype(obj);
  // A sourceless entity's wire contract: create + PATCH schemas, allowlists, filter type.
  // No constants object — it names a table and a route this object does not have. The
  // allowlists import runtime types, so a contract-only target (runtime: false) skips them.
  const sourceless = !tphSubtype && isSourcelessEntity(obj);

  writeValueObjectInterface(w, obj, ctx);
  writeEnumTypeAliases(w, obj, ctx);
  // FR-017 Tier 2: a TPH subtype lands here (it inherits the base's source.rdb
  // but declares none of its own). In addition to the insert schema it emits a
  // full read schema `<Sub>Schema` so parse<Base>(row) can dispatch to it.
  if (tphSubtype) w.blank().code(renderTphSubtypeReadSchema(obj, ctx), { format: true });
  // FR-036 Program B: a TPH subtype needs BOTH schemas — its per-subtype PATCH
  // route must carry the FR-035 present-key tristate (a non-@required subtype
  // column accepts an explicit null → clears), which lives in the UpdateSchema
  // (.nullable() for non-required). renderZodValidators emits <Sub>InsertSchema +
  // <Sub>UpdateSchema (the update omits the pinned discriminator). A pure value
  // object stays insert-only (no PATCH semantics — an UpdateSchema would mislead).
  w.blank().code(tphSubtype || sourceless ? renderZodValidators(obj, ctx) : renderInsertSchemaOnly(obj, ctx), { format: true });
  if (tphSubtype) {
    // FR-017 Tier 3: a TPH subtype also emits its field-metadata constants object
    // (the `<Sub>` const), so the React form generator can render per-field
    // labels / rules / inputs the same way it does for ordinary entities.
    //
    // §A6/§B2 — a TPH subtype declares no source.rdb of its own; it INHERITS the
    // discriminator base's single shared table (`children()` is resolving — ADR-0039).
    // `resolveObjectNames` therefore returns a DEFINED result for it (`name` is the
    // BASE's physical table name, `fields` covers both the base's inherited columns and
    // the subtype's own), and `namesFile()` really does emit a `<Sub>.names.ts` for it.
    // Same `namesRef` pair every other §A6 site builds; `ctx` is present at every real
    // call site even though the parameter stays optional for a bare unit-test call.
    writeEntityConstants(w, obj, namesConstArg(ctx !== undefined ? namesRef(obj, ctx) : undefined));
  }
  // An `object.value` gets a field-rules constant, so a caller reads `<VO>.<field>.rules`
  // rather than the Zod schema's getters. It has no table or route, so the constant carries
  // no `$table`/`$path`. Only the value subtype: an abstract object, a TPH subtype, a
  // sourceless entity and an entity emitted to a contract-only target also land in this
  // composer, and none of them takes it.
  if (obj.subType === OBJECT_SUBTYPE_VALUE && !isAbstract(obj)) {
    writeValueObjectConstants(w, obj, ctx ? ctx.valueObjectEmittedName(obj) : undefined);
  }
  if (tphSubtype) {
    // FR-017 Tier 3: per-subtype filter + sort allowlists, excluding the
    // discriminator (it's pinned by the per-subtype route path, so a client must
    // not filter on it). Included fields are the subtype's own + inherited base
    // filterable fields. Drives the per-subtype REST routes' filter layer. The
    // per-subtype CLIENT filter type is discriminator-excluded too, in lockstep with
    // the allowlist, so a typed `<Sub>Filter` can't express a filter the server would 400.
    const discField = tphDiscriminatorPin(obj)?.fieldName;
    writeFilterAllowlist(w, obj, discField, ctx);
    writeSortAllowlist(w, obj, discField, ctx);
    writeFilterType(w, obj, discField, ctx?.loadedRoot);
  }
  if (sourceless) {
    if (ctx?.selfTarget.runtime !== false) {
      writeFilterAllowlist(w, obj, undefined, ctx);
      writeSortAllowlist(w, obj, undefined, ctx);
    }
    writeFilterType(w, obj, undefined, ctx?.loadedRoot);
  }
}
