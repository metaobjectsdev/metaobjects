// super reference resolution (ADR-0059)
//
// An `extends` ref resolves through the same rules as every other reference
// (`ownerCandidateKeys`, naming-refs.ts): `::Rest` root-absolute, `..::Rest`
// parent-relative, `pkg::Name` exact, bare `Name` in the declaring node's own
// file package, then root-level — never another package. The package context is
// the declaring node's effective package (`package ?? fileDefaultPackage`).
//
// FR-024: a ref whose final `::`-segment is dotted (`pkg::Customer.id`) targets
// a child nested in the owner object — resolved type-scoped to the referrer.
//
// Super resolution is deferred by the loader (`resolveDeferredSupers`); the parser
// calls `resolveSuperRef` inline only when deferral is off.

import type { MetaData } from "./shared/meta-data.js";
import { PACKAGE_SEPARATOR, CHILD_REF_SEPARATOR } from "./shared/structural.js";
import { ownerCandidateKeys, RefOverDropError } from "./naming-refs.js";
import { TYPE_IDENTITY } from "./shared/base-types.js";
import { IDENTITY_UNIQUE_KEY_SUBTYPES } from "./core/identity/identity-constants.js";

// ---------------------------------------------------------------------------
// Tree search helper
// ---------------------------------------------------------------------------

/**
 * The top-level node (a direct child of `root`) whose resolution key is exactly
 * `key` — `<package | fileDefaultPackage>::<name>`, or the bare name for a
 * root-level node. The key is captured at parse time, so the match does not depend
 * on load order or on post-merge tree shape. Exact only: a bare key never matches a
 * packaged node (ADR-0059 R2).
 */
function findTopLevel(root: MetaData, key: string): MetaData | undefined {
  // ADR-0039: own — super-resolution reads the PHYSICAL declaration layer; the root
  // has no super, so its own children are its children.
  return root.ownChildren().find((c) => c.name !== "" && c.resolutionKey() === key);
}

// ---------------------------------------------------------------------------
// Reference parsing & resolution
// ---------------------------------------------------------------------------

/**
 * FR-024 (ADR-0029): the type-scope of the node whose `extends` is being
 * resolved. A dotted `Entity.child` ref selects among the owner's children of
 * the SAME type as the referrer — a field ref resolves fields, an identity
 * ref resolves identities. Required for the dotted branch; ignored for
 * dot-free refs (legacy behavior unchanged).
 */
export interface ReferrerScope {
  readonly type: string;
}

/**
 * FR-024: true when a ref's final `::`-segment contains a `.` — i.e. the ref
 * targets a child nested inside an object (`Customer.id`,
 * `acme::sales::Customer.id`). Names cannot contain `.`, so this is
 * unambiguous. Call sites use this to apply the dotted-only
 * type/subtype-mismatch check (ERR_EXTENDS_TARGET_MISMATCH) without altering
 * shipped top-level extends behavior.
 */
export function isChildTargetingRef(ref: string): boolean {
  const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const lastSegment = lastSep === -1 ? ref : ref.slice(lastSep + PACKAGE_SEPARATOR.length);
  return lastSegment.includes(CHILD_REF_SEPARATOR);
}

/**
 * Whether a dotted `extends` target is acceptable for the extending node.
 *
 * Type must match exactly. Subtype must match too — with ONE exception, on identities
 * (#310). For an identity, subtype equality was answering the wrong question: it read as
 * "the same kind of thing", but ADR-0040 encodes uniqueness in the TYPE, so `primary` and
 * `secondary` are both UNIQUE KEYS and differ only in which one the entity nominated as
 * its main handle. Borrowing a key borrows uniqueness, not that nomination — so a read
 * model may key off a business key the entity models as `identity.secondary` while never
 * surfacing its surrogate `identity.primary` at all.
 *
 * The gate was never written for identities in the first place: its only conformance
 * fixture is `error-extends-entity-field-type-mismatch`, a `field.uuid` extending a
 * `field.string`. For a FIELD, subtype IS the datatype and inheriting across it is
 * incoherent; for an identity, subtype is a ROLE. A field-shape rule was generalized onto
 * a role axis without a fixture ever exercising it.
 *
 * `identity.reference` is excluded on both sides: a foreign key is not unique, so it can
 * never back a borrowed key — and a set-membership test says that once, rather than
 * enumerating the legal pairs.
 *
 * EXPORTED because there are two doors: this module's deferred resolution and
 * `parser-core`'s eager check. They had independent copies of the boolean, so a change to
 * one silently left the other enforcing the old rule on whichever path a given loader
 * configuration takes.
 */
