// LAYER 1 — read the loaded metadata model into the intermediate description (ir.ts).
// This is the only file that touches the metadata classes. Every read RESOLVES (`attr`,
// `fields`, `children`) rather than reading own-only, so an `extends` is followed
// (ADR-0039). A malformed model throws with the offending name; nothing is guessed.

import type { MetaData, MetaRoot } from "@metaobjectsdev/metadata";
import type {
  ColumnIr, CliIr, CommandIr, EnumIr, FieldIr, FlagIr, HintIr, Ir, OutputIr, RowRulesIr, ScalarIr, StructIr,
} from "./ir.js";
import { pascal } from "./names.js";

const PKG_MODEL = "tasksaxi::model";
const PKG_CLI = "tasksaxi::cli";

function fail(msg: string): never {
  throw new Error(`rust-cli: ${msg}`);
}
function last(fqn: string): string {
  return fqn.split("::").pop() as string;
}
function top(root: MetaRoot, type: string, subType: string, name: string): MetaData {
  const found = root.children().find((c) => c.type === type && c.subType === subType && c.name === name);
  return found ?? fail(`model has no ${type}.${subType} ${name}`);
}
function strArr(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) fail(`${what} must be a list of strings`);
  return v as string[];
}
function bag(node: MetaData, name: string): Record<string, unknown> | undefined {
  const v = node.attr(name);
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${node.name}: @${name} must be a map`);
  return v as Record<string, unknown>;
}

function readEnum(node: MetaData): EnumIr {
  const values = strArr(node.attr("values"), `enum ${node.name} @values`);
  const map = (node.attr("stringValueMap") ?? {}) as Record<string, string>;
  return {
    name: node.name,
    members: values.map((symbol) => ({ symbol, variant: pascal(symbol), wire: map[symbol] ?? symbol })),
  };
}

/** The shared enum an enum-typed field points at (`extends`). */
function enumNameOf(field: MetaData): string {
  const sup = field.superResolved;
  if (!sup || sup.subType !== "enum") fail(`${field.parent?.name}.${field.name}: an enum field must extend a shared enum`);
  return sup.name;
}

function scalarOf(field: MetaData): ScalarIr {
  switch (field.subType) {
    case "string":
      return { kind: "string" };
    case "int":
      return { kind: "int" };
    case "boolean":
      return { kind: "boolean" };
    case "enum":
      return { kind: "enum", enum: enumNameOf(field) };
    case "object": {
      const ref = field.attr("objectRef");
      if (typeof ref !== "string") fail(`${field.name}: field.object needs @objectRef`);
      return { kind: "object", object: last(ref) };
    }
    default:
      return fail(`${field.parent?.name}.${field.name}: unsupported field subtype ${field.subType}`);
  }
}

function fieldsOf(obj: MetaData): MetaData[] {
  return obj.children().filter((c) => c.type === "field");
}

function readStruct(obj: MetaData): StructIr {
  const fields: FieldIr[] = fieldsOf(obj).map((f) => ({
    name: f.name,
    scalar: scalarOf(f),
    array: f.resolvedIsArray(),
    required: f.attr("required") === true,
  }));
  return { name: obj.name, fields };
}

function readColumn(f: MetaData): ColumnIr {
  const b = bag(f, "row") ?? {};
  const rules: RowRulesIr = { join: typeof b.join === "string" ? b.join : "," };
  if (typeof b.absent === "string") rules.absent = b.absent;
  if (typeof b.trueText === "string") rules.trueText = b.trueText;
  if (typeof b.falseText === "string") rules.falseText = b.falseText;
  if (typeof b.truncate === "number") rules.truncate = b.truncate;
  const scalar = scalarOf(f);
  if (scalar.kind === "boolean" && (rules.trueText === undefined || rules.falseText === undefined)) {
    fail(`TaskRow.${f.name}: a boolean column needs trueText and falseText in its row bag`);
  }
  return {
    name: f.name,
    variant: pascal(f.name),
    scalar,
    array: f.resolvedIsArray(),
    required: f.attr("required") === true,
    rules,
  };
}

/** A column set's members, proven to be TaskRow columns by their `extends`. */
function readColumnSet(obj: MetaData, rowName: string, rowColumns: Set<string>): string[] {
  return fieldsOf(obj).map((f) => {
    const sup = f.superResolved;
    if (!sup || sup.parent?.name !== rowName) fail(`${obj.name}.${f.name} must extend ${rowName}.${f.name}`);
    if (!rowColumns.has(f.name)) fail(`${obj.name}.${f.name} is not a ${rowName} column`);
    return f.name;
  });
}

function flagOf(raw: Record<string, unknown>): FlagIr {
  const name = String(raw.name);
  switch (raw.type) {
    case "bool":
    case "line":
    case "uint":
      return { name, flag: { kind: raw.type } };
    case "enum":
      return { name, flag: { kind: "enum", enum: String(raw.enum) } };
    case "columns":
      return { name, flag: { kind: "columns", row: String(raw.row), base: String(raw.base) } };
    default:
      return fail(`flag --${name}: unknown type ${String(raw.type)}`);
  }
}

export function readModel(root: MetaRoot): Ir {
  const enums = root
    .children()
    .filter((c) => c.type === "field" && c.subType === "enum")
    .map(readEnum);
  const enumNames = new Set(enums.map((e) => e.name));

  const values = ["Hold", "Dep", "Link"].map((n) => readStruct(top(root, "object", "value", n)));
  const task = readStruct(top(root, "object", "entity", "Task"));

  const rowObj = top(root, "object", "value", "TaskRow");
  const columns = fieldsOf(rowObj).map(readColumn);
  const colNames = new Set(columns.map((c) => c.name));
  const sets = ["TaskListRow", "TaskDetailRow"].map((n) => ({
    name: n,
    columns: readColumnSet(top(root, "object", "value", n), "TaskRow", colNames),
  }));
  const setByName = new Map(sets.map((s) => [s.name, s.columns]));

  const errors = fieldsOf(top(root, "object", "value", "ErrorCode")).map((f) => {
    const exit = f.attr("default");
    if (typeof exit !== "number") fail(`ErrorCode.${f.name}: the @default must be the exit code`);
    return { name: f.name, variant: pascal(f.name), exit };
  });

  const cliObj = root.children().find((c) => c.type === "object" && c.resolutionKey() === `${PKG_CLI}::Cli`);
  const raw = (cliObj ?? fail("model has no tasksaxi::cli::Cli")).attr("cli") as Record<string, any> | undefined;
  if (!raw) fail("Cli has no `cli` bag");

  const extraColumns = columns
    .map((c) => c.name)
    .filter((n) => !(setByName.get("TaskListRow") as string[]).includes(n));

  const expand = (cols: string, extra: unknown): string[] => {
    const base = setByName.get(cols) ?? fail(`unknown column set ${cols}`);
    const more = extra === undefined ? [] : strArr(extra, "extra");
    for (const n of more) if (!colNames.has(n)) fail(`extra column ${n} is not a TaskRow column`);
    return [...base, ...more];
  };

  const checkFlag = (f: FlagIr): void => {
    if (f.flag.kind === "enum" && !enumNames.has(f.flag.enum)) fail(`--${f.name}: unknown enum ${f.flag.enum}`);
    if (f.flag.kind === "columns") {
      if (f.flag.row !== rowObj.name) fail(`--${f.name}: row ${f.flag.row} is not ${rowObj.name}`);
      if (!setByName.has(f.flag.base)) fail(`--${f.name}: unknown column set ${f.flag.base}`);
    }
  };

  const commands: CommandIr[] = Object.entries(raw.commands as Record<string, any>).map(([name, c]) => {
    const flags: FlagIr[] = (c.flags as Record<string, unknown>[]).map(flagOf);
    flags.forEach(checkFlag);
    const help = String(c.help).replace("{extraColumns}", [...extraColumns].sort().join(", "));
    const outputs: OutputIr[] = (c.outputs as any[]).map((o) => ({
      label: String(o.label),
      columns: expand(String(o.columns), o.extra),
    }));
    const hints: HintIr[] = ((c.hints ?? []) as any[]).map((h) => ({
      when: h.when,
      line: String(h.line),
      filters: h.filters === undefined ? [] : strArr(h.filters, "hint filters"),
    }));
    return {
      name,
      aliases: c.aliases === undefined ? [] : strArr(c.aliases, `${name} aliases`),
      help,
      usage: help.split("\n")[0] as string,
      flags,
      positionals: {
        names: strArr(c.positionals.names, `${name} positionals`),
        min: c.positionals.min,
        max: c.positionals.max,
        idType: c.positionals.type === "taskId",
      },
      outputs,
      hints,
    };
  });

  const globalFlags = (raw.globalFlags as Record<string, unknown>[]).map(flagOf);
  globalFlags.forEach(checkFlag);

  const cli: CliIr = {
    bin: String(raw.bin),
    version: String(raw.version),
    noun: String(raw.noun),
    globalFlags,
    topHelp: String(raw.topHelp),
    refused: strArr(raw.refused, "refused"),
    refusal: { message: raw.refusal.message, suggestion: raw.refusal.suggestion, home: raw.refusal.home },
    commands,
  };
  void PKG_MODEL;
  return { enums, values, task, row: { name: "TaskRow", columns, sets }, errors, cli };
}
