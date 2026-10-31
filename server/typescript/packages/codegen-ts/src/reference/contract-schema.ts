// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/contract-schema.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { jsonSchemaFile } from "./codegen/generators/contract-schema.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       JSON Schema 2020-12. The files import nothing and need no MetaObjects package:
//                any validator reads them, in any language.
// use-when:      something outside this repository needs the shape of what the API sends and
//                takes (a validator, a schema registry, a client in a language without a port), or
//                a model needs to fill one in (`profile: "strict"`: structured output, MCP).
// emits:         <target>/schemas/<package path>/<Name>.schema.json for what a read answers, and
//                <Name>.create.schema.json / <Name>.update.schema.json where the object has those
//                shapes. `profile: "strict"` writes one self-contained <Name>.strict.schema.json
//                instead. List the generator twice to get both.
// customize:     which objects get a file (`generateSchemaFiles`, narrowed by the `filter` option),
//                where they land (`schemaDir`, `schemaPath`) and the `$id` (`canonicalFiles`).
//                Copied beside it, so yours too: `fieldSchema`, which maps each field type to its
//                wire encoding; `objectSchema`, which decides what each shape holds; and
//                `strictSchema`, the strict subset. Change those only if your routes differ from
//                the REST contract: they state what every port's routes answer.
// composes-with: openapi, whose components are these schemas.
//
// A file is written for each object the run selects, and for each object a kept one references,
// so a `$ref` never dangles when `filter` leaves its target out. `wire.decimals` and
// `wire.nullMembers` in `.metaobjects/config.json` decide the read shape of a decimal and of a value
// object's optional member. A project that publishes this contract should set both, because the
// default is each server language's own form (docs/features/contract-emitters.md).
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` and the contract stages from
// `../contract/`. `meta eject` copies those modules into your project, under `codegen/templates/`,
// and your copy of this file imports them from there: they are yours too.

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { effectivePackage, packageToPath, type EmittedFile, type GenContext, type Generator } from "@metaobjectsdev/codegen-ts/engine";
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
