// The service layer (ADR-0067 §1, layer 4) and its thin Fastify transport (layer 5).
//
// A package's service module is a folder of files, one per operation, and an index that declares
// the operations interface and the factory that binds them to their dependencies:
//
//   <pkg>/service/<operation>.ts  — one exported function: `(deps, ...args, opts) => OpResult`
//   <pkg>/service/index.ts        — `ServiceDeps`, the `<Pkg>Service` interface, `create<Pkg>Service`,
//                                   and each entity's wire mapper
//   <pkg>/transport/fastify.ts    — the routes: parse, call the service, send what it answered
//
// Every write operation runs in one transaction (a savepoint inside a caller's), in ADR-0067 §4's
// order: load the row under a row lock, validate and stamp the input (ADR-0045), write. A refusal
// rolls it back. Reads open no write transaction. The mechanics are `@metaobjectsdev/runtime-ts/service`;
// what runs, against which schema and table, is written here.

import type { MetaObject } from "@metaobjectsdev/metadata";
import { GENERATED_EDIT_NOTE, GENERATED_HEADER } from "../constants.js";
import { withExtIfRelative, type RenderContext } from "../render-context.js";
import { decimalColumnsLine, knownFieldsLine, paginationLine, restPath, writeDeniedColumnsLine } from "../api-surface.js";
import { dbTypeBlock } from "../dialect-module.js";
import { contractObjectPath, contractSpecifier } from "../contract-walk.js";
import { DEFAULT_OUTPUT_LAYOUT, entityOutputPath } from "../import-path.js";
import { effectivePackage } from "../docs-paths.js";
import {
  fastifyTransportPath,
  runtimeSpecifierFrom,
  serviceFactoryName,
  serviceTypeName,
  servicePath,
  serviceRoutesName,
  SERVICE_INDEX_FILE,
  type ServiceEntity,
  type ServicePackage,
} from "../service-walk.js";
import { TsWriter, str } from "../writer/ts-writer.js";

/** One emitted file of the service or transport layer. */
export interface ServiceFile {
  readonly path: string;
  readonly content: string;
}

/** Where a module of `obj` (its entity module or its contract module) is, from the file at `from`. */
interface Modules {
  readonly entity: string;
  readonly contract: string;
}

function modulesOf(from: string, obj: MetaObject, ctx: RenderContext): Modules {
  const layout = ctx.outputLayout ?? DEFAULT_OUTPUT_LAYOUT;
  return {
    entity: contractSpecifier(from, entityOutputPath(layout, effectivePackage(obj), `${obj.name}.ts`), ctx.extStyle),
    contract: contractSpecifier(from, contractObjectPath(layout, obj), ctx.extStyle),
  };
}

function header(w: TsWriter, what: string): void {
  w.header(`// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`, `// Source metadata: ${what}`);
}

/**
 * An object literal of `key: value,` entries (an api-surface fragment may hold several): `head{}tail`
 * when there are none, else a block. The fragments' own indent is dropped and the writer's used.
 */
function objectLiteral(w: TsWriter, head: string, entries: readonly string[], tail: string): void {
  // An entry is one `key: value,` line, or an api-surface fragment of several, each led by a break.
  const lines = entries.flatMap((e) => e.split("\n")).map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) {
    w.line(`${head}{}${tail}`);
    return;
  }
  w.block(`${head}{`, () => {
    for (const l of lines) w.line(l);
  }, `}${tail}`);
}

const lowerFirst = (s: string): string => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

/** The wire mapper of an entity's rows, as the service index exports it. */
export function wireMapperName(entityName: string): string {
  return `${lowerFirst(entityName)}ToWire`;
}

/** Every file of package `pkg`'s service module. */
export function renderServiceFiles(pkg: ServicePackage, ctx: RenderContext): ServiceFile[] {
  const files: ServiceFile[] = [];
  for (const e of pkg.entities) {
    for (const op of ["list", "get", "create", "update", "delete"] as const) {
      const path = servicePath(pkg.package, `${e.operations[op]}.ts`);
      files.push({ path, content: renderOperation(op, e, path, ctx) });
    }
  }
  const index = servicePath(pkg.package, SERVICE_INDEX_FILE);
  files.push({ path: index, content: renderServiceIndex(pkg, index, ctx) });
  return files;
}

