// The validation contract — the small, dependency-light types that a TypeDefinition (and
// thus a provider) carries so its types validate themselves. Kept separate from the
// implementation (loader/validation-registry.ts) so registry.ts can reference these on
// TypeDefinition without an import cycle. See
// docs/superpowers/specs/2026-06-19-metadata-validation-architecture-design.md.

import type { MetaData } from "./shared/meta-data.js";
import type { ErrorCode } from "./errors.js";

/** A loader error code. Widened to allow DOWNSTREAM providers their own codes — the core
 *  union still surfaces in editor suggestions via the `string & {}` idiom. */
export type LoaderCode = ErrorCode | (string & {});

/**
 * Declares that one attribute on a node is a cross-reference to another node. A provider
 * attaches these to its TypeDefinition; the generic resolver enforces them against the
 * symbol table — so a new reference attr validates for free, present and future.
 */
export interface ReferenceDescriptor {
  /** Attr name carrying the reference value (e.g. "objectRef", "references"). */
  readonly attr: string;
  /** Required resolved-node type (e.g. "object"). */
  readonly targetType: string;
  /** Required resolved-node subType (e.g. "value" for a payload ref), or any. */
  readonly targetSubType?: string;
  /** When true the value is `Entity.field`; resolve the entity segment (before the
   *  first ".", since packages use "::"). */
  readonly dottedFieldPath?: boolean;
  /** When true, emit a RESOLVED-source envelope (referrer = the node's fqn, target = the
   *  raw value) instead of the node's plain source. Per ref kind: payloadRef uses resolved
   *  (FR5d), objectRef/references use plain — matching each kind's existing convention. */
  readonly resolvedSource?: boolean;
  /** Code emitted on unresolved / kind-mismatch (may be a downstream code). */
  readonly errorCode: LoaderCode;
}

/** Resolve a ref string to its object node. */
export interface SymbolTable {
  resolveObject(ref: string): MetaData | undefined;
}

/** Handed to every validator: the symbol table + an error sink. */
export interface ValidationContext {
  readonly symbols: SymbolTable;
  error(code: LoaderCode, node: MetaData, message: string): void;
}

/** An imperative validator for a node of a given (type, subType), carried by its
 *  TypeDefinition — the provider that owns the type owns its validation. */
export type NodeValidator = (node: MetaData, ctx: ValidationContext) => void;
