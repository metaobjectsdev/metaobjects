// ADR-0044 collision-scoped naming — shared across every codegen tier that emits
// declarations from a reference closure (payload records today; the entity +
// extract/output-parser tiers per issue #228).
//
// `assignEmittedNames` is a PURE function of the closure: a bare short name
// unique in the closure emits bare; a collision emits EVERY member under its
// package-qualified derived name (PascalCase each package segment + short
// name). A still-colliding derived name fails loud (ERR_PAYLOAD_NAME_COLLISION).

import { type MetaData, PACKAGE_SEPARATOR } from "@metaobjectsdev/metadata";

// ADR-0044 backstop error code — a codegen-time (not loader) error, peer of
// @metaobjectsdev/render's ERR_VAR_NOT_ON_PAYLOAD. Declared LOCALLY rather than
// added to packages/metadata/src/errors.ts's ERROR_CODES ledger: that ledger is
// checked for FULL cross-port agreement against fixtures/conformance/ERROR-CODES.json
// (packages/metadata/test/errors.test.ts) and, on the Python side, for corpus-code
// coverage — registering it there before every port implements the ADR-0044 fix
// would turn those OTHER ports' tests red. It moves into the shared ledger once the
// Java/Kotlin/Python follow-up (ADR-0044 §4, items 3-4) lands alongside this code.
export const ERR_PAYLOAD_NAME_COLLISION = "ERR_PAYLOAD_NAME_COLLISION";

function pascalSegment(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** ADR-0044 — package-qualified derived name for a collision member: PascalCase
 *  each `::`-segment of the node's effective package, concatenated, then the
 *  bare short name (`acme::alpha::Note` -> `AcmeAlphaNote`). A root-level
 *  (no-package) node has nothing to qualify with and keeps its bare name — two
 *  root-level VOs can never share a name (the loader's own-package uniqueness
 *  already rejects that), so this can't silently under-qualify. */
export function packageQualifiedName(pkg: string, shortName: string): string {
  if (pkg === "") return shortName;
  return (
    pkg
      .split(PACKAGE_SEPARATOR)
      .map(pascalSegment)
      .join("") + shortName
  );
}

/**
 * ADR-0044 pass 2 — assign the emitted TS name for every VO in the closure. A
 * PURE function of the closure's (fqn, bareName, package) triples — never of
 * traversal order: bare short name unique in the closure -> bare name; a
 * collision -> EVERY member gets its package-qualified derived name. If two
 * DISTINCT fqns still derive the same name after qualification, throws
 * (ERR_PAYLOAD_NAME_COLLISION) — never silently wrong.
 */
export function assignEmittedNames(closure: ReadonlyMap<string, MetaData>): Map<string, string> {
  const byShortName = new Map<string, string[]>();
  for (const [fqn, node] of closure) {
    const bucket = byShortName.get(node.name);
    if (bucket) bucket.push(fqn);
    else byShortName.set(node.name, [fqn]);
  }

  const nameMap = new Map<string, string>();
  for (const [shortName, fqns] of byShortName) {
    if (fqns.length === 1) {
      nameMap.set(fqns[0]!, shortName);
      continue;
    }
    for (const fqn of fqns) {
      const node = closure.get(fqn)!;
      const pkg = node.package ?? node.fileDefaultPackage ?? "";
      nameMap.set(fqn, packageQualifiedName(pkg, shortName));
    }
  }

  // Backstop — sorted by fqn so which pair the message names (and whether the
  // set of colliding names is non-empty) is a pure function of the closure, not
  // of Map insertion/traversal order.
  const ownerOf = new Map<string, string>();
  for (const fqn of [...nameMap.keys()].sort()) {
    const emitted = nameMap.get(fqn)!;
    const existing = ownerOf.get(emitted);
    if (existing !== undefined && existing !== fqn) {
      throw new Error(
        `${ERR_PAYLOAD_NAME_COLLISION}: payload record name collision: "${emitted}" derives from both "${existing}" and "${fqn}" — rename one value-object or move it to a package that derives a distinct name`,
      );
    }
    ownerOf.set(emitted, fqn);
  }

  return nameMap;
}
