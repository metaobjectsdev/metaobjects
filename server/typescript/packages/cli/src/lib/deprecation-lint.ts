// `meta verify` — the deprecated-REFERENCE authoring lint (#305).
//
// `deprecated` / `replacedBy` are registered documentation common-attrs in every
// port (doc-provider.ts) and nothing reads them: no validation pass, no `verify`
// check, no codegen behavior. A deprecation you cannot enforce is a comment.
//
// Smallest useful version (approved scope): warn when a node DEPENDS on a node
// carrying `deprecated`, through the reference kinds the metamodel already has —
// `extends`, `@objectRef`, `@references`, and an origin's `@from` / `@of` / `@via`
// path. Where the deprecated node also carries `replacedBy`, the diagnostic names
// the replacement. Never fails the build — ADVISORY ONLY, the same discipline as
// every sibling authoring lint in this directory (name-lint.ts, overlay-lint.ts,
// requirement-lint.ts).
//
// Explicitly NOT in scope here (tracked separately): a deprecation DATE that
// escalates warn -> error once passed, and per-finding suppressions with a
// recorded reason (#302) — both need their own design.
//
// SELF-REFERENCE IS NOT A FINDING, but ONLY the literal case: the same node, or
// one of the node's own ANCESTORS (the recursive-FK shape: `Category.parentId`
// is a child of `Category` and points back at `Category` itself — not a
// dependency on a different thing, it IS the deprecated thing). A DIFFERENT
// node that merely happens to live under the same entity — e.g. a passthrough
// field reading a DEPRECATED SIBLING field on its own entity — is a real
// cross-node dependency and DOES warn; sharing an ancestor is not sharing an
// identity. Guarded by `isSelfReference` below.
//
// Resolution reads the LOADED, FROZEN model only, via the RESOLVING accessors
// (ADR-0039: `attr()`, `children()`, `superData`) — so a target that inherits
// `deprecated` from its own abstract base still counts, and a reference
// inherited through `extends` is reported once, at its declaration
// (`ownChildren()`, the same sanctioned case name-lint.ts uses).

