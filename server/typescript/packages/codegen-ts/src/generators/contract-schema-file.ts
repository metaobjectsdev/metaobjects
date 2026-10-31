// FR-022 — jsonSchemaFile(), the contract-schema reference generator: the wire shapes of the model's
// objects as JSON Schema 2020-12. The shapes are the pure stages in src/contract/; this file decides
// which objects get a file, where it lands and which profile it writes.
//
// Canonical (the default) writes `<Name>.schema.json` for what a read answers, and
// `<Name>.create.schema.json` / `<Name>.update.schema.json` where the object has those shapes.
// Strict writes one self-contained `<Name>.strict.schema.json`, for a structured-output host.

import { type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { effectivePackage } from "../docs-paths.js";
import type { EmittedFile, GenContext, Generator } from "../generator.js";
import { packageToPath } from "../import-path.js";
import type { ContractShape, JsonSchema } from "../contract/field-schema.js";
import { collectContractEntries, contractObjects } from "../contract/object-schema.js";
import { hasStrictSchema, strictSchema } from "../contract/strict-profile.js";

/** The generator's stable name. `json-schema` is the Java generator for metadata files: a different concept. */
const GENERATOR_NAME = "contract-schema";

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

const SHAPE_INFIX: Record<ContractShape, string> = { read: "", create: ".create", update: ".update" };

export interface JsonSchemaFileOptions {
  /** `canonical` is full fidelity. `strict` is the structured-output subset. Default: canonical. */
  readonly profile?: "canonical" | "strict";
  /** Narrow which objects get a file. An object a kept one references still gets its own. */
  readonly filter?: (obj: MetaObject) => boolean;
  /** Named output target: the files land under its outDir. */
  readonly target?: string;
}

function schemaDir(obj: MetaObject): string {
  const pkg = effectivePackage(obj);
  return pkg === undefined ? "schemas" : `schemas/${packageToPath(pkg)}`;
}

function schemaPath(obj: MetaObject, shape: ContractShape): string {
  return `${schemaDir(obj)}/${obj.name}${SHAPE_INFIX[shape]}.schema.json`;
}

/** The relative `$ref` from one object's directory to another's file. */
function relativeRef(from: MetaObject, target: MetaObject, shape: ContractShape): string {
  const fromDir = schemaDir(from).split("/");
  const toParts = schemaPath(target, shape).split("/");
  let shared = 0;
  while (shared < fromDir.length && fromDir[shared] === toParts[shared]) shared++;
  const up = fromDir.slice(shared).map(() => "..");
  const rel = [...up, ...toParts.slice(shared)].join("/");
  return up.length === 0 ? `./${rel}` : rel;
}

function renderJson(value: JsonSchema): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalFiles(objects: readonly MetaObject[], root: MetaRoot): EmittedFile[] {
  return collectContractEntries(objects, root, relativeRef).map(({ obj, shape, schema }) => {
    const path = schemaPath(obj, shape);
    const title = shape === "read" ? obj.name : `${obj.name}${SHAPE_INFIX[shape]}`;
    return { path, content: renderJson({ $schema: JSON_SCHEMA_DIALECT, $id: path, title, ...schema }) };
  });
}

function strictFiles(objects: readonly MetaObject[], root: MetaRoot): EmittedFile[] {
  return objects.filter((o) => hasStrictSchema(o, root)).map((obj) => ({
    path: `${schemaDir(obj)}/${obj.name}.strict.schema.json`,
    content: renderJson(strictSchema(obj, root)),
  }));
}

function generateSchemaFiles(ctx: GenContext, options: JsonSchemaFileOptions): EmittedFile[] {
  const root = ctx.loadedRoot;
  const objects = contractObjects(ctx.entities.filter(ctx.matches), root);
  return options.profile === "strict" ? strictFiles(objects, root) : canonicalFiles(objects, root);
}

/** JSON Schema files for the model's objects, in one profile. List it twice for both. */
export function jsonSchemaFile(options: JsonSchemaFileOptions = {}): Generator {
  const generator: Generator = {
    name: GENERATOR_NAME,
    generate: (ctx) => generateSchemaFiles(ctx, options),
  };
  if (options.filter !== undefined) generator.filter = options.filter;
  if (options.target !== undefined) generator.target = options.target;
  return generator;
}
