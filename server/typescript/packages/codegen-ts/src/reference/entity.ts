// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/entity.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { entityFile } from "./codegen/generators/entity.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Drizzle ORM + Zod. The emitted module is a Drizzle table plus Zod
//                insert/update schemas; the column mapping follows `dialect`. To target a
//                different ORM or validator, override `writeTable` / `writeValidators` in a
//                subclass of `EntityFileWriter` — the metadata walk that feeds them is
//                ORM-neutral.
// use-when:      ALWAYS — this is the entity-module generator. It owns the shape of each
//                generated <Entity>.ts (the Drizzle table, Zod schemas, inferred types,
//                constants, filter allowlists). Start here and adapt the assembly.
// emits:         <target>/<Entity>.ts per concrete object — and the shared-enums module once.
//                Dispatches: abstract/value → interface + Zod; sourceless entity (identity, no
//                source — a MongoDB/Cassandra/Neo4j record) → interface + create/PATCH Zod +
//                allowlists; projection → read-only view decl; write-through entity → full
//                Drizzle table path.
// customize:     subclass `EntityFileWriter` (templates/entity-file.ts, copied beside this file)
//                and override the method for the section you want changed — `writeFileHeader`,
//                `writeTable`, `writeRowTypes`, `writeValidators`, `writeConstants`,
//                `writeAllowlists`, `writeFilter`, `writeTphUnion`, or `writeTableModule` to
//                reorder or drop sections — then pass the subclass as `writer` below. Or edit
//                `entity-file.ts` itself: it is yours once ejected.
// owns:          the allowlist TYPES too. `<Entity>FilterAllowlist` / `<Entity>SortAllowlist`
//                are typed by `FilterAllowlist` / `SortAllowlist`, which `meta eject entity`
//                copies into `codegen/runtime/drizzle-fastify/filter-allowlist.ts`; the emitted
//                type import points there, not at `@metaobjectsdev/runtime-ts`.
//                `runtimeImport` moves it; `runtimeImport: "@metaobjectsdev/runtime-ts"`
//                goes back to the package.
// composes-with: queries.ts, routes.ts, barrel.ts (they import the files this emits).
//
// The composition is `EntityFileWriter`, the built-in entity composer — one method per
// section on the TypeScript writer, now YOURS to change. It imports the engine from the
// package and the section writers from `../templates/`, which `meta eject` copies beside it.

import { effectivePackage } from "@metaobjectsdev/codegen-ts/engine";
import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type EmittedFile,
  type GenContext,
  type Generator,
  type GeneratorFactory,
  type RenderContext,
  isAbstract,
  ownedRuntimeImport,
  DEFAULT_OUTPUT_LAYOUT,
  entityOutputPath,
  claimModuleNames,
} from "@metaobjectsdev/codegen-ts/engine";
import { EntityFileWriter, type EntityFileWriterClass } from "../templates/entity-file.js";
import { renderSharedEnumsFile, SHARED_ENUMS_BASENAME } from "../templates/enums-file.js";

export interface EntityFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
  allowlists?: boolean;
  /**
   * Where the emitted allowlist TYPES are imported from. Absent: the copy `meta eject
   * entity` placed in `codegen/runtime/`, by a path computed from the target's output
   * directory. A relative value is relative to the output root (like `dbImport`);
   * `"@metaobjectsdev/runtime-ts"` imports the package instead.
   */
  runtimeImport?: string;
  /** The composer: `EntityFileWriter`, or a subclass that overrides the sections you change. */
  writer?: EntityFileWriterClass;
}

export const entityFile = function entityFile(opts?: EntityFileOpts): Generator {
  const allowlists = opts?.allowlists ?? true;
  const Writer = opts?.writer ?? EntityFileWriter;
  const perEntityEmit = perEntity(async (entity, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("entity-file: renderContext is required (provided by runGen)");
    }
    if (isAbstract(entity) && !ctx.renderContext.emitAbstractShapes) {
      return [];
    }
    // Claim the module's type name in its directory: two objects
    // emitting one name there are refused, naming both.
    claimModuleNames(ctx, entity);
    const renderContext: RenderContext = {
      ...ctx.renderContext,
      httpRuntimeImport: opts?.runtimeImport
        ?? ownedRuntimeImport(ctx.projectRoot ?? ".", ctx.renderContext.selfTarget.outDir),
    };
    return {
      path: entityOutputPath(ctx.config.outputLayout ?? DEFAULT_OUTPUT_LAYOUT, effectivePackage(entity), `${entity.name}.ts`),
      content: new Writer(entity, renderContext, { allowlists }).compose().toString(),
    };
  });

  const generator: Generator = {
    name: "entity-file",
    provides: { entityModule: true },
    generate: async (ctx: GenContext): Promise<EmittedFile[]> => {
      const files = await perEntityEmit(ctx);
      // FR-019: emit the shared-enums module once per run (null → no file).
      // FR-023 §11.1 item 2: this is a REFERENCE TEMPLATE `meta init` copies into
      // every scaffolded project's codegen/generators/ (ADR-0034) — the DEFAULT
      // path, not an opt-in one. `select` (never `ctx.matches`, which never runs
      // for a whole-root render like this one) excludes an enum used only by an
      // imported, out-of-scope entity; without it every `meta init` project would
      // silently emit shared enums the library path correctly excludes.
      const sharedEnums = renderSharedEnumsFile(
        ctx.loadedRoot,
        ctx.select !== undefined ? { select: ctx.select } : undefined,
      );
      if (sharedEnums !== null) {
        files.push({ path: `${SHARED_ENUMS_BASENAME}.ts`, content: sharedEnums });
      }
      return files;
    },
  };
  if (opts?.filter) {
    generator.filter = opts.filter;
  }
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<EntityFileOpts>;
