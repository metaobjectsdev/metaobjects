// declaredDuplicateFields — structural pre-parse walk for the `meta verify` field lint.
//
// Two `field.*` children with the same `name` in ONE object's `children` list load
// with no error on every port, and the loaded model keeps no trace of it: the parser's
// merge rule folds the later declaration into the first (a different subtype is
// discarded outright). So the question "was this field declared twice?" can only be
// answered from the document, before the merge — the same reason
// `declaredTopLevelKeys` exists for the overlay lint.
//
// Scope, deliberately narrow:
//   - ONE children list. The same field declared in a base file and again in an
//     overlay file is the overlay merge working as designed, and a subtype
//     redeclaring an inherited field is an override. Neither is in one list.
//   - Root-level objects only, addressed by the resolution key the parser gives them.

import { TYPE_FIELD, TYPE_METADATA, TYPE_OBJECT, SUBTYPE_ROOT } from "../shared/base-types.js";
import {
  PACKAGE_SEPARATOR,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  TYPE_SUBTYPE_SEPARATOR,
} from "../shared/structural.js";
import { expandPackageForPath } from "../parser-core.js";
import { parseYamlWithPositions } from "../core/yaml-positions-walker.js";
import type { MetaDataFormat } from "./meta-data-source.js";

/** The YAML authoring sugar for `isArray: true` — a suffix on the wrapper key. */
const ARRAY_SUFFIX = "[]";

/** One field name declared more than once in one object's `children` list. */
export interface DeclaredDuplicateField {
  /** The declaring object's resolution key (`<package>::<name>`, or the bare name). */
  object: string;
  /** The repeated field name. */
  field: string;
  /** How many times the list declares it (always 2 or more). */
  count: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The TYPE segment of a wrapper key: `field.string[]` and the bare `field` are both `field`. */
function wrapperType(key: string): string {
  const dot = key.indexOf(TYPE_SUBTYPE_SEPARATOR);
  const head = dot < 0 ? key : key.slice(0, dot);
  return head.endsWith(ARRAY_SUFFIX) ? head.slice(0, -ARRAY_SUFFIX.length) : head;
}

/** A node's declared name: the body's `name`, or the body itself when YAML wrote a scalar. */
function declaredName(body: unknown): string | undefined {
  const name = isRecord(body) ? body[RESERVED_KEY_NAME] : body;
  return typeof name === "string" && name !== "" ? name : undefined;
}

/**
 * Structurally scan a source's raw content and report every field name a root-level
 * object declares more than once in its own `children` list, in document order.
 *
 * Malformed shapes return `[]` rather than throwing — the real parse is where a
 * structural error surfaces. A syntax error does throw, as `declaredTopLevelKeys` does.
 */
export function declaredDuplicateFields(
  content: string,
  format: MetaDataFormat,
): ReadonlyArray<DeclaredDuplicateField> {
  // Strip UTF-8 BOM if present (mirrors parseJson / parseYaml).
  const normalized = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  let parsed: unknown;
  if (format === "json") parsed = JSON.parse(normalized);
  else if (format === "yaml") parsed = parseYamlWithPositions(normalized).value;
  else return [];
  if (!isRecord(parsed)) return [];

  // JSON fuses the subtype onto the root key; sigil-free YAML may write the bare type.
  const rootBody = parsed[`${TYPE_METADATA}${TYPE_SUBTYPE_SEPARATOR}${SUBTYPE_ROOT}`] ?? parsed[TYPE_METADATA];
  if (!isRecord(rootBody)) return [];
  const rawRootPkg = rootBody[RESERVED_KEY_PACKAGE];
  const rootPkg = typeof rawRootPkg === "string" ? rawRootPkg : "";
  const children = rootBody[RESERVED_KEY_CHILDREN];
  if (!Array.isArray(children)) return [];

  const out: DeclaredDuplicateField[] = [];
  for (const child of children) {
    if (!isRecord(child)) continue;
    for (const [wrapperKey, body] of Object.entries(child)) {
      if (wrapperType(wrapperKey) !== TYPE_OBJECT || !isRecord(body)) continue;
      const name = declaredName(body);
      const members = body[RESERVED_KEY_CHILDREN];
      if (name === undefined || !Array.isArray(members)) continue;

      const counts = new Map<string, number>();
      for (const member of members) {
        if (!isRecord(member)) continue;
        for (const [memberKey, memberBody] of Object.entries(member)) {
          if (wrapperType(memberKey) !== TYPE_FIELD) continue;
          const fieldName = declaredName(memberBody);
          if (fieldName !== undefined) counts.set(fieldName, (counts.get(fieldName) ?? 0) + 1);
        }
      }

      const rawOwnPkg = body[RESERVED_KEY_PACKAGE];
      const pkg =
        typeof rawOwnPkg === "string" && rawOwnPkg !== "" ? expandPackageForPath(rootPkg, rawOwnPkg) : rootPkg;
      const object = pkg !== "" ? `${pkg}${PACKAGE_SEPARATOR}${name}` : name;
      for (const [field, count] of counts) {
        if (count > 1) out.push({ object, field, count });
      }
    }
  }
  return out;
}
