// A per-node lookup index over a root's direct children (the top-level nodes).
//
// Reference resolution, `extends` resolution and overlay targeting all ask "which top-level
// node has this key?" once per reference. Answering by scanning the child list and building
// each candidate's key is O(N) per question and O(N²) per model; this answers from a map.
//
// Semantics are those of the scans it replaces: FIRST match in child order wins.
//
// Never stale. The index is valid for one `structureEpoch` of the root (shared/meta-data.ts),
// which every non-append mutation of the child list — and every change to a child's
// resolution key — bumps. A pure append is picked up by scanning only the new tail (first
// match still wins, since later children only add keys), so a loop that interleaves adds and
// lookups stays linear. A root with a super (not a loader root) takes the original scan.

import type { MetaData } from "./shared/meta-data.js";

/** What a lookup indexes: which children count and how a child is keyed. */
export interface TopLevelView {
  /** Stable id: the cache key for this view's index. */
  readonly id: string;
  /** Does `child` take part in this view? */
  readonly includes: (child: MetaData) => boolean;
  /** The key `child` is looked up by. */
  readonly keyOf: (child: MetaData) => string;
}

class TopLevelIndex {
  readonly byKey = new Map<string, MetaData>();
  scanned = 0;
  epoch: number;
  constructor(epoch: number) {
    this.epoch = epoch;
  }
}

const indexes = new WeakMap<MetaData, Map<string, TopLevelIndex>>();

/** Observable for tests: how many times an index was (re)built from scratch. */
export const topLevelIndexStats = { rebuilds: 0, keysComputed: 0 };

/** The first child of `root` that `view` includes whose key is `key`, in child order. */
export function findTopLevelByKey(
  root: MetaData,
  view: TopLevelView,
  key: string,
  linear: () => MetaData | undefined,
): MetaData | undefined {
  // The index reads the physical child list; that is the effective list only when the
  // node has no super (ADR-0039: a loader root has none) and its child accessors are the
  // stock ones. Otherwise keep the original scan.
  if (root.superData !== undefined || !root.hasStockChildAccessors) return linear();

  let perRoot = indexes.get(root);
  if (perRoot === undefined) {
    perRoot = new Map();
    indexes.set(root, perRoot);
  }
  let index = perRoot.get(view.id);
  const epoch = root.structureEpoch;
  if (index === undefined || index.epoch !== epoch || index.scanned > root.ownChildCount) {
    index = new TopLevelIndex(epoch);
    perRoot.set(view.id, index);
    topLevelIndexStats.rebuilds++;
  }
  const count = root.ownChildCount;
  for (let i = index.scanned; i < count; i++) {
    const child = root.ownChildAt(i) as MetaData;
    if (!view.includes(child)) continue;
    const k = view.keyOf(child);
    topLevelIndexStats.keysComputed++;
    if (!index.byKey.has(k)) index.byKey.set(k, child);
  }
  index.scanned = count;
  return index.byKey.get(key);
}
