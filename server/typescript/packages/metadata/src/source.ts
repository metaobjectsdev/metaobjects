// server/typescript/packages/metadata/src/source.ts
//
// FR5a — Loader error envelope + source-on-node (ADR-0009).
//
// Cross-port-aligned types: every metaobjects port emits the same envelope
// shape so a tool consuming errors from multiple language ports can compare
// them byte-identically.

/** Discriminated union over the provenance variants a metadata node or error
 *  can carry. See ADR-0009 §Decision for the canonical shape.
 *
 *  FR5b note (finalized 2026-05-27, all four ports): buildTree-emitted errors
 *  from a YAML input emit `format: "yaml"` and carry the optional
 *  `yamlPosition` (line/col from the desugar's position map). The
 *  `yamlPosition` field is also declared optionally on the `format: "json"`
 *  variant for backward shape-compat with any FR5b-interim envelopes still
 *  serialized to disk; new YAML errors no longer use that variant. */
export type ErrorSource =
  | { format: "json"; files: [string]; jsonPath: string;
      yamlPosition?: { line: number; col: number } }
  | { format: "yaml"; files: [string]; jsonPath: string;
      yamlPosition?: { line: number; col: number } }
  | { format: "merged"; files: string[]; jsonPath: string;
      contributors: Contributor[] }
  | { format: "resolved"; files: string[]; jsonPath?: string;
      referrer?: string; target?: string }
  | { format: "database"; dbLocation: { table: string; id: string };
      jsonPath?: string }
  | { format: "code"; caller?: string };

export interface Contributor {
  file: string;
  role: "overlay-base" | "overlay-extension" | "extends-base" | "extends-extension";
}

export interface NodeContext {
  type?: string;
  subtype?: string;
  name?: string;
  fqn?: string;
}

/** Envelope shape every loader error conforms to. */
export interface LoaderError {
  // REQUIRED — conformance-enforced.
  code: string;
  message: string;
  source: ErrorSource;
  // RECOMMENDED — optional per ADR-0009 §What ports are NOT required to do.
  suggestions?: string[];
  fixture?: string;
  node?: NodeContext;
}

/** Warning envelope — same shape as LoaderError but a `WARN_*` code. */
export interface LoaderWarning {
  code: string;
  message: string;
  source: ErrorSource;
  suggestions?: string[];
  fixture?: string;
  node?: NodeContext;
}

/** Canonical synthetic envelope for programmatic / test-constructed nodes.
 *  `caller` is an optional human label (e.g. "QueriesTest.makePost"). */
export function codeSource(caller?: string): ErrorSource {
  return caller ? { format: "code", caller } : { format: "code" };
}
