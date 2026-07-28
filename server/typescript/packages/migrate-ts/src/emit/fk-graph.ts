import type { SchemaSnapshot } from "../types.js";

/**
 * Pure, I/O-free graph core the D1 FK-cascade emitter orders rebuilds by. Edges
 * point child→parent (a table → the table(s) its foreign keys reference),
 * self-loops included for a self-referential table.
 */

/** Builds child→parent FK edges from a schema. Self-loops included. */
export function buildFkEdges(schema: SchemaSnapshot): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const t of schema.tables) {
    const parents = new Set<string>();
    for (const fk of t.foreignKeys) {
      parents.add(fk.refTable);
    }
    edges.set(t.name, parents);
  }
  return edges;
}

/** Merges two edge maps into a new one; neither input is mutated. */
export function unionEdges(
  a: Map<string, Set<string>>,
  b: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>();
  for (const [node, parents] of a) {
    merged.set(node, new Set(parents));
  }
  for (const [node, parents] of b) {
    const existing = merged.get(node);
    if (existing) {
      for (const p of parents) existing.add(p);
    } else {
      merged.set(node, new Set(parents));
    }
  }
  return merged;
}

/**
 * `recreated` plus every transitive *referrer* — walk edges backwards: any
 * table with an edge into the current set (i.e. it references a member of the
 * set) joins the set, repeated to a fixpoint.
 */
export function affectedSet(
  recreated: ReadonlySet<string>,
  edges: Map<string, Set<string>>,
): Set<string> {
  const affected = new Set<string>(recreated);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, parents] of edges) {
      if (affected.has(node)) continue;
      for (const p of parents) {
        if (affected.has(p)) {
          affected.add(node);
          changed = true;
          break;
        }
      }
    }
  }
  return affected;
}

/**
 * Kahn's algorithm over `nodes`, treating an edge `child→parent` as "parent
 * must come before child". Self-loops (`x→x`) and edges whose target is not
 * in `nodes` are dropped before ordering. `order` is parents-first. If nodes
 * remain when the queue empties, the sort cannot complete — those remaining
 * nodes (a multi-node cycle) are returned as `cycle` instead.
 */
export function topoOrder(
  nodes: Set<string>,
  edges: Map<string, Set<string>>,
): { order: string[]; cycle: string[] | null } {
  // childOf(parent) = children within `nodes` that must be emitted after `parent`.
  const childrenOf = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    childrenOf.set(n, new Set());
    inDegree.set(n, 0);
  }
  for (const n of nodes) {
    const parents = edges.get(n) ?? new Set<string>();
    for (const p of parents) {
      if (p === n) continue; // drop self-loop
      if (!nodes.has(p)) continue; // drop edge leaving `nodes`
      const kids = childrenOf.get(p);
      if (kids === undefined) continue;
      if (kids.has(n)) continue; // already recorded (dedupe parallel edges)
      kids.add(n);
      inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
    }
  }

  // Stable order: iterate `nodes` in insertion order for the initial queue.
  const queue: string[] = [];
  for (const n of nodes) {
    if (inDegree.get(n) === 0) queue.push(n);
  }

  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const n = queue[head++];
    if (n === undefined) continue;
    order.push(n);
    for (const child of childrenOf.get(n) ?? []) {
      const remaining = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }

  if (order.length < nodes.size) {
    const remaining = [...nodes].filter((n) => !order.includes(n));
    return { order: [], cycle: remaining };
  }

  return { order, cycle: null };
}
