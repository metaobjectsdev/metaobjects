// The ConformanceAdapter interface — each language port implements this once.
// The neutral runner engine (Task 7) drives a port entirely through it.

import type { NormalizedResult } from "./result.js";

/** A port's opaque tree-node handle. The engine never inspects it directly. */
export type NodeHandle = unknown;

/** A port's opaque resolved-tree handle. */
export type TreeHandle = unknown;

/**
 * Cross-port envelope shape produced by the loader for each error / warning
 * (ADR-0009). The neutral runner asserts the minimum cross-port fields
 * (`code` + `source.format` + `source.files` + `source.jsonPath`).
 * Ports may carry additional T2 fields (`suggestions`, `fixture`, `node`,
 * `yamlPosition`); those are not asserted by the cross-port harness.
 *
 * FR5d — for `source.format === "resolved"` envelopes, two additional fields
 * are part of the cross-port contract and asserted by the runner:
 *   - `referrer` — bare (short) name of the declaring node carrying the
 *     broken reference (e.g. `Premium`, `npcTurn`, `ProgramSummary::weekCount`).
 *   - `target`   — the unresolved reference string itself (e.g. `DoesNotExist`,
 *     `Program.notARealRelationship`).
 */
export interface ErrorEnvelopeRecord {
  readonly code: string;
  readonly source: {
    readonly format: string;
    readonly files: readonly string[];
    readonly jsonPath?: string;
    readonly referrer?: string;
    readonly target?: string;
  };
}

export interface LoadOutcome {
  /** The resolved tree, or undefined when the load failed outright. */
  readonly tree?: TreeHandle;
  /** Normalized error codes the load produced (empty on success). */
  readonly errorCodes: string[];
  /** Warning messages the load produced (empty on success). */
  readonly warnings: string[];
  /**
   * Full error envelopes (FR5a / ADR-0009). Optional for backward compat
   * with adapters that have not yet been extended; when present, the runner
   * asserts envelope fields against the post-migration expected-errors.json
   * shape. When absent, the runner falls back to code-set comparison only.
   */
  readonly errors?: readonly ErrorEnvelopeRecord[];
  /**
   * Full warning envelopes (FR5c-finalize). Same shape as `errors` —
   * `{ code, source: { format, files, jsonPath?, contributors? } }`. When
   * present AND the fixture's expected-errors.json declares envelope-shape
   * warnings, the runner asserts per-warning envelope alignment (mirrors the
   * error-side assertion). When absent, the runner falls back to comparing
   * `warnings` as a flat string list against expected-warnings.json.
   */
  readonly warningEnvelopes?: readonly ErrorEnvelopeRecord[];
}

export interface ConformanceAdapter {
  /** The port's language id (e.g. "typescript"). */
  readonly language: string;

  /** Load a fixture's input/ directory against the named providers. */
  loadFixture(inputDir: string, providers: readonly string[]): Promise<LoadOutcome>;

  /** Canonical-serialize the whole resolved tree. */
  canonicalSerialize(tree: TreeHandle): string;

  /** Canonical-serialize the whole effective (super-chain-merged) tree. */
  canonicalSerializeEffective(tree: TreeHandle): string;

  /** Resolve a navigate path to a node; undefined if the path does not resolve. */
  navigate(tree: TreeHandle, path: readonly string[]): NodeHandle | undefined;

  /**
   * Invoke a capability-id on a node and normalize the result.
   * Throws `UnknownCapabilityError` if the binding has no entry for the id.
   */
  invoke(
    node: NodeHandle,
    capabilityId: string,
    args: Record<string, string | number | boolean>,
  ): NormalizedResult;
}

/** Thrown by `invoke` when the binding lacks the capability-id — a parity gap. */
export class UnknownCapabilityError extends Error {
  constructor(public readonly capabilityId: string) {
    super(`No binding for capability '${capabilityId}'`);
  }
}
