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
//                gets no names artifact — EXCEPT an abstract base that a sourced object
//                extends, which gets a fragment (columns, no physical name) so its
//                children extend it instead of restating every inherited column.
// customize:     swap `renderNamesDecl` for your own shape; keep `resolveObjectNames` as the
//                one resolver so the constant and the DDL it describes cannot disagree.
// composes-with: entity.ts, routes.ts — both reference these constants instead of
//                embedding the names a second time. queries.ts never embeds a physical
//                name of its own: it reads/writes through the Drizzle table object
//                entity.ts builds (columns keyed by FIELD name), so there is nothing in
//                it to wire.
//
// The composition here is deliberately a SEPARATE generator, never a boolean on the entity
// generator — a new artifact is a MINOR under docs/compatibility-policy.md and adds zero
// bytes to existing files, where a flag would move every $table-carrying golden for the
// same functionality.
import {
  crossEntitySpecifier,
  entityOutputPath,
  namesArtifactSuperOf,
  renderNamesDecl,
  resolveObjectNames,
  type EmittedFile,
  type GenContext,
  type Generator,
} from "@metaobjectsdev/codegen-ts";
import type { MetaObject } from "@metaobjectsdev/metadata";

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
          const content = renderNamesDecl(sup, {
            strategy, superSpecifier: superSpecifierFor(sup),
            // "Fragment" means "declares no source". Hardcoding `true` is right for the
            // shape this pass was written for — an abstract base with columns and no table
            // — and wrong for the one it also reaches: `meta gen --entities <Subtype>`
            // walks up to a TPH BASE, which owns the shared table, and a fragment renders
            // no source at all. The engine derives this itself now (`renderNamesDecl`
            // consults the object), so the flag says only "this is an ancestor render".
            fragment: true,
          });
          if (content === "") continue;
          out.push({ path: pathOf(sup), content });
        }
      }
      return out;
    },
  };
}
