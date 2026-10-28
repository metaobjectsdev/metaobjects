// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/prisma-schema.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { prismaSchemaFile } from "./codegen/generators/prisma-schema.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Prisma (prisma.io). The schema imports nothing and needs no MetaObjects package
//                at runtime; Prisma reads it as its own. The postgresql, mysql and sqlite
//                providers (`provider` option, default from the config's `dialect`).
// use-when:      the project keeps Prisma as its ORM and wants each field declared once, in the
//                model. Pair it with `entity` under `orm: "prisma"`, which writes the types and
//                Zod schemas with no Drizzle table.
// emits:         <target>/schema.prisma, one model per table `meta migrate` would create; and
//                <target>/schema.checks.sql, the CHECK constraints a Prisma schema cannot declare
//                (enum membership, numeric and length validators), when the model implies any.
//                Apply it after `prisma db push` or a migration: `prisma db execute --file`.
// customize:     which objects get a model (the `filter` option, ANDed with "has a table"),
//                where the files land (`fileName`, `prismaChecksFileName`), and the generator and
//                datasource blocks (`header`; `false` for a multi-file schema whose blocks live
//                in a file you own). Copied beside it, so yours too: `buildPrismaSchema`, which
//                maps the model's tables to Prisma models and raises every refusal
//                (`PrismaSchemaError`), and the renderers in `render-prisma-schema`. Change the
//                type or name mapping only if you mean to stop agreeing with `meta verify --db`,
//                which compares the database against the same expected schema.
// composes-with: `entity` (the types and Zod schemas the application validates with).
//
// What the file holds never depends on the run: the universe is the whole loaded model narrowed
// by this generator's own `filter`. The run's selection decides only WHETHER it is written: a run
// that selects no table-backed object writes nothing.
//
// A hand edit is discarded (`handEdits: "overwrite"`): Prisma reads the whole file as the schema,
// so an edit kept by a merge would change the database without the model knowing, and
// `meta verify --codegen` fails on one. Declare the field in the model, or change this file.
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` (the generator base, the
// generated-file header and the source walk), the object type from `@metaobjectsdev/metadata`,
// and the Prisma mapping from `../prisma/`. `meta eject` copies those modules into your project,
// under `codegen/templates/`, and your copy of this file imports them from there: they are yours
// too. The mapping reads the expected schema from `@metaobjectsdev/migrate-ts`.

import {
  GENERATED_HEADER,
  hasWritableRdbSource,
  type EmittedFile,
  type GenContext,
  type Generator,
} from "@metaobjectsdev/codegen-ts/engine";
import { buildPrismaSchema, PRISMA_PROVIDERS, type PrismaProvider } from "../prisma/build-prisma-schema.js";
import { ERR_PRISMA_UNSUPPORTED_PROVIDER, PrismaSchemaError } from "../prisma/prisma-errors.js";
import { renderChecksSql, renderPrismaSchema } from "../prisma/render-prisma-schema.js";
import type { MetaObject } from "@metaobjectsdev/metadata";

export interface PrismaSchemaFileOptions {
  /** The Prisma datasource provider. Default: from the codegen config's `dialect`. */
  readonly provider?: PrismaProvider;
  /** The schema file, relative to the target's outDir. Default `schema.prisma`. */
  readonly fileName?: string;
  /**
   * The generator and datasource blocks. Default: a `prisma-client` generator writing to
   * `./generated` and a datasource naming the provider (Prisma 7 takes the URL from
   * `prisma.config.ts`). A string is written verbatim. `false` writes neither, for a multi-file
   * schema (`prisma/schema/`) whose blocks live in a file the project owns.
   */
  readonly header?: string | false;
  /**
   * `"file"` (the default) writes the CHECK constraints to `<name>.checks.sql`. `"omit"` leaves
   * them out, which is the only way to take a model with checks to SQLite.
   */
  readonly checks?: "file" | "omit";
  /** Which objects the schema covers, ANDed with "has a table". */
  readonly filter?: (obj: MetaObject) => boolean;
  /** Named output target: the files land at its outDir. */
  readonly target?: string;
}

/** The generator's name, as diagnostics and the catalog print it. */
const GENERATOR_NAME = "prisma-schema";

/** The schema file's name when the options name none. */
const DEFAULT_SCHEMA_FILE = "schema.prisma";

const DIALECT_PROVIDER: Record<string, PrismaProvider> = {
  postgres: "postgresql",
  mysql: "mysql",
  sqlite: "sqlite",
};

/** `schema.prisma` gives `schema.checks.sql`. */
function prismaChecksFileName(schemaFile: string): string {
  return `${schemaFile.replace(/\.prisma$/, "")}.checks.sql`;
}

function resolveProvider(ctx: GenContext, options: PrismaSchemaFileOptions): PrismaProvider {
  const provider = options.provider ?? DIALECT_PROVIDER[ctx.config.dialect];
  if (provider === undefined || !(PRISMA_PROVIDERS as readonly string[]).includes(provider)) {
    const source = options.provider !== undefined ? `provider '${String(options.provider)}'` : `dialect '${ctx.config.dialect}'`;
    throw new PrismaSchemaError(
      ERR_PRISMA_UNSUPPORTED_PROVIDER,
      `prisma-schema writes a schema for the postgresql, mysql and sqlite providers, and the ${source} is none of ` +
        `them. Pass the provider of the database Prisma connects to: prismaSchemaFile({ provider: "postgresql" }).`,
    );
  }
  return provider;
}

/** The comment lines at the top of the schema. */
function banner(checksFile: string | undefined): string[] {
  const lines = [
    `${GENERATED_HEADER}. meta gen rewrites this file and discards hand edits; meta verify --codegen fails when it`,
    "differs from the model. Declare a field in the MetaObjects model, not here.",
  ];
  if (checksFile !== undefined) {
    lines.push(`After \`prisma db push\` or a migration, apply ${checksFile}, beside this file: prisma db execute --file <its path>`);
  }
  return lines;
}

