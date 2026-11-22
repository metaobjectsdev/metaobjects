// The contract types layer (ADR-0067 §1, layer 1): the shapes a caller and a service exchange,
// with no persistence mapping in them. Three kinds of module:
//
//   - `<Object>.contract.ts` — an entity's read shape (interface), its create and update schemas
//     with their validation, and the typed create and patch inputs; a projection's read shape;
//   - `errors.contract.ts` — the wire error bodies of the REST contract and the enforcing shell;
//   - `<pkg>/operations.contract.ts` — each declared operation's input, output and errors.
//
// The field-level schemas are the ones the entity file already writes (`renderZodValidators`,
// `renderValueObjectInterface`), so the two can never validate one field two ways.

import { CONTRACT_ERROR_CODES, CONTRACT_FILE_SUFFIX, SHELL_ERROR_CODES } from "../contract-walk.js";
import { withExtIfRelative } from "../render-context.js";
import { GENERATED_EDIT_NOTE, GENERATED_HEADER } from "../constants.js";
import type { RenderContext } from "../render-context.js";
import { toPascalCase } from "../naming.js";
import { isProjection } from "../projection/projection-detector.js";
import { renderEnumTypeAliases } from "./inferred-types.js";
import { primaryIdentityFieldNames, renderTphSubtypeReadSchema, renderZodValidators } from "./zod-validators.js";
import { tphConcreteSubtypes } from "./tph-discriminator.js";
import { isTphSubtype } from "../tph.js";
import { renderViewReadZodObject } from "./view-decl.js";
import { valueObjectFieldImport } from "../import-path.js";
import { effectivePackage } from "../docs-paths.js";
import { TsWriter, arr, str } from "../writer/ts-writer.js";
import { code, imp, joinCode, type Code } from "../poet.js";
import type { MetaObject } from "@metaobjectsdev/metadata";

const strings = (values: readonly string[]) => arr(values.map(str));
const union = (values: readonly string[]): string => values.map(str).join(" | ");

/**
 * The text of `<Object>.contract.ts`. An entity gets its three shapes: the read schema and type (a
 * row as the store returns it: the key and every NOT NULL column present, a nullable one `null`),
 * the create and update schemas with their validation, and the typed create and patch inputs. A
 * projection gets its read schema and type. Every section is one the entity file already renders,
 * printed the way the entity file is printed, so a field reads and validates the same in both.
 */
