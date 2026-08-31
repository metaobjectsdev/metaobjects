// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/names.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { namesFile } from "./codegen/generators/names.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       the emit step. Replace `renderNamesDecl` to change the artifact's SHAPE
//                (e.g. flat `SUBSCRIBER_TABLE` constants instead of a nested object); keep
//                `resolveObjectNames` so the names still come from the same resolver as the DDL.
// use-when:      you want the physical database names (table/view + column names) for each
//                object available as importable constants, so a hand-written consumer never
//                has to embed a name as a string literal a second time.
// emits:         <target>/<Entity>.names.ts per concrete object with a primary source
//                (under outputLayout: "package", <target>/<pkg>/<Entity>.names.ts — beside
//                the entity module it describes). An object with no primary source (#248)
//                gets no names artifact.
// customize:     swap `renderNamesDecl` for your own shape; keep `resolveObjectNames` as the
//                one resolver so the constant and the DDL it describes cannot disagree.
// composes-with: entity.ts, queries.ts, routes.ts (a later task wires them to reference these
//                constants instead of embedding the names a second time).
//
// The composition here is deliberately a SEPARATE generator, never a boolean on the entity
// generator — a new artifact is a MINOR under docs/compatibility-policy.md and adds zero
// bytes to existing files, where a flag would move every $table-carrying golden for the
// same functionality.
import {
  entityOutputPath,
  perEntity,
  renderNamesDecl,
  type Generator,
} from "@metaobjectsdev/codegen-ts";

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
      // entityOutputPath, not a bare filename: §A6 makes the entity module IMPORT these
      // constants, so the artifact has to land in the same directory the entity module
      // does. Under outputLayout: "package" a bare name puts it at the target ROOT while
      // its entity sits at <pkg>/<Entity>.ts — an unresolvable import, and a hard
      // conflicting-duplicate-path failure as soon as two packages declare a
      // same-bare-named entity.
      return [{
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.names.ts`),
        content: body,
      }];
    }),
  };
}
