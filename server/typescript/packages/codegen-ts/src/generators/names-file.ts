import { perEntity, type Generator } from "../generator.js";
import { renderNamesDecl } from "../templates/names-decl.js";

/**
 * §A1/§A2/§A6 — `<Entity>Names`: the physical database names for one object, as
 * constants a hand-written consumer references instead of a string literal.
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
    generate: perEntity((entity, ctx) => {
      // The strategy lives on the RENDER CONTEXT, not on ResolvedGenConfig — `ctx.config`
      // carries outDir/extStyle/dbImport/dialect and nothing about naming.
      const body = renderNamesDecl(entity, ctx.renderContext?.columnNamingStrategy);
      if (body === "") return [];   // no primary source ⇒ no names artifact (#248)
      return [{ path: `${entity.name}.names.ts`, content: body }];
    }),
  };
}
