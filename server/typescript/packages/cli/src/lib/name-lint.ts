// `meta verify` — the node-name AUTHORING lint.
//
// The loader accepts any string as a node `name`, on every port. An adopter's metadata
// carried a field named `"defaultCurrencyId "` (a trailing space, copied from legacy XML)
// and an identity named `"account_defaultCurrencyId _fk"`; both loaded with no error.
//
// WHY THIS IS A WARNING AND NOT A LOAD ERROR. It was weighed against the correction bar
// in docs/compatibility-policy.md and does not pass it: whitespace names WORK today on
// the core path — `meta migrate` emits a quoted column (`"default_currency_id "`) and the
// ObjectManager round-trips the key — and multi-word requirement names are documented to
// load. Refusing them at load would break metadata that does what its author asked, so
// the honest instrument is an advisory that names the edit.
//
// EVERY FINDING IS A WARNING, BY CONSTRUCTION — the same rule, and the same reasoning,
// as requirement-lint.ts's header. Nothing here reaches the exit code.
//
// REQUIREMENTS ARE NOT LINTED HERE. A requirement's name is its dotted ADDRESS and the
// requirement lint already owns it (WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE reports
// leading/trailing whitespace; a short multi-word label such as "Order Recording" is
// deliberately NOT reported, because renaming one moves its address and its emitted
// stub file for no gain). Reporting the same name twice under two codes would make
// one edit look like two problems.
//
// IT READS THE LOADED MODEL, NEVER THE FILES — and walks DECLARATIONS (see `walk`).

import { PACKAGE_SEPARATOR, TYPE_FIELD, TYPE_REQUIREMENT, type MetaData } from "@metaobjectsdev/metadata";
import type { Diagnostic } from "./requirement-check.js";

/** Leading or trailing whitespace — the strong finding. */
export const WARN_NAME_SURROUNDING_WHITESPACE = "WARN_NAME_SURROUNDING_WHITESPACE";
/** Whitespace inside an otherwise trimmed name — the plain advisory. */
export const WARN_NAME_INTERNAL_WHITESPACE = "WARN_NAME_INTERNAL_WHITESPACE";

/**
 * What counts as whitespace: the ECMAScript `\s` class. That is ASCII space, tab, LF,
 * CR, VT and FF, plus U+00A0 (no-break space), U+FEFF, U+1680, U+2000–U+200A, U+2028,
 * U+2029, U+202F, U+205F and U+3000. The non-ASCII members matter for this lint's
 * actual source of input: a no-break space survives a copy out of a document or a
 * legacy export and is invisible in every editor.
 */
const WHITESPACE = /\s/u;

function warn(path: string, code: string, message: string): Diagnostic {
  return { severity: "warn", code, path, message };
}

/** One segment of a node's address. A name with whitespace is quoted so the
 *  whitespace is visible in the printed path rather than vanishing into it. */
function segment(name: string): string {
  return WHITESPACE.test(name) ? JSON.stringify(name) : name;
}

function check(node: MetaData, path: string, out: Diagnostic[]): void {
  const name = node.name;
  if (name === "" || !WHITESPACE.test(name)) return;

  const kind = `${node.type}.${node.subType}`;
  const quoted = JSON.stringify(name);
  // @column is a FIELD attribute. Advising an object or identity author to pin it
  // would send them looking for a slot that does not exist on the node.
  const pin = node.type === TYPE_FIELD ? ", and pin @column if the physical column must keep its name" : "";
  const trimmed = name.trim();

  if (trimmed !== name) {
    const inner = WHITESPACE.test(trimmed) ? " It also contains whitespace inside it." : "";
    const target = trimmed === "" ? "" : ` (to ${JSON.stringify(trimmed)}, presumably)`;
    out.push(warn(path, WARN_NAME_SURROUNDING_WHITESPACE,
      `${kind} name ${quoted} has leading or trailing whitespace, which is almost certainly ` +
      `unintended — rename it${target}${pin}. The whitespace is carried into every identifier, ` +
      `column and wire key derived from the name.${inner}`));
    return;
  }

  out.push(warn(path, WARN_NAME_INTERNAL_WHITESPACE,
    `${kind} name ${quoted} contains whitespace. A name is an identifier: derived column names ` +
    `and wire keys carry the space, and generated code cannot use it as one. Consider ` +
    `renaming it${pin}.`));
}

/** A root-level node's address: package-qualified the way `resolutionKey()` is, so the
 *  path reads like every other reference to the node. */
function topLevelAddress(node: MetaData): string {
  const pkg = node.package ?? node.fileDefaultPackage;
  return pkg !== undefined && pkg !== "" ? `${pkg}${PACKAGE_SEPARATOR}${segment(node.name)}` : segment(node.name);
}

/**
 * Lint the name of every named node in the loaded model, requirements excepted.
 * Returns `[]` for a model with no whitespace in any name.
 */
export function lintNodeNames(root: MetaData): Diagnostic[] {
  const out: Diagnostic[] = [];
  const walk = (n: MetaData, prefix: string): void => {
    // OWN-ONLY (ADR-0039 sanctioned case): this reports each DECLARATION once, at the
    // node that declares it. A field inherited through `extends` is one declaration and
    // one rename; the resolving `children()` would repeat it on every subtype.
    for (const c of n.ownChildren()) {
      if (c.type === TYPE_REQUIREMENT) continue; // owned by requirement-lint.ts — see header
      const path = prefix === "" ? topLevelAddress(c) : `${prefix}.${segment(c.name)}`;
      check(c, path, out);
      walk(c, path);
    }
  };
  walk(root, "");
  return out;
}
