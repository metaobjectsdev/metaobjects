// The service layer (ADR-0067 §1, layer 4) and its thin Fastify transport (layer 5).
//
// A package's service module is a folder of files, one per operation, and an index that declares
// the operations interface and the factory that binds them to their dependencies:
//
//   <pkg>/service/<operation>.ts  — one exported function: `(deps, ...args, opts) => OpResult`
//   <pkg>/service/index.ts        — `ServiceDeps`, the `<Pkg>Service` interface, `create<Pkg>Service`,
//                                   the policy, bodies, hooks and events interfaces hand-written
//                                   code implements, and each entity's wire mapper
//   <pkg>/transport/fastify.ts    — the routes: parse, resolve the actor, call the service, send
//
// Every write operation runs in one transaction (a savepoint inside a caller's), in ADR-0067 §4's
// order: load the row under a row lock, the before hook, validate and stamp the input (ADR-0045),
// the write (or the body, then the guarded update), the after hook, the event hook. A transition or
// a declared command checks in ADR-0066 §6's order: the row (404), the permission point (403), the
// state (409 `invalid_transition`), the body, the guarded update. A refusal anywhere rolls it all
// back. Reads open no write transaction and call no hooks. The mechanics are
// `@metaobjectsdev/runtime-ts/service`; what runs, against which schema and table, is written here.

import type { MetaObject } from "@metaobjectsdev/metadata";
import { GENERATED_EDIT_NOTE, GENERATED_HEADER } from "../constants.js";
import { withExtIfRelative, type RenderContext } from "../render-context.js";
import { decimalColumnsLine, knownFieldsLine, paginationLine, restPath, writeDeniedColumnsLine } from "../api-surface.js";
import { dbTypeBlock } from "../dialect-module.js";
import { contractObjectPath, contractOperationsPath, contractSpecifier } from "../contract-walk.js";
import { toPascalCase } from "../naming.js";
import { DEFAULT_OUTPUT_LAYOUT, entityOutputPath } from "../import-path.js";
import { effectivePackage } from "../docs-paths.js";
import {
  fastifyTransportPath,
  honoTransportPath,
  serviceHonoRoutesName,
  runtimeSpecifierFrom,
  serviceFactoryName,
  serviceTypeName,
  servicePath,
  serviceRoutesName,
  SERVICE_INDEX_FILE,
  type ServiceEntity,
  type ServiceOperation,
  type ServicePackage,
  type ServiceTransition,
  type ServiceTransitionCommand,
} from "../service-walk.js";
import { TsWriter, str } from "../writer/ts-writer.js";
import { CodegenError } from "../errors.js";

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

/** Does the store hold a transaction across application code? (`interactiveTransactions`, default true) */
function interactive(pkg: ServicePackage): boolean {
  return pkg.interactiveTransactions !== false;
}

/** The option a store without interactive transactions is declared with, as the refusal names it. */
export const NO_INTERACTIVE_TX_OPTION = "serviceFile({ interactiveTransactions: false })";

/** The code generation answers a declared command with under that option (ADR-0067 §4). */
export const ERR_STORE_NO_INTERACTIVE_TX = "ERR_STORE_NO_INTERACTIVE_TX";