import {
  DOC_ATTR_DEPRECATED,
  DOC_ATTR_REPLACED_BY,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_RELATIONSHIP,
  TYPE_ORIGIN,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  RELATIONSHIP_ATTR_OBJECT_REF,
  FIELD_ATTR_OBJECT_REF,
  // @via is spelled identically on every origin subtype (passthrough / aggregate /
  // first); @of is identical on aggregate and first. One constant each, reused —
  // see origin-constants.ts.
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_OF,
  isMetaObject,
  resolveObjectRef,
  type MetaData,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import type { Diagnostic } from "./requirement-check.js";

export const WARN_DEPRECATED_REFERENCE = "WARN_DEPRECATED_REFERENCE";

function warn(path: string, message: string): Diagnostic {
  return { severity: "warn", code: WARN_DEPRECATED_REFERENCE, path, message };
}

// ---------------------------------------------------------------------------
// addressing — mirrors name-lint.ts's topLevelAddress/segment, applied to every
// node (not only ones whose own name is the finding).
// ---------------------------------------------------------------------------

function packageOf(node: MetaData): string {
  return node.package ?? node.fileDefaultPackage ?? "";
}

/** Walk up to the nearest enclosing `object.*` — every field/identity/relationship/
 *  origin is nested under exactly one (objects are never nested in this metamodel). */
function owningObject(node: MetaData): MetaObject | undefined {
  let cur: MetaData | undefined = node.parent;
  while (cur !== undefined && !isMetaObject(cur)) cur = cur.parent;
  return cur;
}

/** A human-readable address for a node: the object's FQN, or `<object FQN>.<name>` for
 *  something nested inside one. Falls back to the bare name (an abstract field
 *  declared at root, outside any object) when there is no enclosing object. */
function addressOf(node: MetaData): string {
  if (isMetaObject(node)) return node.resolutionKey();
  const owner = owningObject(node);
  return owner !== undefined ? `${owner.resolutionKey()}.${node.name}` : node.name;
}

// ---------------------------------------------------------------------------
// self-reference guard
// ---------------------------------------------------------------------------

function isAncestorOf(maybeAncestor: MetaData, node: MetaData): boolean {
  let cur: MetaData | undefined = node.parent;
  while (cur !== undefined) {
    if (cur === maybeAncestor) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * True when `target` is not really an OTHER node from `referrer`'s point of
 * view: the same node, or an ANCESTOR of it (the referrer's own enclosing
 * object/field — the recursive-FK shape). Deliberately NOT symmetric: a
 * DESCENDANT of `referrer` is a real, different thing to depend on (and no
 * call site here ever resolves a target nested inside the specific referrer
 * node anyway — a sibling field, the common case, is nested in the shared
 * parent ENTITY, not in the referrer).
 */
function isSelfReference(referrer: MetaData, target: MetaData): boolean {
  return referrer === target || isAncestorOf(target, referrer);
}

// ---------------------------------------------------------------------------
// the check: does `target` carry `deprecated`, resolved?
// ---------------------------------------------------------------------------

/** Returns true when a finding was pushed — callers checking a MORE SPECIFIC
 *  target first (e.g. a field) use this to decide whether to also check the
 *  less-specific one (its entity): only when the specific one was silent. */
function considerTarget(referrer: MetaData, referrerPath: string, verb: string, target: MetaData, out: Diagnostic[]): boolean {
  if (isSelfReference(referrer, target)) return false;
  // Registry contract (documentation-definition.embedded.ts): "Presence ⇒
  // deprecated" — an empty-string reason still means deprecated (codegen-ts's
  // jsdoc.ts reads it the same way, via `!== undefined`, not a truthiness
  // check). Only an ABSENT attr (undefined) means "not deprecated".
  const reason = target.attr(DOC_ATTR_DEPRECATED);
  if (typeof reason !== "string") return false;
  const replacedByRaw = target.attr(DOC_ATTR_REPLACED_BY);
  const replacedBy = typeof replacedByRaw === "string" && replacedByRaw !== "" ? replacedByRaw : undefined;
  const targetKind = `${target.type}.${target.subType}`;
  const reasonClause = reason !== "" ? `: ${reason}` : "";
  out.push(
    warn(
      referrerPath,
      `${verb} deprecated ${targetKind} ${addressOf(target)}${reasonClause}` +
        (replacedBy !== undefined ? ` Replaced by ${replacedBy}.` : ""),
    ),
  );
  return true;
}

/** Split a dotted reference into its entity HEAD and member tail ("Entity.field" ->
 *  "Entity" / "field"). `@objectRef` carries no tail (a pure object ref) and is
 *  resolved whole by the caller; `@references`/`@from`/`@of`/`@via` do. */
function headOf(raw: string): string {
  const dot = raw.indexOf(".");
  return dot === -1 ? raw : raw.slice(0, dot);
}

function resolveEntityRef(root: MetaData, ref: string, referrerPkg: string): MetaObject | undefined {
  const node = resolveObjectRef(root, ref, referrerPkg).node;
  return node !== undefined && isMetaObject(node) ? node : undefined;
}

/** The relationship / identity.reference CHILD on `entity` named `hopName` — a
 *  `@via` path segment. Resolving `children()` (ADR-0039): an inherited hop still
 *  counts. */
function findHop(entity: MetaObject, hopName: string): MetaData | undefined {
  return entity.children().find(
    (c) =>
      (c.type === TYPE_RELATIONSHIP || (c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_REFERENCE)) &&
      c.name === hopName,
  );
}

/** The entity a resolved hop (relationship or identity.reference) points at, raw. */
function hopTargetRef(hop: MetaData): string | undefined {
  const v = hop.type === TYPE_RELATIONSHIP
    ? hop.attr(RELATIONSHIP_ATTR_OBJECT_REF)
    : hop.attr(IDENTITY_REFERENCE_ATTR_REFERENCES);
  return typeof v === "string" && v !== "" ? headOf(v) : undefined;
}

/**
 * Check a dotted "Entity" or "Entity.field" reference — shared by origin
 * `@from`/`@of` AND identity.reference's `@references` (ADR-0042 §5: the
 * dotted form is not origin-specific; `Team.code` names an explicit FK target
 * field exactly the way `Country.name` names a passthrough source field — see
 * `fixtures/conformance/relationship-one-two-refs-dotted-references/`). The
 * field is the more specific target (checked first); the entity is checked
 * independently so a field on an otherwise-fine entity, OR a whole deprecated
 * entity, each warn. Resolution failure (either half) is silent — bias to
 * under-flagging, the same stance every sibling advisory pass in this
 * directory takes.
 */
function checkEntityFieldPath(
  root: MetaData,
  referrer: MetaData,
  referrerPath: string,
  verb: string,
  raw: string,
  referrerPkg: string,
  out: Diagnostic[],
): void {
  const head = headOf(raw);
  const entity = resolveEntityRef(root, head, referrerPkg);
  if (entity === undefined) return;
  const fieldName = raw.slice(head.length + 1);
  const field = fieldName !== "" ? entity.fields().find((f) => f.name === fieldName) : undefined;
  if (field !== undefined && considerTarget(referrer, referrerPath, verb, field, out)) {
    return; // the field itself is the deprecated thing — don't ALSO warn about its (fine) entity.
  }
  considerTarget(referrer, referrerPath, verb, entity, out);
}

/**
 * Walk an origin `@via` relationship path ("Entity.relOrRef[.relOrRef...]"),
 * checking the head entity and every hop it names. Stops silently the moment a
 * segment fails to resolve — a half-walked path still warned on everything it
 * DID resolve, which is the right bias for an advisory that must never crash
 * `meta verify` on a path shape it does not fully understand.
 */
function checkViaPath(
  root: MetaData,
  origin: MetaData,
  referrerPath: string,
  verb: string,
  via: string,
  referrerPkg: string,
  out: Diagnostic[],
): void {
  const segments = via.split(".");
  const headSegment = segments[0];
  if (headSegment === undefined || headSegment === "") return;
  let current = resolveEntityRef(root, headSegment, referrerPkg);
  if (current === undefined) return;
  considerTarget(origin, referrerPath, verb, current, out);
  for (const hopName of segments.slice(1)) {
    const hop = findHop(current, hopName);
    if (hop === undefined) return;
    considerTarget(origin, referrerPath, verb, hop, out);
    const targetRef = hopTargetRef(hop);
    if (targetRef === undefined) return;
    const next = resolveEntityRef(root, targetRef, packageOf(current));
    if (next === undefined) return;
    considerTarget(origin, referrerPath, verb, next, out);
    current = next;
  }
}

function checkOrigin(root: MetaData, origin: MetaData, referrerPath: string, out: Diagnostic[]): void {
  const referrerPkg = (() => {
    const owner = owningObject(origin);
    return owner !== undefined ? packageOf(owner) : "";
  })();
  const subtypeLabel = `origin.${origin.subType}`;

  // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct (the
  // same stance every origin accessor in meta-origin.ts takes).
  const from = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM);
  if (typeof from === "string" && from !== "") {
    checkEntityFieldPath(root, origin, referrerPath, `${subtypeLabel} @from references`, from, referrerPkg, out);
  }
  const of_ = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_OF);
  if (typeof of_ === "string" && of_ !== "") {
    checkEntityFieldPath(root, origin, referrerPath, `${subtypeLabel} @of references`, of_, referrerPkg, out);
  }
  const via = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_VIA);
  if (typeof via === "string" && via !== "") {
    checkViaPath(root, origin, referrerPath, `${subtypeLabel} @via references`, via, referrerPkg, out);
  }
}

