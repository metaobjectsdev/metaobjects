// server/typescript/packages/codegen-ts/src/templates/value-object-import.ts
//
// ADR-0056 — the ONE way a template-tier file names a value object's type.
//
// A value object's TypeScript interface is declared once, by entityFile(), in the value
// object's own module (`<pkgdir>/<EmittedName>.ts`). Every template-tier generator — the
// prompt render handles, the render helper, the output parser, the extractor, the trace helper —
// imports it from there and declares no interface of its own. This module answers "what name,
// and from which specifier" for a template-tier file at a given path, so the five of them cannot
// disagree with entityFile() or with each other.

import { posix } from "node:path";
import type { MetaData } from "@metaobjectsdev/metadata";
import { effectivePackage } from "../docs-paths.js";
import { entityModuleSpecifier, entityOutputPath } from "../import-path.js";
import { withExt, type ExtStyle, type RenderContext } from "../render-context.js";

/** A value object's emitted type name, and the module specifier that imports it. */
export interface ValueObjectImport {
  readonly name: string;
  readonly specifier: string;
}

/**
 * The import of `vo`'s own interface (entityFile()'s output) from a template-tier file emitted at
 * `fromPath` — a path relative to the emitting generator's target root.
 *
 * With a `ctx` (every real run) the name is the ADR-0044 emitted name entityFile() declares, and
 * the module path follows the entity target's layout; a template-tier file in another target
 * imports through that target's `importBase`. Without one (a bare unit-test call) the name is the
 * bare `vo.name` and the module is a flat sibling at the target root.
 */
export function valueObjectImport(
  ctx: RenderContext | undefined,
  vo: MetaData,
  fromPath: string,
  extStyle: ExtStyle = ctx?.extStyle ?? "js",
): ValueObjectImport {
  const name = ctx ? ctx.valueObjectEmittedName(vo) : vo.name;
  const pkg = effectivePackage(vo);
  if (ctx && ctx.selfTarget.name !== ctx.entityModuleTarget.name) {
    return { name, specifier: entityModuleSpecifier(ctx.selfTarget, ctx.entityModuleTarget, pkg, name, extStyle) };
  }
  const layout = ctx ? ctx.entityModuleTarget.outputLayout : "flat";
  const modulePath = entityOutputPath(layout, pkg, name); // extension-less
  let rel = posix.relative(posix.dirname(fromPath), modulePath);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return { name, specifier: withExt(rel, extStyle) };
}

/**
 * `import type { A, B } from "<spec>";` lines for a set of value-object imports — one per module,
 * names sorted, modules in first-seen order. An empty set yields no lines.
 */
export function valueObjectImportLines(imports: readonly ValueObjectImport[]): string[] {
  const byModule = new Map<string, Set<string>>();
  for (const i of imports) {
    const names = byModule.get(i.specifier) ?? new Set<string>();
    names.add(i.name);
    byModule.set(i.specifier, names);
  }
  return [...byModule].map(
    ([spec, names]) => `import type { ${[...names].sort().join(", ")} } from ${JSON.stringify(spec)};`,
  );
}
