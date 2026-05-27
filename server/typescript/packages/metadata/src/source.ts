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
 *  FR5b note (TS reference port, 2026-05-26): `yamlPosition` is also
 *  allowed as an OPTIONAL field on the `format: "json"` variant so that
 *  buildTree-emitted errors from a YAML input can still carry the source
 *  position without re-flagging the format discriminator. Until ALL four
 *  ports ship FR5b — at which point buildTree-emitted errors flip to
 *  `format: "yaml"` and the conformance fixtures are mass-updated — keeping
 *  the discriminator at `"json"` preserves cross-port fixture parity (the
 *  3 yaml-conformance fixtures whose buildTree-side errors are
 *  format-keyed `"json"` would otherwise diverge until C#/Java/Python
 *  catch up). See the FR5b TS implementation report. */
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