/** Every file of package `pkg`'s service module. */
export function renderServiceFiles(pkg: ServicePackage, ctx: RenderContext): ServiceFile[] {
  if (!interactive(pkg)) {
    const command = pkg.operations.find((op) => op.kind === "command");
    if (command !== undefined) {
      throw new CodegenError(
        `${ERR_STORE_NO_INTERACTIVE_TX}: ${pkg.package === "" ? "the model's root package" : `package ${pkg.package}`} declares command ` +
          `${command.name}, and ${NO_INTERACTIVE_TX_OPTION} says the store cannot hold a transaction: a command's ` +
          "body runs in its write's transaction, so a refusal after the body wrote could not undo the write. " +
          "Run this package's service on a store with interactive transactions, or declare the operation a query.",
      );
    }
  }
  const files: ServiceFile[] = [];
  for (const e of pkg.entities) {
    for (const op of ["list", "get", "create", "update", "delete"] as const) {
      const path = servicePath(pkg.package, `${e.operations[op]}.ts`);
      files.push({ path, content: renderOperation(op, e, path, ctx, pkg) });
    }
    for (const c of e.commands) {
      const path = servicePath(pkg.package, `${c.fn}.ts`);
      files.push({ path, content: renderTransitionCommand(c, e, path, ctx, pkg) });
    }
  }
  for (const op of pkg.operations) {
    const path = servicePath(pkg.package, `${op.name}.ts`);
    files.push({ path, content: renderDeclaredOperation(op, path, ctx, pkg) });
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
  pkg: ServicePackage,
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
  const deps = `${w.useType("ServiceDeps", indexSpecifier(ctx))}<A>`;
  const opOptions = `${w.useType("OpOptions", runtime)}<A>`;
  const opResult = w.useType("OpResult", runtime);
  const dialect = str(ctx.dialect);
  const lifecycleFields = e.lifecycles.map((l) => l.field);
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
      `export async function ${fn}<A>(deps: ${deps}, query: ${query} = {}, opts: ${opOptions} = {}): Promise<${opResult}<${listPage}<${row}>>> {`,
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
    w.block(`export async function ${fn}<A>(deps: ${deps}, ${id}, opts: ${opOptions} = {}): Promise<${opResult}<${row}>> {`, () => {
      w.block(`return ${inReadScope}(deps.db, opts.tx, async (db) => {`, () => {
        w.line(`const row = await ${readOne}(db, ${table}, ${keyCondition}(${table}, ${keyField}, id));`);
        w.line(`if (row === undefined) ${notFound}();`);
        w.line(`return row as ${row};`);
      }, "});");
    });
    return w.toString();
  }

  // Under `interactiveTransactions: false` a write opens no transaction and has no hooks or event
  // hook to run inside one (ADR-0067 §4): it is its one statement, after the load and the checks.
  const tx = interactive(pkg);
  const inWriteTransaction = tx ? w.use("inWriteTransaction", runtime) : w.use("withoutTransaction", runtime);
  const inOne = tx ? "In one transaction:" : "With no transaction (`interactiveTransactions: false`):";
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
        ...(tx
          ? [
              `Create a ${name}. ${inOne} the before hook (it may replace the input or refuse),`,
              "validate the input and stamp what the model declares (ADR-0045), insert it, the after hook",
              "and the event hook; answer the written row.",
            ]
          : [`Create a ${name}. ${inOne} validate the input and stamp what the model declares`, "(ADR-0045), insert it; answer the written row."]),
      );
      w.block(`export async function ${fn}<A>(deps: ${deps}, input: ${input}, opts: ${opOptions} = {}): Promise<${opResult}<${row}>> {`, () => {
        w.block(`return ${inWriteTransaction}(deps.db, opts.tx, async (tx) => {`, () => {
          if (tx) {
            w.line(`const ctx = ${w.use("handlerContext", runtime)}(tx, opts.actor);`);
            w.line(`const given = (await deps.hooks?.before${toPascalCase(fn)}?.(input, ctx)) ?? input;`);
          } else w.line("const given = input;");
          w.line(`const values: Record<string, unknown> = ${validateBody}(${schema}, given, writeRules);`);
          if (e.lifecycles.length > 0) {
            if (pkg.settings.lifecycleCreate === "initial") {
              const initials = e.lifecycles.map((l) => `${l.field}: ${str(l.initial ?? "")}`).join(", ");
              w.line(`// rules.lifecycle.create: "initial" — a create starts each lifecycle in its initial state.`);
              w.line(`${w.use("checkCreateState", runtime)}(values, { ${initials} });`);
            } else {
              w.line(`// rules.lifecycle.create: "any" — a create may start a lifecycle in any of its states.`);
            }
          }
          w.line(`const row = (await ${insertRow}(tx, ${table}, values, ${dialect}, ${keyField})) as ${row};`);
          if (tx) {
            w.line(`await deps.hooks?.after${toPascalCase(fn)}?.(row, ctx);`);
            w.line(
              `await ${w.use("emitWrite", runtime)}(deps.events, { kind: "create", entity: ${str(name)}, key: row.${e.keyField}, row, actor: opts.actor, at: new Date() }, tx);`,
            );
          }
          w.line("return row;");
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
      ...(tx
        ? [
            `Update the ${name} row \`id\` names with \`patch\`. ${inOne} load the row under a row`,
            "lock (`not_found` when there is none), the before hook, validate the patch and stamp what the",
            "model declares (ADR-0045), write it, the after hook and the event hook; answer the written row.",
            "A patch with nothing to write answers the row and calls no after or event hook.",
          ]
        : [
            `Update the ${name} row \`id\` names with \`patch\`. ${inOne} load the row`,
            "(`not_found` when there is none), validate the patch and stamp what the model declares",
            "(ADR-0045), write it; answer the written row. A patch with nothing to write answers the row.",
          ]),
    );
    w.block(
      `export async function ${fn}<A>(deps: ${deps}, ${id}, patch: ${patch}, opts: ${opOptions} = {}): Promise<${opResult}<${row}>> {`,
      () => {
        w.block(`return ${inWriteTransaction}(deps.db, opts.tx, async (tx) => {`, () => {
          w.line(`const cond = ${keyCondition}(${table}, ${keyField}, id);`);
          w.line(`const current = (await ${loadForWrite}(tx, ${table}, cond, ${dialect})) as ${row} | undefined;`);
          w.line(`if (current === undefined) ${notFound}();`);
          if (tx) {
            w.line(`const ctx = ${w.use("handlerContext", runtime)}(tx, opts.actor);`);
            w.line(`const given = (await deps.hooks?.before${toPascalCase(fn)}?.(patch, current, ctx)) ?? patch;`);
          } else w.line("const given = patch;");
          w.line(`const data: Record<string, unknown> = ${validateBody}(${schema}, given, writeRules);`);
          if (lifecycleFields.length > 0) {
            w.line("// A lifecycle moves only through its transitions (ADR-0066 §6 step 7).");
            w.line(`${w.use("checkStateManaged", runtime)}(data, current, ${JSON.stringify(lifecycleFields)});`);
          }
          w.line("if (Object.keys(data).length === 0) return current;");
          w.line(`const row = (await ${updateRow}(tx, ${table}, data, cond, ${dialect})) as ${row} | undefined;`);
          w.line(`if (row === undefined) ${notFound}();`);
          if (tx) {
            w.line(`await deps.hooks?.after${toPascalCase(fn)}?.(row, current, ctx);`);
            w.line(
              `await ${w.use("emitWrite", runtime)}(deps.events, { kind: "update", entity: ${str(name)}, key: row.${e.keyField}, row, previous: current, actor: opts.actor, at: new Date() }, tx);`,
            );
          }
          w.line("return row;");
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
    ...(tx
      ? [
          `Delete the ${name} row \`id\` names. ${inOne} load it under a row lock (\`not_found\``,
          "when there is none), the before hook, the delete, the after hook and the event hook.",
        ]
      : [`Delete the ${name} row \`id\` names. ${inOne} load it (\`not_found\` when there is`, "none), then the delete."]),
  );
  w.block(`export async function ${fn}<A>(deps: ${deps}, ${id}, opts: ${opOptions} = {}): Promise<${opResult}<void>> {`, () => {
    w.block(`return ${inWriteTransaction}(deps.db, opts.tx, async (tx) => {`, () => {
      w.line(`const cond = ${keyCondition}(${table}, ${keyField}, id);`);
      w.line(`const current = (await ${loadForWrite}(tx, ${table}, cond, ${dialect})) as ${row} | undefined;`);
      w.line(`if (current === undefined) ${notFound}();`);
      if (!tx) {
        w.line(`await ${deleteRows}(tx, ${table}, cond);`);
        return;
      }
      w.line(`const ctx = ${w.use("handlerContext", runtime)}(tx, opts.actor);`);
      w.line(`await deps.hooks?.before${toPascalCase(fn)}?.(current, ctx);`);
      w.line(`await ${deleteRows}(tx, ${table}, cond);`);
      w.line(`await deps.hooks?.after${toPascalCase(fn)}?.(current, ctx);`);
      w.line(
        `await ${w.use("emitWrite", runtime)}(deps.events, { kind: "delete", entity: ${str(name)}, key: current.${e.keyField}, row: current, actor: opts.actor, at: new Date() }, tx);`,
      );
    }, "});");
  });
  return w.toString();
}

/** The specifier of the package's service index, from a file in the same folder. */
function indexSpecifier(ctx: RenderContext): string {
  return withExtIfRelative(`./${SERVICE_INDEX_FILE.replace(/\.ts$/, "")}`, ctx.extStyle);
}

/** The specifier of the package's operations contract (`operations.contract.ts`), from `path`. */
function operationsSpecifier(path: string, pkg: ServicePackage, ctx: RenderContext): string {
  return contractSpecifier(path, contractOperationsPath(pkg.package), ctx.extStyle);
}

/** The move as the runtime's `TransitionSpec` literal. */
function transitionLiteral(t: ServiceTransition): string {
  const condition = t.condition === undefined ? "" : `, condition: ${JSON.stringify(t.condition)}`;
  return `{ name: ${str(t.name)}, field: ${str(t.field)}, from: ${JSON.stringify(t.from)}, to: ${str(t.to)}${condition} }`;
}

/** The type of a declared operation's input after validation: the contract's input schema's output. */
function inputType(w: TsWriter, op: ServiceOperation, path: string, pkg: ServicePackage, ctx: RenderContext): string {
  const z = w.useType("z", "zod");
  const schema = w.useType(`${toPascalCase(op.name)}InputSchema`, operationsSpecifier(path, pkg, ctx));
  return `${z}.output<typeof ${schema}>`;
}

/** The type a caller passes as a declared operation's input: the contract's, less a key the path carries. */
function callerInputType(w: TsWriter, op: ServiceOperation, path: string, pkg: ServicePackage, ctx: RenderContext): string {
  const t = w.useType(`${toPascalCase(op.name)}Input`, operationsSpecifier(path, pkg, ctx));
  return op.inputKeyField === undefined ? t : `Omit<${t}, ${str(op.inputKeyField)}>`;
}

/** What a declared operation answers: the target's row, the declared output, or nothing. */
function outputType(w: TsWriter, op: ServiceOperation, path: string, pkg: ServicePackage, ctx: RenderContext): string {
  if (outputIsTargetRow(op)) return w.useType(op.target!.obj.name, modulesOf(path, op.target!.obj, ctx).contract);
  if (op.output !== undefined) return w.useType(`${toPascalCase(op.name)}Output`, operationsSpecifier(path, pkg, ctx));
  return op.kind === "query" ? "unknown" : "void";
}

/** A command whose `@outputRef` is its target answers the target's row as the command left it. */
function outputIsTargetRow(op: ServiceOperation): boolean {
  return op.kind === "command" && op.target !== undefined && op.output === op.target.obj;
}

/** What a declared operation's body returns (ADR-0066 §6 step 4). */
function outcomeType(op: ServiceOperation, output: string): string {
  const moves = op.transitions.length === 0 ? undefined : [...op.transitions.map((t) => str(t.name)), str("none")].join(" | ");
  const bodyOutput = op.kind === "query" || (op.output !== undefined && !outputIsTargetRow(op)) ? output : undefined;
  if (moves !== undefined && bodyOutput !== undefined) return `{ readonly transition: ${moves}; readonly output: ${bodyOutput} }`;
  return moves ?? bodyOutput ?? "void";
}

/** The parameters a declared operation takes, before `opts`, as `name: type` pairs. */
function operationParams(w: TsWriter, op: ServiceOperation, path: string, pkg: ServicePackage, ctx: RenderContext): string[] {
  const params: string[] = [];
  if (op.keyed) params.push("id: number | string");
  if (op.input !== undefined) params.push(`input: ${callerInputType(w, op, path, pkg, ctx)}`);
  if (op.kind === "query" && op.many) params.push(`query: ${w.useType("ListQueryInput", runtimeSpecifierFrom(path, "service", ctx))}`);
  return params;
}

/** The derived command of a transition (ADR-0066 §2): it takes the key and makes the move. */
function renderTransitionCommand(c: ServiceTransitionCommand, e: ServiceEntity, path: string, ctx: RenderContext, pkg: ServicePackage): string {
  const obj = e.obj;
  const name = obj.name;
  const t = c.transition;
  const w = new TsWriter();
  header(w, `${name} (${obj.fqn()}) — transition ${t.field}.${t.name}, service operation ${c.fn} (ADR-0066 §2)`);
  const runtime = runtimeSpecifierFrom(path, "service", ctx);
  const mods = modulesOf(path, obj, ctx);
  const table = w.use(ctx.collectionName(name), mods.entity);
  const row = w.useType(name, mods.contract);
  const deps = `${w.useType("ServiceDeps", indexSpecifier(ctx))}<A>`;
  const opOptions = `${w.useType("OpOptions", runtime)}<A>`;
  const opResult = w.useType("OpResult", runtime);
  const dialect = str(ctx.dialect);
  const spec = w.useType("TransitionSpec", runtime);
  w.doc(`\`${t.field}\`: ${t.from.join(", ")} → ${t.to}.`);
  w.line(`const move: ${spec} = ${transitionLiteral(t)};`);
  w.blank();
  const inTx = interactive(pkg);
  w.doc(
    ...(inTx
      ? [
          `Make the ${name} row \`id\` names move \`${t.name}\`. In one transaction, in ADR-0066 §6's order: load it`,
          "under a row lock (`not_found`), the permission point (`forbidden`), the state check",
          "(`invalid_transition`), the guarded update (`invalid_transition` or",
          "`transition_condition_failed` when it matches no row), the event hook. Answers the written row.",
        ]
      : [
          `Make the ${name} row \`id\` names move \`${t.name}\`. With no transaction (\`interactiveTransactions: false\`),`,
          "in ADR-0066 §6's order: load it (`not_found`), the permission point (`forbidden`), the state check",
          "(`invalid_transition`), the guarded update, which holds on its own (`invalid_transition` or",
          "`transition_condition_failed` when it matches no row). Answers the written row.",
        ]),
  );
  w.block(`export async function ${c.fn}<A>(deps: ${deps}, id: number | string, opts: ${opOptions} = {}): Promise<${opResult}<${row}>> {`, () => {
    w.block(`return ${w.use(inTx ? "inWriteTransaction" : "withoutTransaction", runtime)}(deps.db, opts.tx, async (tx) => {`, () => {
      w.line(`const cond = ${w.use("keyCondition", runtime)}(${table}, ${str(e.keyField)}, id);`);
      w.line(`const current = (await ${w.use("loadForWrite", runtime)}(tx, ${table}, cond, ${dialect})) as ${row} | undefined;`);
      w.line(`if (current === undefined) ${w.use("notFound", runtime)}();`);
      if (c.permission === undefined) w.line("// @public: the policy is not asked.");
      else w.line(`await ${w.use("checkPermission", runtime)}(deps.policy, ${str(c.permission)}, opts.actor, current, undefined, tx);`);
      w.line(`${w.use("checkState", runtime)}(current, [move]);`);
      w.line(`const row = (await ${w.use("makeTransition", runtime)}(tx, ${table}, cond, move, ${dialect})) as ${row};`);
      if (inTx) {
        w.line(
          `await ${w.use("emitWrite", runtime)}(deps.events, { kind: "transition", entity: ${str(name)}, key: current.${e.keyField}, lifecycle: move.field, transition: move.name, from: String(current.${t.field}), to: move.to, operation: ${str(c.fn)}, actor: opts.actor, at: new Date() }, tx);`,
        );
      }
      w.line("return row;");
    }, "});");
  });
  return w.toString();
}

/** A declared command or query (ADR-0066 §1): the shell around its hand-written body. */
function renderDeclaredOperation(op: ServiceOperation, path: string, ctx: RenderContext, pkg: ServicePackage): string {
  if (op.transitions.length > 0 && !op.keyed) {
    throw new Error(`service: command ${op.name} lists @transitions but addresses no row by key, so it has no row to move`);
  }
  const w = new TsWriter();
  header(w, `${pkg.package === "" ? "the model" : pkg.package} — ${op.kind} ${op.name}, a service operation (ADR-0066 §1)`);
  const runtime = runtimeSpecifierFrom(path, "service", ctx);
  const deps = `${w.useType("ServiceDeps", indexSpecifier(ctx))}<A>`;
  const opOptions = `${w.useType("OpOptions", runtime)}<A>`;
  const opResult = w.useType("OpResult", runtime);
  const dialect = str(ctx.dialect);
  const target = op.target;
  // The target's table and row type, imported only by an operation that reads or answers its row.
  const usesRow = op.keyed || outputIsTargetRow(op);
  const mods = target === undefined || !usesRow ? undefined : modulesOf(path, target.obj, ctx);
  const table = mods === undefined ? undefined : w.use(ctx.collectionName(target!.obj.name), mods.entity);
  const row = mods === undefined ? undefined : w.useType(target!.obj.name, mods.contract);
  const output = outputType(w, op, path, pkg, ctx);
  const params = [...operationParams(w, op, path, pkg, ctx), `opts: ${opOptions} = {}`];
  const command = op.kind === "command";

  if (op.input !== undefined) {
    w.doc("What the input may name: every other key is refused.");
    objectLiteral(w, `const inputRules: ${w.useType("WriteBodyRules", runtime)} = `, [knownFieldsLine(op.input, "", ctx.loadedRoot)], ";");
    w.blank();
  }
  if (op.transitions.length > 0) {
    const spec = w.useType("TransitionSpec", runtime);
    w.doc("The moves the command may make (`@transitions`).");
    w.block(`const moves: Record<string, ${spec}> = {`, () => {
      for (const t of op.transitions) w.line(`${t.name}: ${transitionLiteral(t)},`);
    }, "};");
    w.blank();
  }
  const steps = [
    ...(op.keyed ? [command ? "load the target row under a row lock (`not_found`)" : "read the target row (`not_found`)"] : []),
    ...(op.input !== undefined ? ["validate the input"] : []),
    op.permission === undefined ? "no permission point (it is `@public`)" : "the permission point (`forbidden`)",
    ...(op.transitions.length > 0 ? ["the state check (`invalid_transition`)"] : []),
    "the body",
    ...(op.transitions.length > 0 ? ["the guarded update"] : []),
    ...(command ? ["the event hook"] : []),
  ];
  w.doc(
    command
      ? `\`${op.name}\` (command). In one transaction, in ADR-0066 §6's order:`
      : `\`${op.name}\` (query). In the read scope, opening no write transaction:`,
    `${steps.join(", ")}.`,
  );
  w.block(`export async function ${op.name}<A>(deps: ${deps}, ${params.join(", ")}): Promise<${opResult}<${output}>> {`, () => {
    const scope = command ? w.use("inWriteTransaction", runtime) : w.use("inReadScope", runtime);
    w.block(`return ${scope}(deps.db, opts.tx, async (tx) => {`, () => {
      if (op.keyed) {
        w.line(`const cond = ${w.use("keyCondition", runtime)}(${table}, ${str(target!.keyField)}, id);`);
        const load = command
          ? `await ${w.use("loadForWrite", runtime)}(tx, ${table}, cond, ${dialect})`
          : `await ${w.use("readOne", runtime)}(tx, ${table}, cond)`;
        w.line(`const current = (${load}) as ${row} | undefined;`);
        w.line(`if (current === undefined) ${w.use("notFound", runtime)}();`);
      }
      let values = "undefined";
      if (op.input !== undefined) {
        const schema = w.use(`${toPascalCase(op.name)}InputSchema`, operationsSpecifier(path, pkg, ctx));
        const given = op.inputKeyField === undefined ? "input" : `{ ...input, ${op.inputKeyField}: current.${target!.keyField} }`;
        w.line(`const values: ${inputType(w, op, path, pkg, ctx)} = ${w.use("validateBody", runtime)}(${schema}, ${given}, inputRules);`);
        values = "values";
      }
      const rowArg = op.keyed ? "current" : "undefined";
      if (op.permission === undefined) w.line("// @public: the policy is not asked.");
      else w.line(`await ${w.use("checkPermission", runtime)}(deps.policy, ${str(op.permission)}, opts.actor, ${rowArg}, ${values}, tx);`);
      if (op.transitions.length > 0) w.line(`${w.use("checkState", runtime)}(current, Object.values(moves));`);
      const bodyArgs = [
        ...(op.input !== undefined ? ["values"] : []),
        ...(op.kind === "query" && op.many ? ["query"] : []),
        op.keyed ? `{ ...${w.use("handlerContext", runtime)}(tx, opts.actor), row: current }` : `${w.use("handlerContext", runtime)}(tx, opts.actor)`,
      ];
      const call = `await deps.bodies.${op.name}(${bodyArgs.join(", ")})`;
      if (!command) {
        w.line(`return ${call};`);
        return;
      }
      w.line(`const outcome = ${call};`);
      const emit = w.use("emitWrite", runtime);
      const entity = target === undefined ? "undefined" : str(target.obj.name);
      const key = op.keyed ? `current.${target!.keyField}` : "undefined";
      const commandEvent = `await ${emit}(deps.events, { kind: "command", operation: ${str(op.name)}, entity: ${entity}, key: ${key}, actor: opts.actor, at: new Date() }, tx);`;
      if (op.transitions.length > 0) {
        const both = op.output !== undefined && !outputIsTargetRow(op);
        w.line(`const made = ${both ? "outcome.transition" : "outcome"};`);
        w.block(`if (made === "none") {`, () => w.line(commandEvent));
        w.block(`if (made !== "none") {`, () => {
          w.line("const move = moves[made]!;");
          w.line(`await ${w.use("makeTransition", runtime)}(tx, ${table}, cond, move, ${dialect});`);
          w.line(
            `await ${emit}(deps.events, { kind: "transition", entity: ${entity}, key: ${key}, lifecycle: move.field, transition: move.name, from: String(current[move.field as keyof typeof current]), to: move.to, operation: ${str(op.name)}, actor: opts.actor, at: new Date() }, tx);`,
          );
        });
        if (outputIsTargetRow(op)) w.line(`return (await ${w.use("readOne", runtime)}(tx, ${table}, cond)) as ${row};`);
        else if (both) w.line("return outcome.output;");
        return;
      }
      w.line(commandEvent);
      if (outputIsTargetRow(op)) w.line(`return (await ${w.use("readOne", runtime)}(tx, ${table}, cond)) as ${row};`);
      else if (op.output !== undefined) w.line("return outcome;");
    }, "});");
  });
  return w.toString();
}

function renderServiceIndex(pkg: ServicePackage, path: string, ctx: RenderContext): string {
  const w = new TsWriter();
  const label = pkg.package === "" ? "the model's root package" : `package ${pkg.package}`;
  header(w, `${label} — service module (ADR-0067 layer 4)`);
  const runtime = runtimeSpecifierFrom(path, "service", ctx);
  const opOptions = `${w.useType("OpOptions", runtime)}<A>`;
  const opResult = w.useType("OpResult", runtime);
  const listPage = w.useType("ListPage", runtime);
  const query = w.useType("ListQueryInput", runtime);
  const type = serviceTypeName(pkg.package);
  const stem = type.replace(/Service$/, "");
  const { import: dbImport, alias: dbAlias } = dbTypeBlock(ctx.dialect);

  // The dialect's Drizzle base type, the queries generator's. A sync SQLite driver (bun:sqlite,
  // better-sqlite3) is accepted: the runtime drives its transaction with statements.
  const dbModule = /from "([^"]+)"/.exec(dbImport)![1]!;
  for (const t of /import type \{ ([^}]+) \}/.exec(dbImport)![1]!.split(",").map((s) => s.trim())) w.useType(t, dbModule);
  w.line(dbAlias);

  const hasPolicy = pkg.permissions.length > 0;
  const hasBodies = pkg.operations.length > 0;
  if (hasPolicy) {
    w.blank();
    w.doc("Every permission a point of the package asks the policy about (ADR-0066 §1).");
    w.line(`export type ${stem}Permission = ${pkg.permissions.map(str).join(" | ")};`);
    w.blank();
    w.doc(
      "The policy: whether the actor may pass a permission point, given the loaded row and the input.",
      "Asked before anything is written; refusing answers 403 `forbidden`. Who holds a permission is data,",
      "and what the policy decides is code: implement it, and pass it in `deps.policy`.",
    );
    w.line(`export type ${stem}Policy<A> = ${w.useType("Policy", runtime)}<${stem}Permission, A, Db>;`);
  }

  // Under `interactiveTransactions: false` there are no hooks and no event hook: each would run in
  // the write's transaction, and the store holds none (ADR-0067 §4).
  if (interactive(pkg)) {
    const hookContext = `${w.useType("HookContext", runtime)}<A, Db>`;
    w.blank();
    w.doc(
      "Hooks on the derived writes, all optional: an absent hook does nothing. Each runs in the write's",
      "transaction (`ctx.tx`); a before hook may return a replacement input, and any hook may refuse",
      "(`ctx.refuse(code)`, 409), which rolls the whole write back.",
    );
    w.block(`export interface ${stem}Hooks<A> {`, () => {
      for (const e of pkg.entities) {
        const mods = modulesOf(path, e.obj, ctx);
        const row = w.useType(e.obj.name, mods.contract);
        const create = w.useType(`${e.obj.name}Create`, mods.contract);
        const patch = w.useType(`${e.obj.name}Patch`, mods.contract);
        const o = e.operations;
        const P = (f: string) => toPascalCase(f);
        w.line(`before${P(o.create)}?(input: ${create}, ctx: ${hookContext}): ${create} | void | Promise<${create} | void>;`);
        w.line(`after${P(o.create)}?(row: ${row}, ctx: ${hookContext}): void | Promise<void>;`);
        w.line(`before${P(o.update)}?(patch: ${patch}, current: ${row}, ctx: ${hookContext}): ${patch} | void | Promise<${patch} | void>;`);
        w.line(`after${P(o.update)}?(row: ${row}, previous: ${row}, ctx: ${hookContext}): void | Promise<void>;`);
        w.line(`before${P(o.delete)}?(current: ${row}, ctx: ${hookContext}): void | Promise<void>;`);
        w.line(`after${P(o.delete)}?(row: ${row}, ctx: ${hookContext}): void | Promise<void>;`);
      }
    });

    w.blank();
    w.doc(
      "The write-event hook: told about every write, in its transaction, with the actor (ADR-0066 §7).",
      "An outbox, a history table or an audit log is written here. Absent, nothing is told.",
    );
    w.line(`export type ${stem}Events<A> = ${w.useType("WriteEvents", runtime)}<A, Db>;`);
  }

  if (hasBodies) {
    w.blank();
    w.doc(
      "The hand-written bodies of the declared operations. The shell calls each inside its guarantee,",
      "after the row, the input and the permission point are checked: a command's body in the write",
      "transaction, a query's in the read scope. A command with `@transitions` returns the move to make",
      "or `\"none\"`; `ctx.refuse(code)` answers one of its `@errors` (409) and rolls everything back.",
    );
    w.block(`export interface ${stem}Bodies<A> {`, () => {
      for (const op of pkg.operations) {
        const output = outputType(w, op, path, pkg, ctx);
        const outcome = outcomeType(op, output);
        const errors = op.errors.length === 0 ? "never" : w.useType(`${toPascalCase(op.name)}BusinessError`, operationsSpecifier(path, pkg, ctx));
        const bodyCtx = `${w.useType("BodyContext", runtime)}<A, Db, ${errors}>`;
        const rowType = op.keyed ? w.useType(op.target!.obj.name, modulesOf(path, op.target!.obj, ctx).contract) : undefined;
        const ctxType = rowType === undefined ? bodyCtx : `${bodyCtx} & { readonly row: ${rowType} }`;
        const args = [
          ...(op.input !== undefined ? [`input: ${inputType(w, op, path, pkg, ctx)}`] : []),
          ...(op.kind === "query" && op.many ? [`query: ${query}`] : []),
          `ctx: ${ctxType}`,
        ];
        w.line(`${op.name}(${args.join(", ")}): ${outcome} | Promise<${outcome}>;`);
      }
    });
  }

  w.blank();
  w.doc("What the service needs from the composition root. `A` is the app's actor type (ADR-0067 §7).");
  w.block("export interface ServiceDeps<A = unknown> {", () => {
    w.doc("The database every operation runs on. A caller may pass a transaction of its own per call (`opts.tx`).");
    w.line("readonly db: Db;");
    if (hasPolicy) w.line(`readonly policy: ${stem}Policy<A>;`);
    if (hasBodies) w.line(`readonly bodies: ${stem}Bodies<A>;`);
    if (interactive(pkg)) {
      w.line(`readonly hooks?: ${stem}Hooks<A>;`);
      w.line(`readonly events?: ${stem}Events<A>;`);
    }
  });

  const calls: string[] = [];
  w.blank();
  w.doc(
    `The operations of ${label}. A transport, a job or an agent tool calls these; each answers an`,
    "`OpResult`, and a failure carries the status the REST contract gives its code.",
  );
  w.block(`export interface ${type}<A = unknown> {`, () => {
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
      for (const c of e.commands) {
        w.use(c.fn, withExtIfRelative(`./${c.fn}`, ctx.extStyle));
        w.line(`${c.fn}(id: number | string, opts?: ${opOptions}): Promise<${opResult}<${row}>>;`);
        calls.push(`${c.fn}: (id, opts) => ${c.fn}(deps, id, opts),`);
      }
    }
    for (const op of pkg.operations) {
      w.use(op.name, withExtIfRelative(`./${op.name}`, ctx.extStyle));
      const params = operationParams(w, op, path, pkg, ctx);
      const names = params.map((p) => p.slice(0, p.indexOf(":")));
      w.line(`${op.name}(${[...params, `opts?: ${opOptions}`].join(", ")}): Promise<${opResult}<${outputType(w, op, path, pkg, ctx)}>>;`);
      calls.push(`${op.name}: (${[...names, "opts"].join(", ")}) => ${op.name}(deps, ${[...names, "opts"].join(", ")}),`);
    }
  });

  w.blank();
  w.doc(`Bind the operations of ${label} to \`deps\`.`);
  w.block(`export function ${serviceFactoryName(pkg.package)}<A = unknown>(deps: ServiceDeps<A>): ${type}<A> {`, () => {
    w.block("return {", () => {
      for (const c of calls) w.line(c);
    }, "};");
  });

  for (const e of pkg.entities) {
    const mods = modulesOf(path, e.obj, ctx);
    const table = w.use(ctx.collectionName(e.obj.name), mods.entity);
    w.blank();
    w.doc(`The wire form (ADR-0019) of a ${e.obj.name} row: what a transport sends.`);
    objectLiteral(w, `export const ${wireMapperName(e.obj.name)} = ${w.use("withWire", runtime)}(${w.use("timestampWire", runtime)}(${table}), `, [decimalColumnsLine(e.obj, "", ctx.loadedRoot)], ");");
  }
  return w.toString();
}

/** One route the transport mounts: its method and Fastify path, before the API prefix. */
interface MountedRoute {
  readonly method: string;
  readonly path: string;
  readonly what: string;
}

/**
 * Refuse two routes on one method and path (placeholder names ignored): a declared binding on a
 * derived CRUD route, or two derived paths that meet (ADR-0066 §5: the transport generator that
 * mounts the routes refuses a collision the loader cannot see).
 */
function refuseRouteCollisions(routes: readonly MountedRoute[]): void {
  const seen = new Map<string, string>();
  for (const r of routes) {
    const key = `${r.method} ${r.path.replace(/:[^/]+/g, ":")}`;
    const prior = seen.get(key);
    if (prior !== undefined) throw new Error(`service-routes: ${r.what} and ${prior} are both mounted on ${r.method} ${r.path}`);
    seen.set(key, r.what);
  }
}

/** Every route a transport of package `pkg` mounts, before the API prefix. */
function transportRoutes(pkg: ServicePackage): MountedRoute[] {
  const mounted: MountedRoute[] = [];
  for (const e of pkg.entities) {
    const base = restPath(e.obj);
    const item = `${base}/:id`;
    mounted.push(
      { method: "GET", path: base, what: `${e.obj.name} list` },
      { method: "GET", path: item, what: `${e.obj.name} get` },
      { method: "POST", path: base, what: `${e.obj.name} create` },
      { method: "PATCH", path: item, what: `${e.obj.name} update` },
      { method: "PUT", path: item, what: `${e.obj.name} update` },
      { method: "DELETE", path: item, what: `${e.obj.name} delete` },
    );
    for (const c of e.commands) mounted.push({ method: "POST", path: `${item}/${c.transition.name}`, what: `transition ${e.obj.name}.${c.transition.name}` });
  }
  for (const op of pkg.operations) mounted.push({ method: op.method, path: op.path, what: `operation ${op.name}` });
  return mounted;
}

/** The thin Fastify transport of package `pkg`: parse, resolve the actor, call the service, send what it answered. */
export function renderFastifyTransport(pkg: ServicePackage, ctx: RenderContext): ServiceFile {
  const path = fastifyTransportPath(pkg.package);
  const w = new TsWriter();
  const label = pkg.package === "" ? "the model's root package" : `package ${pkg.package}`;
  header(w, `${label} — Fastify transport (ADR-0067 layer 5)`);
  const runtime = runtimeSpecifierFrom(path, "service-fastify", ctx);
  const serviceRuntime = runtimeSpecifierFrom(path, "service", ctx);
  const serviceIndex = contractSpecifier(path, servicePath(pkg.package, SERVICE_INDEX_FILE), ctx.extStyle);
  const fastifyInstance = w.useType("FastifyInstance", "fastify");
  const fastifyRequest = w.useType("FastifyRequest", "fastify");
  const send = w.use("sendOpResult", runtime);
  const handler = w.use("withContractErrorHandler", runtime);
  const parseQuery = w.use("parseListQueryString", runtime);
  const rawQuery = w.use("rawQueryOf", runtime);
  const type = w.useType(serviceTypeName(pkg.package), serviceIndex);
  const routes = serviceRoutesName(pkg.package);

  refuseRouteCollisions(transportRoutes(pkg));

  w.doc("What the routes need: the service they call, and who is calling.");
  w.block(`export interface ${type}RoutesOptions<A = unknown> {`, () => {
    w.line(`readonly service: ${type}<A>;`);
    w.doc(
      "Who a request is for (ADR-0067 §7): the app's own resolver, from its own authentication. The",
      "service never looks inside the actor; it hands it to the policy, the bodies, the hooks and the",
      "event hook. Absent, every operation runs with no actor, which a policy may refuse.",
    );
    w.line(`readonly getActor?: (request: ${fastifyRequest}) => A | undefined | Promise<A | undefined>;`);
  });
  w.blank();
  w.doc(
    `Mount the REST routes of ${label}. Each route parses the request, resolves the actor, calls one`,
    "operation of the service and sends what it answered; it holds no rules. Register it with the",
    `service: \`app.register(${routes}, { service, getActor })\`.`,
  );
  w.block(`export async function ${routes}<A = unknown>(fastify: ${fastifyInstance}, opts: ${type}RoutesOptions<A>): Promise<void> {`, () => {
    w.line("const { service } = opts;");
    w.line(`const actorOf = async (req: ${fastifyRequest}): Promise<${w.useType("OpOptions", serviceRuntime)}<A>> => ({ actor: (await opts.getActor?.(req)) as A | undefined });`);
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
          w.line(`const result = await service.${o.list}(${parseQuery}(${rawQuery}(req.raw.url)), await actorOf(req));`);
          w.line(
            `return ${send}(reply, result, 200, (page) => (page.total === undefined ? page.rows.map(${toWire}) : { rows: page.rows.map(${toWire}), total: page.total }));`,
          );
        }, "});");
        w.line(`${app}.get<${params}>(${item}, ro, async (req, reply) => ${send}(reply, await service.${o.get}(req.params.id, await actorOf(req)), 200, ${toWire}));`);
        w.line(`${app}.post(${base}, ro, async (req, reply) => ${send}(reply, await service.${o.create}(req.body as ${create}, await actorOf(req)), 201, ${toWire}));`);
        w.line("// The update is reachable by PATCH and by PUT, as in every port.");
        for (const verb of ["patch", "put"]) {
          w.line(
            `${app}.${verb}<${params}>(${item}, ro, async (req, reply) => ${send}(reply, await service.${o.update}(req.params.id, req.body as ${patch}, await actorOf(req)), 200, ${toWire}));`,
          );
        }
        w.line(`${app}.delete<${params}>(${item}, ro, async (req, reply) => ${send}(reply, await service.${o.delete}(req.params.id, await actorOf(req)), 204));`);
        for (const c of e.commands) {
          w.line(
            `${app}.post<${params}>(${str(`${restPath(e.obj)}/:id/${c.transition.name}`)}, ro, async (req, reply) => ${send}(reply, await service.${c.fn}(req.params.id, await actorOf(req)), 200, ${toWire}));`,
          );
        }
      }
      for (const op of pkg.operations) {
        const key = op.keyed ? op.target!.keyField : undefined;
        const generic = key === undefined ? "" : `<{ Params: { ${key}: string } }>`;
        const fromGet = op.method === "GET" || op.method === "DELETE";
        const args = [
          ...(key === undefined ? [] : [`req.params.${key}`]),
          ...(op.input !== undefined ? [`(${fromGet ? "req.query" : "req.body ?? {}"}) as never`] : []),
          ...(op.kind === "query" && op.many ? [`${parseQuery}(${rawQuery}(req.raw.url))`] : []),
          "await actorOf(req)",
        ];
        const result = `await service.${op.name}(${args.join(", ")})`;
        const wire = outputIsTargetRow(op) ? `, ${w.use(wireMapperName(op.target!.obj.name), serviceIndex)}` : "";
        const status = op.output === undefined && op.kind === "command" ? "204" : "200";
        w.line(`${app}.${op.method.toLowerCase()}${generic}(${str(op.path)}, ro, async (req, reply) => ${send}(reply, ${result}, ${status}${wire}));`);
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

/** The thin Hono transport of package `pkg`: the Fastify transport's routes, on a Hono app. */
export function renderHonoTransport(pkg: ServicePackage, ctx: RenderContext): ServiceFile {
  const path = honoTransportPath(pkg.package);
  const w = new TsWriter();
  const label = pkg.package === "" ? "the model's root package" : `package ${pkg.package}`;
  header(w, `${label} — Hono transport (ADR-0067 layer 5)`);
  const runtime = runtimeSpecifierFrom(path, "service-hono", ctx);
  const serviceRuntime = runtimeSpecifierFrom(path, "service", ctx);
  const serviceIndex = contractSpecifier(path, servicePath(pkg.package, SERVICE_INDEX_FILE), ctx.extStyle);
  const hono = w.useType("Hono", "hono");
  const context = w.useType("Context", "hono");
  const send = w.use("sendOpResult", runtime);
  const guard = w.use("guardRoute", runtime);
  const readBody = w.use("readBody", runtime);
  const parseQuery = w.use("parseListQueryString", runtime);
  const rawQuery = w.use("rawQueryOf", runtime);
  const type = w.useType(serviceTypeName(pkg.package), serviceIndex);
  const routes = serviceHonoRoutesName(pkg.package);
  const prefix = ctx.apiPrefix ?? "";
  const at = (p: string) => str(`${prefix}${p}`);

  refuseRouteCollisions(transportRoutes(pkg));

  w.doc("What the routes need: the service they call, and who is calling.");
  w.block(`export interface ${type}HonoRoutesOptions<A = unknown> {`, () => {
    w.line(`readonly service: ${type}<A>;`);
    w.doc(
      "Who a request is for (ADR-0067 §7): the app's own resolver, from its own authentication. The",
      "service never looks inside the actor; it hands it to the policy, the bodies, the hooks and the",
      "event hook. Absent, every operation runs with no actor, which a policy may refuse.",
    );
    w.line(`readonly getActor?: (c: ${context}) => A | undefined | Promise<A | undefined>;`);
  });
  w.blank();
  w.doc(
    `Mount the REST routes of ${label} on \`app\`. Each route reads the request, resolves the actor,`,
    "calls one operation of the service and answers what it answered; it holds no rules. Call it",
    `with the service: \`${routes}(app, { service, getActor })\`.`,
  );
  w.block(`export function ${routes}<A = unknown>(app: ${hono}<any, any, any>, opts: ${type}HonoRoutesOptions<A>): void {`, () => {
    w.line("const { service } = opts;");
    w.line(`const actorOf = async (c: ${context}): Promise<${w.useType("OpOptions", serviceRuntime)}<A>> => ({ actor: (await opts.getActor?.(c)) as A | undefined });`);
    // Hono tries routes in the order they are added, where Fastify's router prefers a fixed path
    // segment to a parameter wherever two paths differ. So the routes are added in that order,
    // `/requests/totals` before `/requests/:id`, and answer as the Fastify transport's do.
    const routes: Array<{ path: string; emit: () => void }> = [];
    const route = (path: string, emit: () => void) => routes.push({ path, emit });
    for (const e of pkg.entities) {
      const mods = modulesOf(path, e.obj, ctx);
      const create = w.useType(`${e.obj.name}Create`, mods.contract);
      const patch = w.useType(`${e.obj.name}Patch`, mods.contract);
      const toWire = w.use(wireMapperName(e.obj.name), serviceIndex);
      const o = e.operations;
      const base = at(restPath(e.obj));
      const item = at(`${restPath(e.obj)}/:id`);
      const id = `c.req.param("id") ?? ""`;
      const basePath = restPath(e.obj);
      const itemPath = `${basePath}/:id`;
      route(basePath, () => {
        w.block(`app.get(${base}, ${guard}(async (c) => {`, () => {
          w.line(`const result = await service.${o.list}(${parseQuery}(${rawQuery}(c.req.url)), await actorOf(c));`);
          w.line(
            `return ${send}(c, result, 200, (page) => (page.total === undefined ? page.rows.map(${toWire}) : { rows: page.rows.map(${toWire}), total: page.total }));`,
          );
        }, "}));");
        w.block(`app.post(${base}, ${guard}(async (c) => {`, () => {
          w.line(`const read = await ${readBody}(c);`);
          w.line("if (!read.ok) return read.response;");
          w.line(`return ${send}(c, await service.${o.create}(read.body as ${create}, await actorOf(c)), 201, ${toWire});`);
        }, "}));");
      });
      route(itemPath, () => {
        w.line(`app.get(${item}, ${guard}(async (c) => ${send}(c, await service.${o.get}(${id}, await actorOf(c)), 200, ${toWire})));`);
        w.line("// The update is reachable by PATCH and by PUT, as in every port.");
        for (const verb of ["patch", "put"]) {
          w.block(`app.${verb}(${item}, ${guard}(async (c) => {`, () => {
            w.line(`const read = await ${readBody}(c);`);
            w.line("if (!read.ok) return read.response;");
            w.line(`return ${send}(c, await service.${o.update}(${id}, read.body as ${patch}, await actorOf(c)), 200, ${toWire});`);
          }, "}));");
        }
        w.line(`app.delete(${item}, ${guard}(async (c) => ${send}(c, await service.${o.delete}(${id}, await actorOf(c)), 204)));`);
      });
      for (const c of e.commands) {
        const path = `${itemPath}/${c.transition.name}`;
        route(path, () =>
          w.line(`app.post(${at(path)}, ${guard}(async (c) => ${send}(c, await service.${c.fn}(${id}, await actorOf(c)), 200, ${toWire})));`),
        );
      }
    }
    for (const op of pkg.operations) {
      const key = op.keyed ? op.target!.keyField : undefined;
      const fromGet = op.method === "GET" || op.method === "DELETE";
      const readsBody = op.input !== undefined && !fromGet;
      const args = [
        ...(key === undefined ? [] : [`c.req.param(${str(key)}) ?? ""`]),
        ...(op.input !== undefined ? [`(${fromGet ? "c.req.query()" : "read.body ?? {}"}) as never`] : []),
        ...(op.kind === "query" && op.many ? [`${parseQuery}(${rawQuery}(c.req.url))`] : []),
        "await actorOf(c)",
      ];
      const result = `await service.${op.name}(${args.join(", ")})`;
      const wire = outputIsTargetRow(op) ? `, ${w.use(wireMapperName(op.target!.obj.name), serviceIndex)}` : "";
      const status = op.output === undefined && op.kind === "command" ? "204" : "200";
      const head = `app.${op.method.toLowerCase()}(${at(op.path)}, ${guard}(async (c) => `;
      route(op.path, () => {
        if (!readsBody) {
          w.line(`${head}${send}(c, ${result}, ${status}${wire})));`);
          return;
        }
        w.block(`${head}{`, () => {
          w.line(`const read = await ${readBody}(c);`);
          w.line("if (!read.ok) return read.response;");
          w.line(`return ${send}(c, ${result}, ${status}${wire});`);
        }, "}));");
      });
    }
    for (const r of [...routes].sort((a, b) => fixedFirst(a.path, b.path))) r.emit();
  });
  return { path, content: w.toString() };
}

/**
 * Order two route paths so that, wherever two of them could match one request, the one with a
 * fixed segment comes first, as Fastify's router prefers it: at the first segment where they
 * differ, a parameter sorts after any fixed text, and two fixed segments compare as text. A
 * total order, so the emitted file is the same on every run.
 */
function fixedFirst(a: string, b: string): number {
  const sa = a.split("/");
  const sb = b.split("/");
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const x = sa[i]!;
    const y = sb[i]!;
    if (x === y) continue;
    const px = x.startsWith(":");
    const py = y.startsWith(":");
    if (px !== py) return px ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return sa.length - sb.length;
}
