// Phase 2 prototype — a normalized, provider-extensible validation mechanism.
//
// One model for every port (this is the TS reference):
//   * a SYMBOL TABLE built once from the loaded tree,
//   * DECLARATIVE reference descriptors (an attr declares what it points at) resolved by
//     a single generic resolver, and
//   * IMPERATIVE node validators registered per (type, subType) by the provider that owns
//     the type — invoked by one recursive root.validate(ctx) walk.
//
// Because both descriptors and validators are REGISTERED (not hardcoded in the loader), a
// downstream provider that adds a new type can validate it without forking core. See
// docs/superpowers/specs/2026-06-19-metadata-validation-architecture-design.md.

import type { MetaData } from "../shared/meta-data.js";
import { ParseError, type ErrorCode } from "../errors.js";
import { refMatchesObject } from "../naming-refs.js";
import { TYPE_OBJECT, TYPE_RELATIONSHIP, TYPE_IDENTITY } from "../shared/base-types.js";
import { RELATIONSHIP_ATTR_OBJECT_REF } from "../core/relationship/relationship-constants.js";
import {
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
} from "../core/identity/identity-constants.js";

/** Wildcard subType — a descriptor/validator registered under it applies to every subType
 *  of the type (e.g. @objectRef lives on every relationship.* subtype). */
export const SUBTYPE_ANY = "*";

/** A symbol table of every top-level object, built once per load. The compiler-binder
 *  analogue: name resolution reads this instead of re-scanning the tree per reference. */
export class SymbolTable {
  private readonly byRef = new Map<string, MetaData>();

  static build(root: MetaData): SymbolTable {
    const t = new SymbolTable();
    for (const child of root.ownChildren()) {
      if (child.type !== TYPE_OBJECT) continue;
      // Index under bare name, fqn, and package-folded resolutionKey so a ref FQN-matches
      // regardless of which canonical form it carries (matches refMatchesObject).
      if (child.name) t.byRef.set(child.name, child);
      t.byRef.set(child.fqn(), child);
      t.byRef.set(child.resolutionKey(), child);
    }
    return t;
  }

  /** Resolve a ref to its object, or undefined. */
  resolveObject(ref: string): MetaData | undefined {
    const hit = this.byRef.get(ref);
    if (hit) return hit;
    // Fallback to the full matcher for any form the Map keys missed.
    for (const obj of this.byRef.values()) {
      if (refMatchesObject(obj, ref)) return obj;
    }
    return undefined;
  }
}

/** The context handed to every validator: the symbol table + an error sink. */
export class ValidationContext {
  readonly errors: ParseError[] = [];
  constructor(readonly symbols: SymbolTable) {}

  // `code` is widened to string so a DOWNSTREAM provider can emit its own error codes
  // (the core ErrorCode union is closed; the envelope treats codes as strings). The
  // cast is the one acknowledged seam — Phase 3 widens ParseError.code itself.
  error(code: ErrorCode | string, node: MetaData, message: string): void {
    this.errors.push(new ParseError(message, { code: code as ErrorCode, source: node.source }));
  }
}

/** Declares that an attribute on a node is a cross-reference to another node. Data-driven —
 *  a provider attaches one of these to an attr and the generic resolver enforces it. */
export interface ReferenceDescriptor {
  /** The attr name carrying the reference value (e.g. "objectRef", "references"). */
  readonly attr: string;
  /** Required target type (e.g. "object"); the resolved node's type must equal it. */
  readonly targetType: string;
  /** Optional required target subType (e.g. "value" for a payload ref). */
  readonly targetSubType?: string;
  /** When true, the value is `Entity.field`/`Entity.a,b`; resolve the entity segment
   *  (before the first ".", since packages use "::" not "."). */
  readonly dottedFieldPath?: boolean;
  /** Error code emitted when the target does not resolve / kind-mismatches. A downstream
   *  provider may use its own (non-core) code string. */
  readonly errorCode: ErrorCode | string;
}

/** An imperative validator for a node of a given (type, subType). */
export type NodeValidator = (node: MetaData, ctx: ValidationContext) => void;

