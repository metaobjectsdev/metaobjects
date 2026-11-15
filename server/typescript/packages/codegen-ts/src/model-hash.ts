// ADR-0062 §3 — the model half of the `meta gen` skip key, computed from the LOADED model.
//
// Each root-level node is hashed in its canonical EFFECTIVE form (the serializer the
// conformance corpus pins: `extends` and overlays applied, attributes in fixed order, no
// source positions). So reformatting a metadata file, reordering its keys, or moving an
// object to another file leaves the key alone, while editing an abstract parent changes the
// key of every node that inherits from it.
//
// Node hashes roll up into one hash per package and one for the model. The whole tree is
// returned, not just the top: a per-object or per-package key (one generator over one unit)
// reuses the same node and package hashes.
import { createHash } from "node:crypto";
import { canonicalSerializeEffective, type MetaData } from "@metaobjectsdev/metadata";

/** Bumped whenever how a node is hashed changes, so a stored key never matches across it. */
export const MODEL_HASH_FORMAT = 1;

export interface ModelHashNode {
  /** `type.subType` and the node's effective qualified name: unique among root children. */
  key: string;
  package: string;
  hash: string;
}

export interface ModelHashTree {
  nodes: ModelHashNode[];
  /** Package name ("" for none) to the hash of its nodes. */
  packages: Map<string, string>;
  model: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Fold `name hash` lines, sorted, so discovery order never matters. */
function fold(label: string, lines: string[]): string {
  return sha256(`${label} ${MODEL_HASH_FORMAT}\n${[...lines].sort().join("\n")}\n`);
}

function packageOf(node: MetaData): string {
  const key = node.resolutionKey();
  const i = key.lastIndexOf("::");
  return i < 0 ? "" : key.slice(0, i);
}

/** Hash the loaded model: every root-level node, then each package, then the model. */
export function modelHashTree(root: MetaData): ModelHashTree {
  const nodes: ModelHashNode[] = root.children().map((node) => ({
    key: `${node.type}.${node.subType}:${node.resolutionKey()}`,
    package: packageOf(node),
    hash: sha256(canonicalSerializeEffective(node)),
  }));
  const byPackage = new Map<string, string[]>();
  for (const n of nodes) {
    const lines = byPackage.get(n.package) ?? [];
    lines.push(`${n.key}\t${n.hash}`);
    byPackage.set(n.package, lines);
  }
  const packages = new Map<string, string>();
  for (const [pkg, lines] of byPackage) packages.set(pkg, fold("metaobjects-package", lines));
  // The root's own attributes (anything set on the root itself rather than on a node).
  const rootAttrs = [...root.attrs()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const model = fold("metaobjects-model", [
    ...[...packages].map(([pkg, h]) => `${pkg}\t${h}`),
    `(root)\t${sha256(JSON.stringify(rootAttrs))}`,
  ]);
  return { nodes, packages, model };
}
