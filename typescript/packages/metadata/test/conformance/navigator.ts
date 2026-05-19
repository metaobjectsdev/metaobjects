// navigator.ts — interprets a script.json navigate path over the typed
// MetaData tree. A path segment is `type:name`, or `type[subType]` for a
// nameless node.

import type { MetaData } from "../../src/meta/meta-data.js";

function matchSegment(node: MetaData, segment: string): boolean {
  const bracket = segment.match(/^([a-z]+)\[([a-zA-Z]+)\]$/);
  if (bracket) return node.type === bracket[1] && node.subType === bracket[2];
  const colon = segment.indexOf(":");
  if (colon === -1) return false;
  return node.type === segment.slice(0, colon) && node.name === segment.slice(colon + 1);
}

/** Walk `root.children()` matching each path segment; undefined if any segment misses. */
export function navigate(root: MetaData, path: readonly string[]): MetaData | undefined {
  let current: MetaData = root;
  for (const segment of path) {
    const next = current.children().find((c) => matchSegment(c, segment));
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}