export function renderObjectContract(obj: MetaObject, ctx: RenderContext): string {
  const z = imp("z@zod");
  const name = obj.name;
  const pkg = effectivePackage(obj);
  const subtypes = tphConcreteSubtypes(obj, ctx.loadedRoot);
  let readDecl: Code;
  if (subtypes.length > 0) {
    // A TPH base: a row is one of its subtypes, told apart by the discriminator.
    // A subtype shares its base's table, so it shares its base's package and directory.
    const from = (s: MetaObject) => withExtIfRelative(`./${s.name}${CONTRACT_FILE_SUFFIX.replace(/\.ts$/, "")}`, ctx.extStyle);
    const schemas = subtypes.map((s) => code`${imp(`${s.name}Schema@${from(s)}`)}`);
    const types = subtypes.map((s) => code`${imp(`t:${s.name}@${from(s)}`)}`);
    readDecl = code`export const ${name}Schema = ${z}.union([${joinCode(schemas, { on: ", " })}]); export type ${name} = ${joinCode(types, { on: " | " })};`;
  } else if (isTphSubtype(obj)) {
    // A TPH subtype: the discriminator pinned, and a column only some subtypes have nullable.
    readDecl = code`${renderTphSubtypeReadSchema(obj, ctx)}export type ${name} = ${z}.infer<typeof ${name}Schema>;`;
  } else {
    const read = renderViewReadZodObject(obj.fields(), {
      dialect: ctx.dialect,
      columnNamingStrategy: ctx.columnNamingStrategy,
      timestampMode: ctx.timestampMode,
      voRef: (field, suffix, typeOnly) => valueObjectFieldImport(ctx, field, pkg, suffix, typeOnly),
      pkFieldNames: new Set(primaryIdentityFieldNames(obj)),
    });
    readDecl = code`export const ${name}Schema = ${read}; export type ${name} = ${z}.infer<typeof ${name}Schema>;`;
  }
  const aliases = renderEnumTypeAliases(obj, ctx) ?? code``;
  // A projection is read-only: it has a read shape and nothing a caller sends.
  const writes = isProjection(obj) ? code`` : renderZodValidators(obj, ctx);
  const body = code`${readDecl}${aliases}${writes}`.toString();
  const w = new TsWriter();
  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${name} (${obj.fqn()}) — contract types, no persistence mapping`,
  );
  w.text(body);
  return w.toString();
}

/** The text of `errors.contract.ts`: the wire error bodies every route and shell answers with. */
export function renderErrorsContract(): string {
  const w = new TsWriter();
  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    "// Source metadata: the wire error contract (docs/features/api-contract.md, ADR-0066 §6)",
  );

  w.doc("The wire codes the enforcing shell answers with on its own (ADR-0066 §6).");
  w.line("export const ShellErrorCodes = ", strings(SHELL_ERROR_CODES), " as const;");
  w.line("export type ShellErrorCode = (typeof ShellErrorCodes)[number];");

  w.blank().doc("The wire codes the REST contract's transport answers with (docs/features/api-contract.md).");
  w.line("export const ContractErrorCodes = ", strings(CONTRACT_ERROR_CODES), " as const;");
  w.line("export type ContractErrorCode = (typeof ContractErrorCodes)[number];");

  w.blank().doc(
    "The HTTP status of each fixed code. `constraint_violation` has none of its own: it is 409 for a",
    "`unique` or `foreign_key` constraint and 400 for a `check` or `not_null` one.",
  );
  w.block("export const ErrorStatus = {", () => {
    for (const [code, status] of ERROR_STATUS) w.line(`${code}: ${status},`);
  }, `} as const satisfies Record<Exclude<ShellErrorCode | ContractErrorCode, ${str("constraint_violation")}>, number>;`);

  w.blank().doc("Every error body: a short code, and a human message that is not part of the contract.");
  w.block("export interface ErrorBody<Code extends string = string> {", () => {
    w.line("readonly error: Code;");
    w.line("readonly message?: string;");
  });

  w.blank().doc(
    "One problem with a request body. `code` uses Zod's names; a client treats a code it does not know",
    "as `custom`, and ignores keys it does not know.",
  );
  w.block("export interface ValidationIssue {", () => {
    w.line("readonly code: string;");
    w.line("readonly path: readonly (string | number)[];");
    w.line("readonly message: string;");
  });

  w.blank().doc("400: the body failed its schema. Every issue is listed, not the first.");
  w.block(`export interface ValidationErrorBody extends ErrorBody<${str("validation")}> {`, () => {
    w.line("readonly issues: readonly ValidationIssue[];");
  });

  w.blank().doc("The kind of constraint the database refused a write on. The body never names the SQL.");
  w.line(`export type ConstraintKind = ${union(CONSTRAINT_KINDS)};`);

  w.blank().doc("409 (`unique`, `foreign_key`) or 400 (`check`, `not_null`): the database refused the write.");
  w.block(`export interface ConstraintViolationBody extends ErrorBody<${str("constraint_violation")}> {`, () => {
    w.line("readonly constraint: ConstraintKind;");
  });
  return w.toString();
}

const ERROR_STATUS: readonly (readonly [string, number])[] = [
  ["not_found", 404],
  ["forbidden", 403],
  ["invalid_transition", 409],
  ["transition_condition_failed", 409],
  ["state_managed", 409],
  ["validation", 400],
  ["invalid_json", 400],
  ["invalid_id", 400],
  ["method_not_allowed", 405],
  ["internal", 500],
];

const CONSTRAINT_KINDS = ["unique", "foreign_key", "check", "not_null"] as const;

/** A shape an operation takes or returns, and where its module is. */
export interface ContractShapeRef {
  /** The exported name to import: a value object's `<V>InsertSchema`, or an object's read type. */
  readonly name: string;
  /** The specifier of the module that exports it, relative to the operations file. */
  readonly from: string;
}

/** One declared operation, as the operations file writes it. */
export interface ContractOperationInput {
  readonly name: string;
  readonly kind: "command" | "query";
  /** The `@inputRef` value object's insert schema; absent when the operation declares none. */
  readonly input?: ContractShapeRef;
  /** The `@outputRef` object's read type; absent when the operation declares none. */
  readonly output?: ContractShapeRef;
  /** `@many`: the output is a list. */
  readonly many: boolean;
  /** The business errors a command's body may return (`@errors`). */
  readonly errors: readonly string[];
}

/** The text of `<pkg>/operations.contract.ts`. */
export function renderOperationsContract(
  pkg: string,
  operations: readonly ContractOperationInput[],
  errorsModule: string,
): string {
  const w = new TsWriter();
  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: operations of ${pkg === "" ? "the model" : `package ${pkg}`} — inputs, outputs and errors`,
  );
  const errorBody = w.useType("ErrorBody", errorsModule);
  const shell = w.useType("ShellErrorCode", errorsModule);
  const contract = w.useType("ContractErrorCode", errorsModule);

  let first = true;
  for (const op of operations) {
    if (!first) w.blank();
    first = false;
    const stem = toPascalCase(op.name);
    w.doc(`\`${op.name}\` (${op.kind}).`);
    if (op.input !== undefined) {
      const z = w.useType("z", "zod");
      const schema = w.use(op.input.name, op.input.from);
      w.line(`export const ${stem}InputSchema = ${schema};`);
      w.line(`export type ${stem}Input = ${z}.input<typeof ${schema}>;`);
    }
    if (op.output !== undefined) {
      const out = w.useType(op.output.name, op.output.from);
      w.line(`export type ${stem}Output = ${op.many ? `readonly ${out}[]` : out};`);
    }
    const business = op.errors.length === 0 ? "never" : union(op.errors);
    w.line(`export type ${stem}BusinessError = ${business};`);
    w.line(`export type ${stem}Error = ${errorBody}<${shell} | ${contract} | ${stem}BusinessError>;`);
  }
  return w.toString();
}
