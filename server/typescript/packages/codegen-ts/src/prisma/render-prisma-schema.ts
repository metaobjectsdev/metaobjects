// The prisma-schema generator's second stage: the spec as text. The layout is what `prisma format`
// writes (columns aligned per model, block attributes after a blank line), so formatting the
// generated file is a no-op and `meta verify --codegen` does not see a formatted file as edited.

import {
  prismaString,
  type PrismaCheckSpec,
  type PrismaFieldSpec,
  type PrismaModelSpec,
  type PrismaSchemaSpec,
} from "./build-prisma-schema.js";

/** The generator block a schema gets when the options name none. */
export const DEFAULT_PRISMA_CLIENT_GENERATOR = 'generator client {\n  provider = "prisma-client"\n  output   = "./generated"\n}';

/** `key = value` lines with the `=` aligned, as `prisma format` writes a block. */
function keyValueBlock(header: string, entries: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...entries.map(([k]) => k.length));
  return [`${header} {`, ...entries.map(([k, v]) => `  ${k.padEnd(width)} = ${v}`), "}"].join("\n");
}

/** The datasource block: the provider, and the schemas of a multi-schema Postgres model. */
export function renderDatasource(spec: PrismaSchemaSpec): string {
  const entries: Array<readonly [string, string]> = [["provider", prismaString(spec.provider)]];
  if (spec.schemas.length > 0) entries.push(["schemas", `[${spec.schemas.map(prismaString).join(", ")}]`]);
  return keyValueBlock("datasource db", entries);
}

function fieldType(f: PrismaFieldSpec): string {
  return `${f.type}${f.list ? "[]" : ""}${f.optional ? "?" : ""}`;
}

function renderModel(model: PrismaModelSpec): string {
  const nameWidth = Math.max(...model.fields.map((f) => f.name.length));
  const typeWidth = Math.max(...model.fields.map((f) => fieldType(f).length));
  const lines = model.fields.map((f) => {
    const type = fieldType(f);
    if (f.attributes.length === 0) return `  ${f.name.padEnd(nameWidth)} ${type}`;
    return `  ${f.name.padEnd(nameWidth)} ${type.padEnd(typeWidth)} ${f.attributes.join(" ")}`;
  });
  const block = model.blockAttributes.length === 0 ? [] : ["", ...model.blockAttributes.map((a) => `  ${a}`)];
  return [`model ${model.name} {`, ...lines, ...block, "}"].join("\n");
}

/** The models, one block each, in table order. */
export function renderModels(spec: PrismaSchemaSpec): string {
  return spec.models.map(renderModel).join("\n\n");
}

export interface RenderPrismaSchemaOptions {
  /** Lines written above everything else, as `//` comments. */
  readonly banner: readonly string[];
  /**
   * The generator and datasource blocks. `undefined` writes the default generator block and a
   * datasource naming the provider; `false` writes neither, for a multi-file schema whose blocks
   * live in a file the project owns; a string is written verbatim.
   */
  readonly header: string | false | undefined;
}

export function renderPrismaSchema(spec: PrismaSchemaSpec, options: RenderPrismaSchemaOptions): string {
  const parts: string[] = [];
  if (options.banner.length > 0) parts.push(options.banner.map((l) => (l === "" ? "//" : `// ${l}`)).join("\n"));
  if (options.header === undefined) parts.push(DEFAULT_PRISMA_CLIENT_GENERATOR, renderDatasource(spec));
  else if (options.header !== false && options.header.trim() !== "") parts.push(options.header.trim());
  if (spec.models.length > 0) parts.push(renderModels(spec));
  return `${parts.join("\n\n")}\n`;
}

function pgTable(check: PrismaCheckSpec): string {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return check.schema === undefined ? q(check.table) : `${q(check.schema)}.${q(check.table)}`;
}

/**
 * The CHECK constraints as SQL, for `prisma db execute --file`. On Postgres each is dropped if
 * present and added again, so the file can run after every `prisma db push`. MySQL has no
 * `DROP CONSTRAINT IF EXISTS`, so its file adds each once, after the table is created.
 */
export function renderChecksSql(spec: PrismaSchemaSpec, banner: readonly string[]): string {
  const lines: string[] = banner.map((l) => (l === "" ? "--" : `-- ${l}`));
  for (const check of spec.checks) {
    if (spec.provider === "postgresql") {
      const table = pgTable(check);
      const name = `"${check.name.replace(/"/g, '""')}"`;
      lines.push(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name};`);
      lines.push(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${check.expression});`);
    } else {
      lines.push(`ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression});`);
    }
  }
  return `${lines.join("\n")}\n`;
}