export function extendsTargetCompatible(node: MetaData, target: MetaData): boolean {
  if (target.type !== node.type) return false;
  if (target.subType === node.subType) return true;
  return (
    node.type === TYPE_IDENTITY &&
    IDENTITY_UNIQUE_KEY_SUBTYPES.includes(node.subType) &&
    IDENTITY_UNIQUE_KEY_SUBTYPES.includes(target.subType)
  );
}

/**
 * The one wording for `ERR_EXTENDS_TARGET_MISMATCH`, shared by both doors and mirrored in
 * the other three ports. States the exception, so an author who hits it on a `field` is
 * not left wondering why their identity case was allowed.
 */
export const EXTENDS_TARGET_MISMATCH_RULE =
  "a dotted extends must target a node of the same type and subtype — the one exception " +
  "is an identity, which may extend any UNIQUE key (identity.primary or identity.secondary)";

/**
 * FR-024: split a child-targeting ref into the owner-object ref and the child
 * traversal path. A multi-dot ref (`X.y.z`) traverses child names to any depth
 * (object → field → view); returns undefined only for degenerate empty parts
 * (`.id`, `Customer.`, `Customer..x`).
 */
function parseChildTargetingRef(
  ref: string,
): { ownerRef: string; path: readonly string[] } | undefined {
  const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const lastSegment = ref.slice(segStart);
  const parts = lastSegment.split(CHILD_REF_SEPARATOR);
  if (parts.length < 2 || parts.some((p) => p === "")) return undefined;
  return {
    ownerRef: ref.slice(0, segStart) + parts[0],
    path: parts.slice(1),
  };
}

/**
 * Resolve a single super reference string against a tree.
 *
 * Called by the parser IMMEDIATELY when a node with a `super` key is created,
 * against the loader's accumulating root (intoRoot). Java semantics: if the
 * ref cannot be resolved, the parser throws ParseError.
 *
 * FR-024 (ADR-0029): a ref whose final segment is dotted (`Customer.id`)
 * targets a child nested inside an object. The owner part resolves with the
 * existing strategies (absolute / relative / bare / same-package); the child
 * is then selected among the owner's EFFECTIVE children (so inherited
 * children resolve) by name AND the referrer's type (type-scoped). A dotted
 * ref that does not resolve returns undefined WITHOUT falling through to the
 * bare lookup; a dotted ref with no `referrerScope` is unresolvable.
 *
 * @param ref - The raw super reference (e.g., "Fruit", "::pkg::Name", "..::common::id", "Customer.id")
 * @throws RefOverDropError when a `..::` ref drops more segments than the package has
 * @param contextPackage - The package of the model whose super is being resolved
 * @param root - The root MetaData of the accumulating tree to search within
 * @param referrerScope - FR-024: the extending node's type — required to resolve dotted refs
 * @returns The resolved MetaData, or undefined if the reference cannot be resolved
 */
