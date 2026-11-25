// The prisma-schema generator's second stage: the spec as text. The layout is what `prisma format`
// writes (columns aligned per model, block attributes after a blank line), so formatting the
// generated file is a no-op and `meta verify --codegen` does not see a formatted file as edited.

import { CodeWriter } from "../writer/code-writer.js";
import {
  prismaString,
  type PrismaCheckSpec,
  type PrismaFieldSpec,
  type PrismaModelSpec,
  type PrismaSchemaSpec,
} from "./build-prisma-schema.js";

/** A writer laid out as `prisma format` lays a schema out. */
const prismaWriter = (): CodeWriter => new CodeWriter({ trailingComma: false });

/** `key = value` lines with the `=` aligned, as `prisma format` writes a block. */
function writeKeyValueBlock(w: CodeWriter, header: string, entries: ReadonlyArray<readonly [string, string]>): void {
  const width = Math.max(...entries.map(([k]) => k.length));
  w.block(`${header} {`, () => {
    for (const [k, v] of entries) w.line(`${k.padEnd(width)} = ${v}`);
  });
}

/** One block, written on its own, without the final newline. */
function blockText(write: (w: CodeWriter) => void): string {
  const w = prismaWriter();
  write(w);
  return w.toString().trimEnd();
}

/** The generator block a schema gets when the options name none. */
export const DEFAULT_PRISMA_CLIENT_GENERATOR = blockText(writeDefaultGenerator);

function writeDefaultGenerator(w: CodeWriter): void {
  writeKeyValueBlock(w, "generator client", [
    ["provider", prismaString("prisma-client")],
    ["output", prismaString("./generated")],
  ]);
}

/** The datasource block: the provider, and the schemas of a multi-schema Postgres model. */
export function renderDatasource(spec: PrismaSchemaSpec): string {
  return blockText((w) => writeDatasource(w, spec));
}

/** Write the datasource block into `w`. */
export function writeDatasource(w: CodeWriter, spec: PrismaSchemaSpec): void {
  const entries: Array<readonly [string, string]> = [["provider", prismaString(spec.provider)]];
  if (spec.schemas.length > 0) entries.push(["schemas", `[${spec.schemas.map(prismaString).join(", ")}]`]);
  writeKeyValueBlock(w, "datasource db", entries);
}

function fieldType(f: PrismaFieldSpec): string {
  return `${f.type}${f.list ? "[]" : ""}${f.optional ? "?" : ""}`;
}

function writeModel(w: CodeWriter, model: PrismaModelSpec): void {
  const nameWidth = Math.max(...model.fields.map((f) => f.name.length));
  const typeWidth = Math.max(...model.fields.map((f) => fieldType(f).length));
  w.block(`model ${model.name} {`, () => {
    for (const f of model.fields) {
      const type = fieldType(f);
      if (f.attributes.length === 0) w.line(`${f.name.padEnd(nameWidth)} ${type}`);
      else w.line(`${f.name.padEnd(nameWidth)} ${type.padEnd(typeWidth)} ${f.attributes.join(" ")}`);
    }
    if (model.blockAttributes.length > 0) {
      w.blank();
      for (const a of model.blockAttributes) w.line(a);
    }
  });
}

/** The models, one block each, in table order. */
export function renderModels(spec: PrismaSchemaSpec): string {
  return blockText((w) => writeModels(w, spec));
}

/** Write the models into `w`, one block each, a blank line between. */
export function writeModels(w: CodeWriter, spec: PrismaSchemaSpec): void {
  for (const model of spec.models) {
    w.blank();
    writeModel(w, model);
  }
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
  const w = prismaWriter();
  for (const l of options.banner) w.line(l === "" ? "//" : `// ${l}`);
  if (options.header === undefined) {
    w.blank();
    writeDefaultGenerator(w);
    w.blank();
    writeDatasource(w, spec);
  } else if (options.header !== false && options.header.trim() !== "") {
    // The project's own blocks, as written (the writer only re-indents them to the margin).
    w.blank();
    w.text(options.header);
  }
  writeModels(w, spec);
  return w.toString();
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
  const w = new CodeWriter();
  for (const l of banner) w.line(l === "" ? "--" : `-- ${l}`);
  for (const check of spec.checks) {
    if (spec.provider === "postgresql") {
      const table = pgTable(check);
      const name = `"${check.name.replace(/"/g, '""')}"`;
      w.line(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name};`);
      w.line(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${check.expression});`);
    } else {
      w.line(`ALTER TABLE \`${check.table}\` ADD CONSTRAINT \`${check.name}\` CHECK (${check.expression});`);
    }
  }
  return w.toString();
}
