// The validation walk — implementation of the contract in ../validation-types.ts.
//
// Validation is DERIVED FROM THE TYPE REGISTRY: each node's TypeDefinition carries its
// reference descriptors + imperative validator, so a downstream provider's type validates
// itself with no separate registry and no core changes. One recursive walk over a
// built-once symbol table: per node, apply declared references, invoke the type's
// validator, recurse. See docs/superpowers/specs/2026-06-19-metadata-validation-architecture-design.md.

import type { MetaData } from "../shared/meta-data.js";
import { ParseError } from "../errors.js";
import { refMatchesObject } from "../naming-refs.js";
import { resolvedSource } from "../source.js";
import { TYPE_OBJECT } from "../shared/base-types.js";
import type { TypeRegistry } from "../registry.js";
import type { LoaderCode, SymbolTable, ValidationContext } from "../validation-types.js";

/** A symbol table of every top-level object, built once per load (the binder analogue). */
class SymbolTableImpl implements SymbolTable {
  private readonly byRef = new Map<string, MetaData>();

  static build(root: MetaData): SymbolTableImpl {
    const t = new SymbolTableImpl();
    for (const child of root.ownChildren()) {
      if (child.type !== TYPE_OBJECT) continue;
      if (child.name) t.byRef.set(child.name, child);
      t.byRef.set(child.fqn(), child);
      t.byRef.set(child.resolutionKey(), child);
    }
    return t;
  }

  resolveObject(ref: string): MetaData | undefined {
    const hit = this.byRef.get(ref);
    if (hit) return hit;
    for (const obj of this.byRef.values()) {
      if (refMatchesObject(obj, ref)) return obj;
    }
    return undefined;
  }
}

class ValidationContextImpl implements ValidationContext {
  readonly errors: ParseError[] = [];
  constructor(readonly symbols: SymbolTable) {}
  error(code: LoaderCode, node: MetaData, message: string): void {
    this.errors.push(new ParseError(message, { code, source: node.source }));
  }

  // A cross-reference error carries a RESOLVED-source envelope (referrer = the node's fqn,
  // target = the raw ref value) — consistent across every reference kind (objectRef,
  // references, payloadRef, …), matching the FR5d convention.
  errorResolved(code: LoaderCode, node: MetaData, ref: string, message: string): void {
    this.errors.push(
      new ParseError(message, { code, source: resolvedSource(node.source, node.fqn(), ref) }),
    );
  }
}

/**
 * Run validation derived from `registry` over the tree. Per node: look up its
 * TypeDefinition, apply its declared reference descriptors (resolve against the symbol
 * table), invoke its imperative validator, then recurse into own children.
 */
export function runRegisteredValidation(root: MetaData, registry: TypeRegistry): ParseError[] {
  const ctx = new ValidationContextImpl(SymbolTableImpl.build(root));
  walk(root);
  return ctx.errors;

  function walk(node: MetaData): void {
    const def = registry.find(node.type, node.subType);
    if (def) {
      for (const desc of def.references ?? []) {
        const raw = node.ownAttr(desc.attr);
        if (typeof raw !== "string" || raw === "") continue; // absence is the required-attr pass's job
        const entityRef = desc.dottedFieldPath ? (raw.split(".")[0] ?? raw) : raw;
        const target = ctx.symbols.resolveObject(entityRef);
        const emit = (message: string): void => {
          if (desc.resolvedSource) ctx.errorResolved(desc.errorCode, node, raw, message);
          else ctx.error(desc.errorCode, node, message);
        };
        if (!target) {
          emit(
            `${node.type}.${node.subType} "${node.name}" @${desc.attr} "${raw}" does not resolve to an object.`,
          );
        } else if (
          target.type !== desc.targetType ||
          (desc.targetSubType !== undefined && target.subType !== desc.targetSubType)
        ) {
          const want = desc.targetSubType ? `${desc.targetType}.${desc.targetSubType}` : desc.targetType;
          emit(
            `${node.type}.${node.subType} "${node.name}" @${desc.attr} "${raw}" resolves to ` +
              `${target.type}.${target.subType}, not a ${want}.`,
          );
        }
      }
      def.validate?.(node, ctx);
    }
    for (const child of node.ownChildren()) walk(child);
  }
}