function generatePrismaFiles(ctx: GenContext, options: PrismaSchemaFileOptions): EmittedFile[] {
  if (!ctx.entities.some((o) => ctx.matches(o) && hasWritableRdbSource(o))) return [];
  const provider = resolveProvider(ctx, options);
  const spec = buildPrismaSchema(ctx.loadedRoot, {
    provider,
    // The generator's own filter, never the run's selection: see the header.
    matches: ctx.matches,
    checks: options.checks ?? "file",
  });
  const fileName = options.fileName ?? DEFAULT_SCHEMA_FILE;
  const checksFile = spec.checks.length > 0 ? prismaChecksFileName(fileName) : undefined;
  const files: EmittedFile[] = [
    { path: fileName, content: renderPrismaSchema(spec, { banner: banner(checksFile), header: options.header }) },
  ];
  if (checksFile !== undefined) {
    files.push({
      path: checksFile,
      content: renderChecksSql(spec, [
        `${GENERATED_HEADER}. The CHECK constraints ${fileName} cannot declare.`,
        "Apply after `prisma db push` or a migration: prisma db execute --file <this file's path>",
      ]),
    });
  }
  return files;
}

/**
 * The prisma-schema generator: one Prisma schema for the model's tables, plus a companion SQL
 * file for the CHECK constraints when the model implies any. Throws `PrismaSchemaError` for what
 * a Prisma schema cannot express.
 */
export function prismaSchemaFile(options: PrismaSchemaFileOptions = {}): Generator {
  const fileName = options.fileName ?? DEFAULT_SCHEMA_FILE;
  const checksFile = prismaChecksFileName(fileName);
  const generator: Generator = {
    name: GENERATOR_NAME,
    generate: (ctx) => generatePrismaFiles(ctx, options),
    handEdits: "overwrite",
    // The checks file is written only while the model implies a CHECK; when the last one goes,
    // the file it left behind is removed (when it is still what was written).
    orphanPolicy: { owns: (rel) => rel === checksFile || rel === fileName },
  };
  if (options.filter !== undefined) generator.filter = options.filter;
  if (options.target !== undefined) generator.target = options.target;
  return generator;
}