function checkNode(root: MetaData, node: MetaData, path: string, out: Diagnostic[]): void {
  // extends — every node type may carry a resolved super (generic, type-agnostic).
  if (node.superData !== undefined) {
    considerTarget(node, path, "extends", node.superData, out);
  }

  // @objectRef — relationship.* (its target object) and field.object/value (a
  // value-typed field's own objectRef). Same attr name on both (naming-refs.ts).
  if (node.type === TYPE_RELATIONSHIP || node.type === TYPE_FIELD) {
    const ref = node.attr(node.type === TYPE_RELATIONSHIP ? RELATIONSHIP_ATTR_OBJECT_REF : FIELD_ATTR_OBJECT_REF);
    if (typeof ref === "string" && ref !== "") {
      const owner = owningObject(node);
      const target = resolveEntityRef(root, ref, owner !== undefined ? packageOf(owner) : "");
      if (target !== undefined) considerTarget(node, path, "references (@objectRef)", target, out);
    }
  }

  // @references — identity.reference's FK target. May be bare ("Entity",
  // defaulting to the primary identity) or dotted ("Entity.field" /
  // "Entity.fieldA,fieldB", an explicit field/compound target) — the dotted
  // field half is a deprecation-relevant target in its own right (#305 review:
  // `@references: "Team.code"` where only `code` is `@deprecated` was missed
  // when this checked the entity head alone).
  if (node.type === TYPE_IDENTITY && node.subType === IDENTITY_SUBTYPE_REFERENCE) {
    const raw = node.attr(IDENTITY_REFERENCE_ATTR_REFERENCES);
    if (typeof raw === "string" && raw !== "") {
      const owner = owningObject(node);
      checkEntityFieldPath(root, node, path, "references (@references)", raw, owner !== undefined ? packageOf(owner) : "", out);
    }
  }

  // origin.* — @from / @of / @via.
  if (node.type === TYPE_ORIGIN) {
    checkOrigin(root, node, path, out);
  }
}

/**
 * Lint the loaded model for references INTO a `deprecated` node, across every
 * reference kind the metamodel resolves: `extends`, `@objectRef`, `@references`,
 * and an origin's `@from` / `@of` / `@via`. Returns `[]` for a model with no
 * `deprecated` attr anywhere reachable from a reference (additive, opt-in).
 */
export function lintDeprecatedReferences(root: MetaData): Diagnostic[] {
  const out: Diagnostic[] = [];
  const walk = (n: MetaData, prefix: string): void => {
    for (const c of n.ownChildren()) {
      // origin carries no name of its own (always a singleton child of a field) —
      // report against the FIELD it belongs to, not a path ending in a blank segment.
      const path = c.type === TYPE_ORIGIN
        ? prefix
        : prefix === ""
          ? c.resolutionKey()
          : `${prefix}.${c.name}`;
      checkNode(root, c, path, out);
      walk(c, path);
    }
  };
  walk(root, "");
  return out;
}