/** The registry a provider contributes reference descriptors + validators to — keyed by
 *  "type.subType" (or "type.*" for all subtypes). Injected into the loader like the
 *  TypeRegistry, so a downstream provider extends validation without touching core. */
export class ValidationRegistry {
  private readonly refs = new Map<string, ReferenceDescriptor[]>();
  private readonly validators = new Map<string, NodeValidator[]>();

  private static key(type: string, subType: string): string {
    return `${type}.${subType}`;
  }

  registerReference(type: string, subType: string, desc: ReferenceDescriptor): this {
    const k = ValidationRegistry.key(type, subType);
    (this.refs.get(k) ?? this.refs.set(k, []).get(k)!).push(desc);
    return this;
  }

  registerValidator(type: string, subType: string, fn: NodeValidator): this {
    const k = ValidationRegistry.key(type, subType);
    (this.validators.get(k) ?? this.validators.set(k, []).get(k)!).push(fn);
    return this;
  }

  /** Descriptors for a node: those registered for its exact (type, subType) PLUS (type, *). */
  referencesFor(type: string, subType: string): ReferenceDescriptor[] {
    return [
      ...(this.refs.get(ValidationRegistry.key(type, SUBTYPE_ANY)) ?? []),
      ...(this.refs.get(ValidationRegistry.key(type, subType)) ?? []),
    ];
  }

  validatorsFor(type: string, subType: string): NodeValidator[] {
    return [
      ...(this.validators.get(ValidationRegistry.key(type, SUBTYPE_ANY)) ?? []),
      ...(this.validators.get(ValidationRegistry.key(type, subType)) ?? []),
    ];
  }
}

/**
 * The single recursive walk. Per node: apply declared reference descriptors (generic
 * resolution against the symbol table), then invoke registered imperative validators, then
 * recurse into own children. This is `root.validate(ctx)` — the logic lives in the
 * registered rules, not on the node classes.
 */
export function runRegisteredValidation(root: MetaData, registry: ValidationRegistry): ParseError[] {
  const ctx = new ValidationContext(SymbolTable.build(root));
  walk(root);
  return ctx.errors;

  function walk(node: MetaData): void {
    for (const desc of registry.referencesFor(node.type, node.subType)) {
      const raw = node.ownAttr(desc.attr);
      if (typeof raw !== "string" || raw === "") continue; // absence is the required-attr pass's job
      const entityRef = desc.dottedFieldPath ? raw.split(".")[0] : raw;
      const target = ctx.symbols.resolveObject(entityRef);
      if (!target) {
        ctx.error(
          desc.errorCode,
          node,
          `${node.type}.${node.subType} "${node.name}" @${desc.attr} "${raw}" does not resolve to an object.`,
        );
      } else if (target.type !== desc.targetType ||
                 (desc.targetSubType !== undefined && target.subType !== desc.targetSubType)) {
        const want = desc.targetSubType ? `${desc.targetType}.${desc.targetSubType}` : desc.targetType;
        ctx.error(
          desc.errorCode,
          node,
          `${node.type}.${node.subType} "${node.name}" @${desc.attr} "${raw}" resolves to ` +
            `${target.type}.${target.subType}, not a ${want}.`,
        );
      }
    }
    for (const fn of registry.validatorsFor(node.type, node.subType)) fn(node, ctx);
    for (const child of node.ownChildren()) walk(child);
  }
}

/**
 * The core providers' reference descriptors — the built-in cross-references, now declared
 * as data instead of hand-coded passes. (Production wires these through the
 * MetaDataTypeProvider SPI; the prototype seeds them here.)
 */
export function defaultValidationRegistry(): ValidationRegistry {
  return new ValidationRegistry()
    .registerReference(TYPE_RELATIONSHIP, SUBTYPE_ANY, {
      attr: RELATIONSHIP_ATTR_OBJECT_REF,
      targetType: TYPE_OBJECT,
      errorCode: "ERR_INVALID_RELATIONSHIP",
    })
    .registerReference(TYPE_IDENTITY, IDENTITY_SUBTYPE_REFERENCE, {
      attr: IDENTITY_REFERENCE_ATTR_REFERENCES,
      targetType: TYPE_OBJECT,
      dottedFieldPath: true,
      errorCode: "ERR_INVALID_REFERENCE",
    });
}