export function resolveSuperRef(
  ref: string,
  contextPackage: string,
  root: MetaData,
  referrerScope?: ReferrerScope,
): MetaData | undefined {
  // -------------------------------------------------------------------------
  // 0. FR-024 dotted child-targeting ref: `<rootRef>.<child>...<child>`
  //
  // Addressing model (ADR-0029): the package qualifies the ROOT-level node
  // only; each subsequent segment traverses CHILD NAMES, to any depth
  // (object → field → view: `Customer.priceCents.display`). INTERMEDIATE
  // segments select by unique name among the current node's effective
  // children (a cross-type name collision, e.g. a field AND an identity both
  // named "id", is ambiguous → unresolved); the FINAL segment is type-scoped
  // to the referrer (a field ref resolves fields, a view ref views), which is
  // also what disambiguates the common 2-segment `Customer.id` case.
  // -------------------------------------------------------------------------
  if (isChildTargetingRef(ref)) {
    if (referrerScope === undefined) return undefined;
    const parsed = parseChildTargetingRef(ref);
    if (parsed === undefined) return undefined; // degenerate (empty segment)
    let current: MetaData | undefined = resolveSuperRef(parsed.ownerRef, contextPackage, root);
    if (current === undefined) return undefined;
    for (let i = 0; i < parsed.path.length - 1; i++) {
      const seg = parsed.path[i]!;
      const matches: MetaData[] = current.children().filter((c) => c.name === seg);
      if (matches.length !== 1) return undefined; // missing or ambiguous intermediate
      current = matches[0]!;
    }
    const last = parsed.path[parsed.path.length - 1]!;
    return current
      .children()
      .find((c) => c.name === last && c.type === referrerScope.type);
  }
  // -------------------------------------------------------------------------
  // 1. A plain ref binds one top-level node by its form (ADR-0059 R2). An
  //    over-dropping `..::` throws RefOverDropError; the deferred pass reports it.
  // -------------------------------------------------------------------------
  for (const key of ownerCandidateKeys(ref, contextPackage)) {
    const found = findTopLevel(root, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Deferred resolution — second pass after all files parsed
// ---------------------------------------------------------------------------

export interface DeferredSuperFailure {
  /** FQN of the node whose super ref could not be resolved. */
  nodeFqn: string;
  /** The raw super ref string that didn't resolve. */
  ref: string;
  /** ADR-0009 provenance envelope of the referencing node (FR5a). */
  source: import("./source.js").ErrorSource;
  /**
   * FR-024: why resolution failed.
   * - "unresolved" — no target found (loader emits ERR_UNRESOLVED_SUPER).
   * - "target-mismatch" — a dotted child-targeting ref resolved, but the
   *   target's type/subtype differs from the extending node's (loader emits
   *   ERR_EXTENDS_TARGET_MISMATCH). Applies ONLY to dotted refs — top-level
   *   extends behavior is unchanged.
   * - "over-drop" — a `..::` ref drops more package segments than the declaring
   *   node's package has (ADR-0059 R2; loader emits ERR_BAD_ATTR_VALUE).
   */
  kind: "unresolved" | "target-mismatch" | "over-drop";
  /** target-mismatch only: the resolved target's identity, for the message. */
  target?: { type: string; subType: string };
  /** target-mismatch only: the extending node's type/subtype, for the message. */
  referrer?: { type: string; subType: string };
}

/**
 * Walk the tree and resolve every node's superRef against the full root.
 * Used by Loader.loadJsonStrings as a second pass after all input files
 * have been parsed with deferSuperResolution: true. Unresolved refs are
 * collected and returned — caller decides whether to throw or warn.
 *
 * The referrer's context package (for bare/same-package shorthand refs) comes
 * from the node's own `package`, else the file-default package captured at
 * PARSE time (`fileDefaultPackage`). Both are order- and merge-independent, so
 * resolution does not depend on the post-merge tree shape.
 *
 * Idempotent: nodes that already have superResolved set are skipped.
 */
export function resolveDeferredSupers(root: MetaData): DeferredSuperFailure[] {
  const failures: DeferredSuperFailure[] = [];
  // #188: super-resolution must be ORDER-INDEPENDENT. A pre-order walk resolved
  // each node's superRef in physical-declaration (= load) order, so a dotted
  // ref to an INHERITED member (`extends: Owner.member` where Owner inherits
  // `member` via its own `extends`) only succeeded when the owner's extends
  // chain happened to be wired first — green under Node's readdir order,
  // ERR_UNRESOLVED_SUPER under Bun's. Instead resolve ON DEMAND with
  // memoization + cycle detection: before a dotted ref reads `owner.children()`
  // (effective children — inherited members appear only once the owner's OWN
  // super is resolved), resolve the owner's whole chain first. The result is a
  // pure function of the source SET, independent of enumeration order.
  // Nodes already attempted this pass. Because resolution is now on-demand, a
  // node can be reached both by the `pending` loop AND by owner/target
  // recursion from another node — `attempted` makes each node resolve (and, on
  // failure, report) EXACTLY ONCE, restoring the old single-visit walk's
  // no-duplicate-failures guarantee (a successful node is already deduped by
  // `superResolved`; this also covers the FAILURE path, which sets no marker).
  // It is also the cycle guard: `attempted` is never removed, so a genuine
  // super cycle (A→B→A) terminates on re-entry to the already-attempted node
  // rather than recursing forever.
  const attempted = new Set<MetaData>();
  // Every node carrying a superRef, over the PHYSICAL declaration tree.
  const pending: MetaData[] = [];
  walk(root, (n) => {
    if (n.superRef !== undefined) pending.push(n);
  });

  // ADR-0059 R2: an over-dropping `..::` is a bad value, not a missing target.
  const tryResolve = (
    ref: string,
    pkg: string,
    scope?: ReferrerScope,
  ): MetaData | undefined | "over-drop" => {
    try {
      return resolveSuperRef(ref, pkg, root, scope);
    } catch (e) {
      if (e instanceof RefOverDropError) return "over-drop";
      throw e;
    }
  };

  const resolveNode = (node: MetaData): void => {
    if (node.superRef === undefined || node.superResolved !== undefined) return;
    if (attempted.has(node)) return; // already resolved-or-failed this pass — never re-report
    attempted.add(node);
    const effectivePkg = node.package ?? node.fileDefaultPackage ?? "";

    // For a dotted child-targeting ref, `resolveSuperRef` reads the OWNER's
    // effective `children()` — which only includes inherited members once the
    // owner's own extends chain is resolved. So resolve the owner node's chain
    // FIRST (memoized), regardless of load order.
    if (isChildTargetingRef(node.superRef)) {
      const parsed = parseChildTargetingRef(node.superRef);
      if (parsed !== undefined) {
        const ownerNode = tryResolve(parsed.ownerRef, effectivePkg);
        if (ownerNode !== undefined && ownerNode !== "over-drop") resolveNode(ownerNode);
      }
    }

    // FR-024: thread the referrer's type so dotted `Entity.child` refs resolve
    // type-scoped (a field ref selects fields; an identity ref identities).
    const target = tryResolve(node.superRef, effectivePkg, { type: node.type });

    if (target === "over-drop") {
      failures.push({ nodeFqn: node.fqn(), ref: node.superRef, source: node.source, kind: "over-drop" });
      return;
    }
    if (target !== undefined) {
      // FR-024: a dotted ref must target a node of the SAME type and subtype
      // as the extending node. Dotted-only — top-level extends is unchanged.
      //
      // #310 — with ONE exception, on identities. Subtype equality here was standing in
      // for "the target is the same kind of thing", and for identities that is the wrong
      // question: ADR-0040 put uniqueness in the TYPE, so `identity.primary` and
      // `identity.secondary` are both UNIQUE KEYS and differ only in which one the entity
      // nominated as its main handle. A projection borrowing a key is borrowing
      // uniqueness, not that nomination — so a read model may key off a business key the
      // entity models as `identity.secondary` while never surfacing its surrogate
      // `identity.primary` at all, which is the shape that was foreclosed.
      //
      // `identity.reference` stays out: an FK is not unique, so it can never back a key.
      if (
        isChildTargetingRef(node.superRef) &&
        !extendsTargetCompatible(node, target)
      ) {
        failures.push({
          nodeFqn: node.fqn(),
          ref: node.superRef,
          source: node.source,
          kind: "target-mismatch",
          target: { type: target.type, subType: target.subType },
          referrer: { type: node.type, subType: node.subType },
        });
        return;
      }
      try {
        node.setSuperResolved(target);
      } catch {
        // Frozen — ignore; the loader should resolve before freeze.
      }
      // Ensure the target's OWN chain is resolved too, so a later `children()`
      // read on `node` (codegen/validation) sees the full multi-level inherited
      // set (e.g. Base extends AbstractRoot). Memoized — no re-work.
      resolveNode(target);
    } else {
      failures.push({
        nodeFqn: node.fqn(),
        ref: node.superRef,
        source: node.source,
        kind: "unresolved",
      });
    }
  };

  for (const node of pending) resolveNode(node);
  return failures;
}

function walk(node: MetaData, visit: (n: MetaData) => void): void {
  visit(node);
  // ADR-0039: own — super-resolution walk over the PHYSICAL declaration tree.
  for (const child of node.ownChildren()) {
    walk(child, visit);
  }
}
