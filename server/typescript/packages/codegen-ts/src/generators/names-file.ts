import type { Generator, GenContext, EmittedFile } from "../generator.js";
import { entityOutputPath, crossEntitySpecifier } from "../import-path.js";
import { renderNamesDecl } from "../templates/names-decl.js";
import { namesArtifactSuperOf, resolveObjectNames } from "../names.js";
import { primaryRdbSource, type MetaObject } from "@metaobjectsdev/metadata";

/**
 * §A1/§A2/§A6 — `<Entity>Names`: the physical database names for one object, as constants a
 * hand-written consumer references instead of a string literal.
 *
 * This is the built-in twin of `src/reference/names.ts` (ADR-0034 scaffold-and-own —
 * `meta init` copies the reference file into the adopter's repo; this one stays the
 * engine's internal composer and the reference-byte-identical gate's other half). Same
 * `generate` body; only the import paths differ (relative package-internal here, the
 * public `@metaobjectsdev/codegen-ts` barrel there).
 *
 * Deliberately a SEPARATE generator, never a boolean on the entity generator — a new
 * artifact is a MINOR under docs/compatibility-policy.md and adds zero bytes to existing
 * files, where a flag would move every $table-carrying golden for the same functionality.
 */
export function namesFile(): Generator {
  return {
    name: "names",
    // §A6 — the marker the runner aggregates into ResolvedGenConfig.includeNames, so the
    // entity generator can tell whether this artifact will exist. Exactly the mechanism
    // routesFileHono already uses via emitsHonoRoutes/includeHonoRoutes.
    emitsNames: true,
    generate: (ctx: GenContext): EmittedFile[] => {
      const layout = ctx.config.outputLayout ?? "flat";
      const extStyle = ctx.config.extStyle ?? "js";
      // The strategy lives on the RENDER CONTEXT, not on ResolvedGenConfig — `ctx.config`
      // carries outDir/extStyle/dbImport/dialect and nothing about naming.
      const strategy = ctx.renderContext?.columnNamingStrategy;

      const pathOf = (obj: MetaObject): string =>
        // entityOutputPath, not a bare filename: §A6 makes the entity module IMPORT these
        // constants, so the artifact has to land in the same directory the entity module
        // does. Under outputLayout: "package" a bare name puts it at the target ROOT while
        // its entity sits at <pkg>/<Entity>.ts — an unresolvable import, and a hard
        // conflicting-duplicate-path failure as soon as two packages declare a
        // same-bare-named entity.
        entityOutputPath(layout, obj.package, `${obj.name}.names.ts`);

      const superSpecifierFor = (obj: MetaObject): string | undefined => {
        const sup = namesArtifactSuperOf(obj);
        return sup === undefined
          ? undefined
          : crossEntitySpecifier(layout, obj.package, sup.package, `${sup.name}.names`, extStyle);
      };

      const out: EmittedFile[] = [];
      // Pass 1 — every matched object that participates in the database (#248).
      // `emitted` tracks what pass 1 actually WROTE, not what it looked at: a matched
      // abstract base emits nothing here, and seeding it as already-emitted is what would
      // make pass 2 skip the very object it exists to produce.
      const emitted = new Set<string>();
      const participants = ctx.entities.filter(ctx.matches);
      for (const entity of participants) {
        const content = renderNamesDecl(entity, {
          strategy, superSpecifier: superSpecifierFor(entity),
        });
        if (content === "") continue;   // no primary source ⇒ no names artifact (#248)
        emitted.add(entity.resolutionKey());
        out.push({ path: pathOf(entity), content });
      }

      // Pass 2 — the abstract bases those participants EXTEND. Each carries the columns it
      // declares, so a child states them once rather than restating its parent's.
      //
      // Reached by walking UP from a participant, never by scanning for abstracts: that is
      // what keeps #248 intact. A sourceless object nothing persistable extends — an
      // `object.value`, say — is not reached, so it acquires no artifact and no phantom
      // participation. Two children of one base both reach it and emit the same file at
      // the same path with the same bytes; the runner collapses byte-identical duplicates
      // (#266), so it is written once. `emitted` keeps that from even arising, and keeps
      // the walk from re-rendering the same base once per child.
      for (const entity of participants) {
        if (resolveObjectNames(entity, strategy) === undefined) continue;
        for (let sup = namesArtifactSuperOf(entity); sup !== undefined;
             sup = namesArtifactSuperOf(sup)) {
          const key = sup.resolutionKey();
          if (emitted.has(key)) break;   // already emitted, and so is everything above it
          emitted.add(key);
          // "Fragment" means "declares no source", so it is DERIVED rather than asserted.
          // Hardcoding `true` here was right for the shape this pass was written for — an
          // abstract base with columns and no table — and wrong for the one it also
          // reaches: a scoped run (`meta gen --entities <Subtype>`) walks up to a TPH BASE,
          // which owns the shared table. Rendered as a fragment it came out with
          // `sources: {}` while the subtype emitted `...<Base>Names.sources`, so the
          // entity module referenced a member that resolved to nothing.
          const content = renderNamesDecl(sup, {
            strategy,
            superSpecifier: superSpecifierFor(sup),
            fragment: primaryRdbSource(sup) === undefined,
          });
          if (content === "") continue;
          out.push({ path: pathOf(sup), content });
        }
      }
      return out;
    },
  };
}
