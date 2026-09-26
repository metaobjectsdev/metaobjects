// EXAMPLE GENERATOR — copy it into your repo (codegen/generators/openapi.ts) and own it.
// It is a worked example, NOT a supported MetaObjects product surface: no release promises
// its output, and when your API differs you edit your copy.
//
// Wire it in metaobjects.config.ts (it reuses the field mapping in json-schema.ts, so copy
// both files into the same directory):
//   import { openApiFile } from "./codegen/generators/openapi.js";
//   export default defineConfig({ apiPrefix: "/api", generators: [openApiFile({ title: "Shop" })] });
//
// emits:  <outDir>/openapi.json — ONE OpenAPI 3.1 document for the whole model (a perModel
//         generator): every concrete object as a component schema, and the CRUD paths of
//         the cross-port REST contract (docs/features/api-contract.md) for each object that
//         has a source. `meta verify --codegen` re-runs it and fails when it is stale.
//
// It describes the REFERENCE route contract — list, get, create, update, delete at the
// collection path `servedPath` computes. If you serve a different API, this is the file to
// change: drop the verbs you do not mount, add your own operations, rename the tags.
import {
  isAbstract,
  perModel,
  servedPath,
  servesReadApi,
  servesWriteApi,
  type Generator,
} from "@metaobjectsdev/codegen-ts";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { fieldSchema, objectSchema, type JsonSchema } from "./json-schema.js";

export interface OpenApiFileOpts {
  /** `info.title`. */
  title?: string;
  /** `info.version` — the version of YOUR API, not of MetaObjects. */
  version?: string;
  /** Output path relative to the target's outDir. */
  path?: string;
  /** Narrow which objects appear (ANDed with "not abstract"). */
  filter?: (entity: MetaObject) => boolean;
  /** Named output target, as on every generator. */
  target?: string;
}

/** Component names are the object's name; qualify them if two packages share one. */
const componentRef = (obj: MetaObject): string => `#/components/schemas/${obj.name}`;

const json = (schema: JsonSchema) => ({ "application/json": { schema } });

/** The `{id}` path parameter, typed from the object's primary-key field. */
function idParameter(obj: MetaObject): JsonSchema {
  const pkName = obj.primaryIdentity()?.fields[0];
  const pkField = pkName === undefined ? undefined : obj.fields().find((f) => f.name === pkName);
  return {
    name: "id",
    in: "path",
    required: true,
    schema: pkField === undefined ? { type: "string" } : fieldSchema(pkField, componentRef),
  };
}

const errorResponse = { description: "Error", content: json({ type: "object", properties: { error: { type: "string" } } }) };

function pathsFor(obj: MetaObject, apiPrefix: string): Record<string, JsonSchema> {
  const collection = servedPath(obj, apiPrefix);
  const row = { $ref: componentRef(obj) };
  const tags = [obj.name];
  const listOp: JsonSchema = {
    operationId: `list${obj.name}`,
    tags,
    parameters: [
      { name: "limit", in: "query", schema: { type: "integer", minimum: 0 } },
      { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
      { name: "sort", in: "query", schema: { type: "string" }, description: "field:asc|desc" },
    ],
    responses: { "200": { description: "OK", content: json({ type: "array", items: row }) }, "400": errorResponse },
  };
  const getOp: JsonSchema = {
    operationId: `get${obj.name}`,
    tags,
    responses: { "200": { description: "OK", content: json(row) }, "404": errorResponse },
  };
  const collectionItem: JsonSchema = { get: listOp };
  const idItem: JsonSchema = { parameters: [idParameter(obj)], get: getOp };

  // A read-only source (a view, a projection) is served for reads only.
  if (servesWriteApi(obj)) {
    collectionItem.post = {
      operationId: `create${obj.name}`,
      tags,
      requestBody: { required: true, content: json(row) },
      responses: { "201": { description: "Created", content: json(row) }, "400": errorResponse },
    };
    const updateOp = {
      operationId: `update${obj.name}`,
      tags,
      requestBody: { required: true, content: json(row) },
      responses: { "200": { description: "OK", content: json(row) }, "404": errorResponse },
    };
    idItem.patch = updateOp;
    idItem.delete = {
      operationId: `delete${obj.name}`,
      tags,
      responses: { "204": { description: "Deleted" }, "404": errorResponse },
    };
  }
  return { [collection]: collectionItem, [`${collection}/{id}`]: idItem };
}

export function openApiFile(opts: OpenApiFileOpts = {}): Generator {
  const generator: Generator = {
    name: "openapi",
    filter: (obj) => !isAbstract(obj) && (opts.filter?.(obj) ?? true),
    // perModel: one file for the whole model, called with every matched object.
    generate: perModel((objects, ctx) => {
      // The config's `apiPrefix` (and its naming keys) reach a generator on renderContext.
      const apiPrefix = ctx.renderContext?.apiPrefix ?? "";
      const schemas: Record<string, JsonSchema> = {};
      let paths: Record<string, JsonSchema> = {};
      for (const obj of objects) {
        schemas[obj.name] = objectSchema(obj, componentRef);
        if (servesReadApi(obj)) paths = { ...paths, ...pathsFor(obj, apiPrefix) };
      }
      const doc = {
        openapi: "3.1.0",
        info: { title: opts.title ?? "API", version: opts.version ?? "0.0.0" },
        paths,
        components: { schemas },
      };
      return { path: opts.path ?? "openapi.json", content: `${JSON.stringify(doc, null, 2)}\n` };
    }),
  };
  if (opts.target !== undefined) generator.target = opts.target;
  return generator;
}