function renderOperation(
  op: "list" | "get" | "create" | "update" | "delete",
  e: ServiceEntity,
  path: string,
  ctx: RenderContext,
): string {
  const obj = e.obj;
  const name = obj.name;
  const fn = e.operations[op];
  const w = new TsWriter();
  header(w, `${name} (${obj.fqn()}) — service operation ${fn} (ADR-0067 layer 4)`);
  const runtime = runtimeSpecifierFrom(path, "service", ctx);
  const mods = modulesOf(path, obj, ctx);
  const table = w.use(ctx.collectionName(name), mods.entity);
  const row = w.useType(name, mods.contract);
  const deps = w.useType("ServiceDeps", withExtIfRelative(`./${SERVICE_INDEX_FILE.replace(/\.ts$/, "")}`, ctx.extStyle));
  const opOptions = w.useType("OpOptions", runtime);
  const opResult = w.useType("OpResult", runtime);
  const dialect = str(ctx.dialect);
  const keyField = str(e.keyField);
  const id = "id: number | string";

  if (op === "list") {
    const listRows = w.use("listRows", runtime);
    const listPage = w.useType("ListPage", runtime);
    const query = w.useType("ListQueryInput", runtime);
    const inReadScope = w.use("inReadScope", runtime);
    const filter = w.use(`${name}FilterAllowlist`, mods.entity);
    const sort = w.use(`${name}SortAllowlist`, mods.entity);
    w.doc(
      `A page of ${name} rows: the filter, search, sort and page of \`query\` (the bracketed tree a`,
      "query string parses to), checked against the allowlists; ordered by the key when it names no sort.",
    );
    w.block(
      `export async function ${fn}(deps: ${deps}, query: ${query} = {}, opts: ${opOptions} = {}): Promise<${opResult}<${listPage}<${row}>>> {`,
      () => {
        w.block(`return ${inReadScope}(deps.db, opts.tx, async (db) => {`, () => {
          objectLiteral(
            w,
            `const spec: ${w.useType("ListSpec", runtime)} = `,
            [`filterAllowlist: ${filter},`, `sortAllowlist: ${sort},`, `dialect: ${dialect},`, `keyField: ${keyField},`, paginationLine(obj, "", ctx.loadedRoot)],
            ";",
          );
          w.line(`return (await ${listRows}(db, ${table}, query, spec)) as ${listPage}<${row}>;`);
        }, "});");
      },
    );
    return w.toString();
  }

  if (op === "get") {
    const inReadScope = w.use("inReadScope", runtime);
    const readOne = w.use("readOne", runtime);
    const keyCondition = w.use("keyCondition", runtime);
    const notFound = w.use("notFound", runtime);
    w.doc(`The ${name} row \`id\` names: \`not_found\` when there is none, \`invalid_id\` when \`id\` is no key.`);
    w.block(`export async function ${fn}(deps: ${deps}, ${id}, opts: ${opOptions} = {}): Promise<${opResult}<${row}>> {`, () => {
      w.block(`return ${inReadScope}(deps.db, opts.tx, async (db) => {`, () => {
        w.line(`const row = await ${readOne}(db, ${table}, ${keyCondition}(${table}, ${keyField}, id));`);
        w.line(`if (row === undefined) ${notFound}();`);
        w.line(`return row as ${row};`);
      }, "});");
    });
    return w.toString();
  }

  const inWriteTransaction = w.use("inWriteTransaction", runtime);
  if (op === "create" || op === "update") {
    const writeRules = w.useType("WriteBodyRules", runtime);
    const validateBody = w.use("validateBody", runtime);
    w.doc("What a write body may name: every other key is refused, a server-owned one dropped.");
    objectLiteral(w, `const writeRules: ${writeRules} = `, [knownFieldsLine(obj, "", ctx.loadedRoot), writeDeniedColumnsLine(obj, "")], ";");
    w.blank();
    if (op === "create") {
      const insertRow = w.use("insertRow", runtime);
      const schema = w.use(`${name}InsertSchema`, mods.contract);
      const input = w.useType(`${name}Create`, mods.contract);
      w.doc(
        `Create a ${name}. In one transaction: validate the input and stamp what the model declares`,
        "(ADR-0045), then insert it and answer the written row.",
      );
      w.block(`export async function ${fn}(deps: ${deps}, input: ${input}, opts: ${opOptions} = {}): Promise<${opResult}<${row}>> {`, () => {
        w.block(`return ${inWriteTransaction}(deps.db, opts.tx, async (tx) => {`, () => {
          w.line(`const values = ${validateBody}(${schema}, input, writeRules);`);
          w.line(`return (await ${insertRow}(tx, ${table}, values, ${dialect}, ${keyField})) as ${row};`);
        }, "});");
      });
      return w.toString();
    }
    const keyCondition = w.use("keyCondition", runtime);
    const loadForWrite = w.use("loadForWrite", runtime);
    const updateRow = w.use("updateRow", runtime);
    const notFound = w.use("notFound", runtime);
    const schema = w.use(`${name}UpdateSchema`, mods.contract);
    const patch = w.useType(`${name}Patch`, mods.contract);
    w.doc(
      `Update the ${name} row \`id\` names with \`patch\`. In one transaction: load the row under a row`,
      "lock (`not_found` when there is none), validate the patch and stamp what the model declares",
      "(ADR-0045), then write it and answer the written row. A patch with nothing to write answers the row.",
    );
    w.block(
      `export async function ${fn}(deps: ${deps}, ${id}, patch: ${patch}, opts: ${opOptions} = {}): Promise<${opResult}<${row}>> {`,
      () => {
        w.block(`return ${inWriteTransaction}(deps.db, opts.tx, async (tx) => {`, () => {
          w.line(`const cond = ${keyCondition}(${table}, ${keyField}, id);`);
          w.line(`const current = await ${loadForWrite}(tx, ${table}, cond, ${dialect});`);
          w.line(`if (current === undefined) ${notFound}();`);
          w.line(`const data: Record<string, unknown> = ${validateBody}(${schema}, patch, writeRules);`);
          w.line(`if (Object.keys(data).length === 0) return current as ${row};`);
          w.line(`const row = await ${updateRow}(tx, ${table}, data, cond, ${dialect});`);
          w.line(`if (row === undefined) ${notFound}();`);
          w.line(`return row as ${row};`);
        }, "});");
      },
    );
    return w.toString();
  }

  const keyCondition = w.use("keyCondition", runtime);
  const loadForWrite = w.use("loadForWrite", runtime);
  const deleteRows = w.use("deleteRows", runtime);
  const notFound = w.use("notFound", runtime);
  w.doc(
    `Delete the ${name} row \`id\` names. In one transaction: load it under a row lock (\`not_found\``,
    "when there is none), then delete it.",
  );
  w.block(`export async function ${fn}(deps: ${deps}, ${id}, opts: ${opOptions} = {}): Promise<${opResult}<void>> {`, () => {
    w.block(`return ${inWriteTransaction}(deps.db, opts.tx, async (tx) => {`, () => {
      w.line(`const cond = ${keyCondition}(${table}, ${keyField}, id);`);
      w.line(`if ((await ${loadForWrite}(tx, ${table}, cond, ${dialect})) === undefined) ${notFound}();`);
      w.line(`await ${deleteRows}(tx, ${table}, cond);`);
    }, "});");
  });
  return w.toString();
}

