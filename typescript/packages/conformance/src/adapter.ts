// The ConformanceAdapter interface — each language port implements this once.
// The neutral runner engine (Task 7) drives a port entirely through it.

import type { NormalizedResult } from "./result.js";

/** A port's opaque tree-node handle. The engine never inspects it directly. */
export type NodeHandle = unknown;

/** A port's opaque resolved-tree handle. */
export type TreeHandle = unknown;

export interface LoadOutcome {
  /** The resolved tree, or undefined when the load failed outright. */
  readonly tree?: TreeHandle;
  /** Normalized error codes the load produced (empty on success). */
  readonly errorCodes: string[];
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
