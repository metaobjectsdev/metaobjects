// The validation walk — implementation of the contract in ../validation-types.ts.
//
// Validation is DERIVED FROM THE TYPE REGISTRY: each node's TypeDefinition carries its
// reference descriptors + imperative validator, so a downstream provider's type validates
// itself with no separate registry and no core changes. One recursive walk over a
// built-once symbol table: per node, apply declared references, invoke the type's
// validator, recurse. See docs/superpowers/specs/2026-06-19-metadata-validation-architecture-design.md.

import type { MetaData } from "../shared/meta-data.js";
import { ParseError } from "../errors.js";
import { didYouMeanHint } from "../naming-refs.js";
import { TYPE_OBJECT } from "../shared/base-types.js";
import { PACKAGE_SEPARATOR } from "../shared/structural.js";
import type { TypeRegistry } from "../registry.js";
import type { LoaderCode, SymbolTable, ValidationContext } from "../validation-types.js";

/** A symbol table of every top-level node, built once per load (the binder analogue).
 *  Indexed PER TYPE so a reference descriptor can target a non-`object` node kind (its
 *  `targetType` is a free string) and so a template and an object sharing `pkg::Name`
 *  never collide. */
class SymbolTableImpl implements SymbolTable {
  private readonly byType = new Map<string, Map<string, MetaData>>();

  static build(root: MetaData): SymbolTableImpl {
    const t = new SymbolTableImpl();
    // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
    for (const child of root.children()) {
      let bucket = t.byType.get(child.type);
      if (bucket === undefined) {
        bucket = new Map<string, MetaData>();
        t.byType.set(child.type, bucket);
      }
      // ADR-0042: key by the canonical resolution key ONLY (the FQN, or the bare
      // name for a root-level/empty-package object) — NO bare-name fallback, so a
      // bare ref never binds a same-named node in another package.
      bucket.set(child.resolutionKey(), child);
    }
    return t;
  }

  /** ADR-0042 package-local resolution within the `type` bucket: FQN → exact
   *  resolution-key match; bare → the referrer's own package (`<referrerPkg>::<ref>`),
   *  else a root-level node of that type. */
  resolve(type: string, ref: string, referrerPkg: string): MetaData | undefined {
    const bucket = this.byType.get(type);
    if (bucket === undefined) return undefined;
    if (ref.includes(PACKAGE_SEPARATOR)) return bucket.get(ref);
    const localKey = referrerPkg !== "" ? `${referrerPkg}${PACKAGE_SEPARATOR}${ref}` : ref;
    return bucket.get(localKey) ?? bucket.get(ref);
  }

  resolveObject(ref: string, referrerPkg: string): MetaData | undefined {
    return this.resolve(TYPE_OBJECT, ref, referrerPkg);
  }
}

class ValidationContextImpl implements ValidationContext {
  readonly errors: ParseError[] = [];
  constructor(readonly symbols: SymbolTable) {}
  error(code: LoaderCode, node: MetaData, message: string): void {
    this.errors.push(new ParseError(message, { code, source: node.source }));
  }
}

/**
 * Run validation derived from `registry` over the tree. Per node: look up its
 * TypeDefinition, apply its declared reference descriptors (resolve against the symbol
 * table), invoke its imperative validator, then recurse into own children.
 */
export function runRegisteredValidation(root: MetaData, registry: TypeRegistry): ParseError[] {
  const ctx = new ValidationContextImpl(SymbolTableImpl.build(root));
  walk(root, "", false);
  return ctx.errors;

  function walk(node: MetaData, referrerPkg: string, isTopLevel: boolean): void {
    // ADR-0042: a TOP-LEVEL node establishes the package context for its subtree;
    // nested ref-bearing nodes (relationship/field.object/identity.reference) resolve
    // BARE refs against it. Nested nodes carry no `package`, so they inherit the
    // enclosing object's (via fileDefaultPackage, else the threaded context). A
    // top-level node of ANY type sets the context — including a provider's custom
    // top-level type — so a non-object top-level ref-bearing node resolves its bare
    // refs in its own package, not at root level (#194 item 2). Objects still set
    // context whether top-level or nested; behavior for every pre-existing case is
    // unchanged (a nested non-object still inherits the threaded context).
    const pkg =
      isTopLevel || node.type === TYPE_OBJECT
        ? (node.package ?? node.fileDefaultPackage ?? referrerPkg)
        : referrerPkg;
    const def = registry.find(node.type, node.subType);
    if (def) {
      for (const desc of def.references ?? []) {
        // ADR-0039: resolving — a reference attr (e.g. @objectRef/@through) may be
        // inherited via extends; read the effective value.
        const raw = node.attr(desc.attr);
        if (typeof raw !== "string" || raw === "") continue; // absence is the required-attr pass's job
        const entityRef = desc.dottedFieldPath ? (raw.split(".")[0] ?? raw) : raw;
        const target = ctx.symbols.resolve(desc.targetType, entityRef, pkg);
        // Qualify the node name with its owning entity (e.g. "Order.items") so the error is
        // locatable from the message alone, not just the source envelope.
        const qname = node.parent?.name ? `${node.parent.name}.${node.name}` : node.name;
        if (!target) {
          // `did-you-mean` is object-scoped (its candidate scan is over objects), so only
          // append it for object targets; a non-object target names its own kind.
          const wantKind = desc.targetType === TYPE_OBJECT ? "an object" : `a ${desc.targetType}`;
          const hint = desc.targetType === TYPE_OBJECT ? didYouMeanHint(root, entityRef) : "";
          ctx.error(
            desc.errorCode,
            node,
            `${node.type}.${node.subType} "${qname}" @${desc.attr} "${raw}" does not resolve to ${wantKind}.${hint}`,
          );
        } else if (desc.targetSubType !== undefined && target.subType !== desc.targetSubType) {
          // `resolve` already guarantees target.type === desc.targetType; only the
          // subType can still mismatch.
          const want = `${desc.targetType}.${desc.targetSubType}`;
          ctx.error(
            desc.errorCode,
            node,
            `${node.type}.${node.subType} "${qname}" @${desc.attr} "${raw}" resolves to ` +
              `${target.type}.${target.subType}, not a ${want}.`,
          );
        }
      }
      def.validate?.(node, ctx);
    }
    // ADR-0039: own — structural walk visiting every physical node once at its
    // declaration site (an inherited child is validated on its declaring parent).
    // The root's own children ARE the top-level nodes (each sets its own package
    // context); everything deeper is nested.
    const childrenAreTopLevel = node === root;
    for (const child of node.ownChildren()) walk(child, pkg, childrenAreTopLevel);
  }
}
