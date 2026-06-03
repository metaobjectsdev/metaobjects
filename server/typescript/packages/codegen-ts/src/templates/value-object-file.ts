// Value-object file composer — emits a streamlined "value-only" module for
// metaobjects with no writable source.rdb child. Output is just the TS
// interface + the Zod schema (and enum type aliases when applicable); no
// Drizzle table, no Infer*Model aliases, no filter allowlists, no constants
// object.
//
// Dispatch: entity-file.ts routes here when hasWritableRdbSource(entity) is
// false. The entity may still have read-only source.* children (those are
// handled by the projection path before this one is reached).

import { joinCode, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { renderValueObjectInterface, renderEnumTypeAliases } from "./inferred-types.js";
import {
  renderInsertSchemaOnly,
  isTphSubtype,
  renderTphSubtypeReadSchema,
  tphDiscriminatorPin,
} from "./zod-validators.js";
import { renderEntityConstants } from "./entity-constants.js";
import { renderFilterAllowlist, renderSortAllowlist } from "./filter-allowlist.js";
import { renderFilterType } from "./filter-type.js";
import { GENERATED_HEADER } from "../constants.js";

export function renderValueObjectFile(obj: MetaObject, apiPrefix = ""): string {
  const enumAliases = renderEnumTypeAliases(obj);
  // FR-017 Tier 2: a TPH subtype lands here (it inherits the base's source.rdb
  // but declares none of its own). In addition to the insert schema it emits a
  // full read schema `<Sub>Schema` so parse<Base>(row) can dispatch to it.
  const tphSubtype = isTphSubtype(obj);
  const tphReadSchema = tphSubtype ? renderTphSubtypeReadSchema(obj) : null;
  // FR-017 Tier 3: a TPH subtype also emits its field-metadata constants object
  // (the `<Sub>` const), so the React form generator can render per-field
  // labels / rules / inputs the same way it does for ordinary entities.
  const tphConstants = tphSubtype ? renderEntityConstants(obj, apiPrefix) : null;
  // FR-017 Tier 3: per-subtype filter + sort allowlists, excluding the
  // discriminator (it's pinned by the per-subtype route path, so a client must
  // not filter on it). Included fields are the subtype's own + inherited base
  // filterable fields. Drives the per-subtype REST routes' filter layer.
  const discField = tphSubtype ? tphDiscriminatorPin(obj)?.fieldName : undefined;
  const tphFilterAllowlist = tphSubtype ? renderFilterAllowlist(obj, discField) : null;
  const tphSortAllowlist = tphSubtype ? renderSortAllowlist(obj, discField) : null;
  // FR-017 Tier 3: the per-subtype CLIENT filter type, discriminator-excluded —
  // kept in lockstep with the per-subtype allowlist above so a typed
  // `<Sub>Filter` can't express a filter the server allowlist would 400.
  const tphFilterType = tphSubtype ? renderFilterType(obj, discField) : null;
  const sections: Code[] = [
    renderValueObjectInterface(obj),
    ...(enumAliases !== null ? [enumAliases] : []),
    ...(tphReadSchema !== null ? [tphReadSchema] : []),
    renderInsertSchemaOnly(obj),
    ...(tphConstants !== null ? [tphConstants] : []),
    ...(tphFilterAllowlist !== null ? [tphFilterAllowlist] : []),
    ...(tphSortAllowlist !== null ? [tphSortAllowlist] : []),
    ...(tphFilterType !== null ? [tphFilterType] : []),
  ];
  const body = joinCode(sections, { on: "\n" }).toString();
  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${obj.name} (${obj.fqn()})\n` +
    `// Customize via ${obj.name}.extra.ts in this directory.\n`;
  return header + body;
}