function renderServiceIndex(pkg: ServicePackage, path: string, ctx: RenderContext): string {
  const w = new TsWriter();
  const label = pkg.package === "" ? "the model's root package" : `package ${pkg.package}`;
  header(w, `${label} — service module (ADR-0067 layer 4)`);
  const runtime = runtimeSpecifierFrom(path, "service", ctx);
  const opOptions = w.useType("OpOptions", runtime);
  const opResult = w.useType("OpResult", runtime);
  const listPage = w.useType("ListPage", runtime);
  const query = w.useType("ListQueryInput", runtime);
  const timestampWire = w.use("timestampWire", runtime);
  const withWire = w.use("withWire", runtime);
  const type = serviceTypeName(pkg.package);
  const { import: dbImport, alias: dbAlias } = dbTypeBlock(ctx.dialect, { asyncOnly: true });

  // The dialect's Drizzle base type, the queries generator's, except that SQLite is async-only:
  // a write awaits inside its transaction callback, which a sync driver (better-sqlite3, bun:sqlite) rejects.
  const dbModule = /from "([^"]+)"/.exec(dbImport)![1]!;
  for (const t of /import type \{ ([^}]+) \}/.exec(dbImport)![1]!.split(",").map((s) => s.trim())) w.useType(t, dbModule);
  w.line(dbAlias);
  w.blank();
  w.doc("What the service needs from the composition root.");
  w.block("export interface ServiceDeps {", () => {
    w.doc("The database every operation runs on. A caller may pass a transaction of its own per call (`opts.tx`).");
    w.line("readonly db: Db;");
  });

  const calls: string[] = [];
  w.blank();
  w.doc(
    `The operations of ${label}. A transport, a job or an agent tool calls these; each answers an`,
    "`OpResult`, and a failure carries the status the REST contract gives its code.",
  );
  w.block(`export interface ${type} {`, () => {
    for (const e of pkg.entities) {
      const mods = modulesOf(path, e.obj, ctx);
      const row = w.useType(e.obj.name, mods.contract);
      const create = w.useType(`${e.obj.name}Create`, mods.contract);
      const patch = w.useType(`${e.obj.name}Patch`, mods.contract);
      const o = e.operations;
      for (const f of Object.values(o)) w.use(f, withExtIfRelative(`./${f}`, ctx.extStyle));
      w.line(`${o.list}(query?: ${query}, opts?: ${opOptions}): Promise<${opResult}<${listPage}<${row}>>>;`);
      w.line(`${o.get}(id: number | string, opts?: ${opOptions}): Promise<${opResult}<${row}>>;`);
      w.line(`${o.create}(input: ${create}, opts?: ${opOptions}): Promise<${opResult}<${row}>>;`);
      w.line(`${o.update}(id: number | string, patch: ${patch}, opts?: ${opOptions}): Promise<${opResult}<${row}>>;`);
      w.line(`${o.delete}(id: number | string, opts?: ${opOptions}): Promise<${opResult}<void>>;`);
      calls.push(
        `${o.list}: (query, opts) => ${o.list}(deps, query, opts),`,
        `${o.get}: (id, opts) => ${o.get}(deps, id, opts),`,
        `${o.create}: (input, opts) => ${o.create}(deps, input, opts),`,
        `${o.update}: (id, patch, opts) => ${o.update}(deps, id, patch, opts),`,
        `${o.delete}: (id, opts) => ${o.delete}(deps, id, opts),`,
      );
    }
  });

  w.blank();
  w.doc(`Bind the operations of ${label} to \`deps\`.`);
  w.block(`export function ${serviceFactoryName(pkg.package)}(deps: ServiceDeps): ${type} {`, () => {
    w.block("return {", () => {
      for (const c of calls) w.line(c);
    }, "};");
  });

  for (const e of pkg.entities) {
    const mods = modulesOf(path, e.obj, ctx);
    const table = w.use(ctx.collectionName(e.obj.name), mods.entity);
    w.blank();
    w.doc(`The wire form (ADR-0019) of a ${e.obj.name} row: what a transport sends.`);
    objectLiteral(w, `export const ${wireMapperName(e.obj.name)} = ${withWire}(${timestampWire}(${table}), `, [decimalColumnsLine(e.obj, "", ctx.loadedRoot)], ");");
  }
  return w.toString();
}

