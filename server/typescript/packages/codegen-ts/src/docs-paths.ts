// docs-paths.ts — the SINGLE source of truth for where a docs page is written
// AND how one page links to another. The file location and every inbound link
// href are derived from the SAME functions here, so they can never diverge.
//
// Why this matters: pages are placed by short name. In "flat" layout two nodes
// that share a short name across different packages (e.g. `acme::sales::Order`
// and `acme::billing::Order`) would both want `Order.md` and one would silently
// overwrite the other. `assertNoDuplicateDocPaths()` is the hard backstop that
// turns that data-loss into a clear error; "package" layout folds pages under
// package-path subdirs (`acme/sales/Order.md`) so multi-package models work.

import { PACKAGE_SEPARATOR } from "@metaobjectsdev/metadata";
import { relative as posixRelative } from "node:path/posix";
import { packageToPath, type OutputLayout } from "./import-path.js";

/** The minimal shape needed to place a docs page / compute a link to it: a
 *  short name and its EFFECTIVE package. Build one from a metadata node via
 *  `docPageNode()`. */
export interface DocPageNode {
  readonly name: string;
  readonly package?: string | undefined;
}

/** A metadata node enough to derive page placement. `resolutionKey()` carries
 *  the EFFECTIVE package (own package OR the file-default captured at parse
 *  time) folded as `<pkg>::<name>` — `.package` alone is often undefined for
 *  objects (FR5d keeps object fqn() bare), so we read placement off the
 *  resolution key instead. */
interface PlaceableNode {
  readonly name: string;
  resolutionKey(): string;
}

/** Effective package of a placeable node: the prefix of `resolutionKey()`
 *  before the trailing `::<name>`, or undefined when the node is package-less. */
export function effectivePackage(node: PlaceableNode): string | undefined {
  const key = node.resolutionKey();
  const suffix = `${PACKAGE_SEPARATOR}${node.name}`;
  if (key === node.name) return undefined;
  if (key.endsWith(suffix)) {
    const pkg = key.slice(0, key.length - suffix.length);
    return pkg === "" ? undefined : pkg;
  }
  return undefined;
}

/** Build a placement node ({name, effective package}) from a metadata node. The
 *  single bridge from a loaded node to the path/href helpers — so file location
 *  and link href derive from the SAME effective package. */
export function docPageNode(node: PlaceableNode): DocPageNode {
  return { name: node.name, package: effectivePackage(node) };
}

/** Output path (relative to the docs out dir) for a node's `.md` page.
 *  Flat → `<name>.md` (today's value, byte-identical). Package → folded under
 *  the package path (`acme/sales/Order.md`); a package-less node stays at root. */
export function docPageOutputPath(layout: OutputLayout, node: DocPageNode): string {
  const filename = `${node.name}.md`;
  if (layout === "flat") return filename;
  const dir = packageToPath(node.package);
  return dir === "" ? filename : `${dir}/${filename}`;
}

/** Relative href FROM `fromNode`'s page TO `toNode`'s page. Derived from the
 *  same `docPageOutputPath()` placement, so a link always points at the file's
 *  real location in BOTH layouts. Flat → `./<to>.md`; package → a correct
 *  relative path (e.g. `../comms/OrderEmail.md`). */
export function docPageHref(
  layout: OutputLayout,
  fromNode: DocPageNode,
  toNode: DocPageNode,
): string {
  const toPath = docPageOutputPath(layout, toNode);
  if (layout === "flat") return `./${toPath}`;
  const fromPath = docPageOutputPath(layout, fromNode);
  // Relative path from the FROM page's directory to the TO page.
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  let rel = posixRelative(fromDir, toPath);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** A page about to be emitted, paired with the FQN of the node that produced it
 *  (for a precise collision diagnostic). */
export interface DocPagePlacement {
  path: string;
  fqn: string;
}

/** Hard backstop against silent overwrite (ALL layouts): if two placements
 *  resolve to the SAME output path, THROW naming both colliding node FQNs and
 *  the path. Guarantees a docs run never silently drops a page. */
export function assertNoDuplicateDocPaths(placements: DocPagePlacement[]): void {
  const seen = new Map<string, string>();
  for (const { path, fqn } of placements) {
    const prior = seen.get(path);
    if (prior !== undefined) {
      throw new Error(
        `docs: duplicate output path "${path}" from nodes ${prior} and ${fqn} — ` +
          `use package layout (outputLayout: "package" / meta docs --layout package) ` +
          `to disambiguate.`,
      );
    }
    seen.set(path, fqn);
  }
}
