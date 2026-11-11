// docs-paths.ts — the SINGLE source of truth for where a docs page is written
// AND how one page links to another. The file location and every inbound link
// href are derived from the SAME functions here, so they can never diverge.
//
// Why this matters: a page placed by short name alone collides. Two nodes that
// share a short name across different packages (e.g. `acme::sales::Order` and
// `acme::billing::Order`) would both want `Order.md`, and two names that differ
// only in case (`ProductNdc`, `ProductNDC`) want one file on a case-insensitive
// filesystem. So a docs page is always keyed by package (`DOCS_PAGE_LAYOUT`,
// `acme/sales/Order.md`), in every port; the target's `outputLayout` places code,
// not pages. `assertNoDuplicateDocPaths()` is the hard backstop for what is left —
// two names in ONE package that differ only in case — turning that data loss
// into a clear error.

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

/**
 * The layout every docs page is placed in: folded under its package path, as the cross-port
 * docs contract (`fixtures/conformance/api-docs-cross-port`) places it in every port. A docs
 * generator passes this, never the target's `outputLayout`, so a page never collides with a
 * same-named node of another package.
 */
export const DOCS_PAGE_LAYOUT: OutputLayout = "package";

/**
 * The index label of a docs page: its short name, or `<name> (<package>)` when another page in
 * the same index list shares that name (case-insensitively), so the list tells them apart.
 * `siblings` is the whole list, `node` included.
 */
export function docIndexLabel(node: DocPageNode, siblings: readonly DocPageNode[]): string {
  const key = node.name.toLowerCase();
  const shared = siblings.filter((o) => o.name.toLowerCase() === key).length > 1;
  return shared && node.package !== undefined && node.package !== "" ? `${node.name} (${node.package})` : node.name;
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
  // Relative path from the FROM page's directory to the TO page — the same
  // raw-path rule surfaceCrossHref uses, so the two can never diverge.
  return surfaceCrossHref(docPageOutputPath(layout, fromNode), toPath);
}

/** Relative href between two doc pages whose output paths (relative to the shared
 *  docs outDir) may sit under different surface sub-roots — e.g. model `Order.md`
 *  and api `api/Order.md`. The shared relative-path rule, over raw paths;
 *  docPageHref delegates its package-layout branch here. */
export function surfaceCrossHref(fromOutputPath: string, toOutputPath: string): string {
  const fromDir = fromOutputPath.includes("/") ? fromOutputPath.slice(0, fromOutputPath.lastIndexOf("/")) : "";
  const rel = posixRelative(fromDir, toOutputPath);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Href FROM a page (at `fromOutputPath`, relative to the docs root) TO a page
 *  (`page`, relative to the surface's own root) in an api surface. Relative via
 *  `surfaceCrossHref` when the surface is in the same tree; absolute `baseUrl/page`
 *  when the surface declares a baseUrl (federated / separate repo). */
export function apiSurfaceHref(
  fromOutputPath: string,
  surface: { subDir: string; baseUrl?: string },
  page: string,
): string {
  if (surface.baseUrl !== undefined && surface.baseUrl !== "") {
    return `${surface.baseUrl.replace(/\/$/, "")}/${page}`;
  }
  return surfaceCrossHref(fromOutputPath, `${surface.subDir}/${page}`);
}

/** A page about to be emitted, paired with the FQN of the node that produced it
 *  (for a precise collision diagnostic). */
export interface DocPagePlacement {
  path: string;
  fqn: string;
}

/** Hard backstop against silent overwrite (ALL layouts): if two placements
 *  resolve to the SAME output path — compared case-insensitively, because macOS
 *  and Windows hold `ProductNdc.md` and `ProductNDC.md` as one file — THROW
 *  naming both colliding node FQNs and the path. Guarantees a docs run never
 *  silently drops a page. */
export function assertNoDuplicateDocPaths(placements: DocPagePlacement[]): void {
  const seen = new Map<string, DocPagePlacement>();
  for (const placement of placements) {
    const { path, fqn } = placement;
    const key = path.toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(
        prior.path === path
          ? `docs: duplicate output path "${path}" from nodes ${prior.fqn} and ${fqn} — ` +
              `rename one of them.`
          : `docs: output paths "${prior.path}" (${prior.fqn}) and "${path}" (${fqn}) differ only ` +
              `in case — one file on a case-insensitive filesystem (macOS, Windows), so one page ` +
              `would replace the other. Rename one of them.`,
      );
    }
    seen.set(key, placement);
  }
}