/** The thin Fastify transport of package `pkg`: parse, call the service, send what it answered. */
export function renderFastifyTransport(pkg: ServicePackage, ctx: RenderContext): ServiceFile {
  const path = fastifyTransportPath(pkg.package);
  const w = new TsWriter();
  const label = pkg.package === "" ? "the model's root package" : `package ${pkg.package}`;
  header(w, `${label} — Fastify transport (ADR-0067 layer 5)`);
  const runtime = runtimeSpecifierFrom(path, "service-fastify", ctx);
  const serviceIndex = contractSpecifier(path, servicePath(pkg.package, SERVICE_INDEX_FILE), ctx.extStyle);
  const fastifyInstance = w.useType("FastifyInstance", "fastify");
  const send = w.use("sendOpResult", runtime);
  const handler = w.use("withContractErrorHandler", runtime);
  const parseQuery = w.use("parseListQueryString", runtime);
  const rawQuery = w.use("rawQueryOf", runtime);
  const type = w.useType(serviceTypeName(pkg.package), serviceIndex);
  const routes = serviceRoutesName(pkg.package);

  w.doc("What the routes need: the service they call.");
  w.block(`export interface ${type}RoutesOptions {`, () => {
    w.line(`readonly service: ${type};`);
  });
  w.blank();
  w.doc(
    `Mount the REST routes of ${label}. Each route parses the request, calls one operation of the`,
    "service and sends what it answered; it holds no rules. Register it with the service:",
    `\`app.register(${routes}, { service })\`.`,
  );
  w.block(`export async function ${routes}(fastify: ${fastifyInstance}, opts: ${type}RoutesOptions): Promise<void> {`, () => {
    w.line("const { service } = opts;");
    w.line(`const ro = ${handler}(undefined);`);
    const mount = (app: string) => {
      for (const e of pkg.entities) {
        const mods = modulesOf(path, e.obj, ctx);
        const create = w.useType(`${e.obj.name}Create`, mods.contract);
        const patch = w.useType(`${e.obj.name}Patch`, mods.contract);
        const toWire = w.use(wireMapperName(e.obj.name), serviceIndex);
        const o = e.operations;
        const base = str(restPath(e.obj));
        const item = str(`${restPath(e.obj)}/:id`);
        const params = "{ Params: { id: string } }";
        w.block(`${app}.get(${base}, ro, async (req, reply) => {`, () => {
          w.line(`const result = await service.${o.list}(${parseQuery}(${rawQuery}(req.raw.url)));`);
          w.line(
            `return ${send}(reply, result, 200, (page) => (page.total === undefined ? page.rows.map(${toWire}) : { rows: page.rows.map(${toWire}), total: page.total }));`,
          );
        }, "});");
        w.line(`${app}.get<${params}>(${item}, ro, async (req, reply) => ${send}(reply, await service.${o.get}(req.params.id), 200, ${toWire}));`);
        w.line(`${app}.post(${base}, ro, async (req, reply) => ${send}(reply, await service.${o.create}(req.body as ${create}), 201, ${toWire}));`);
        w.line("// The update is reachable by PATCH and by PUT, as in every port.");
        for (const verb of ["patch", "put"]) {
          w.line(
            `${app}.${verb}<${params}>(${item}, ro, async (req, reply) => ${send}(reply, await service.${o.update}(req.params.id, req.body as ${patch}), 200, ${toWire}));`,
          );
        }
        w.line(`${app}.delete<${params}>(${item}, ro, async (req, reply) => ${send}(reply, await service.${o.delete}(req.params.id), 204));`);
      }
    };
    if (ctx.apiPrefix) {
      w.block("await fastify.register(async (app) => {", () => mount("app"), `}, { prefix: ${str(ctx.apiPrefix)} });`);
    } else {
      mount("fastify");
    }
  });
  return { path, content: w.toString() };
}
