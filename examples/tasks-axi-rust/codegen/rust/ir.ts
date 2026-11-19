// LAYER 2 — the intermediate description. Everything an emitter needs, as plain data, with no
// reference to the metadata classes. A Rust-native generator that reproduces the committed
// golden crate builds this same shape from the same model; only layers 1 and 3 change.

export interface EnumMemberIr {
  symbol: string; // the declared member symbol, e.g. in_flight
  variant: string; // Rust variant, e.g. InFlight
  wire: string; // printed / parsed spelling (stringValueMap, else the symbol)
}
export interface EnumIr {
  name: string;
  members: EnumMemberIr[];
}

export type ScalarIr =
  | { kind: "string" }
  | { kind: "int" }
  | { kind: "boolean" }
  | { kind: "enum"; enum: string }
  | { kind: "object"; object: string };

export interface FieldIr {
  name: string;
  scalar: ScalarIr;
  array: boolean;
  required: boolean;
}
export interface StructIr {
  name: string;
  fields: FieldIr[];
}

/** How a printed column turns its typed value into a cell (the `row` bag). */
export interface RowRulesIr {
  absent?: string;
  join: string;
  trueText?: string;
  falseText?: string;
  truncate?: number;
}
export interface ColumnIr {
  name: string; // wire/header name, e.g. blocked_by
  variant: string; // Rust variant, e.g. BlockedBy
  scalar: ScalarIr;
  array: boolean;
  required: boolean;
  rules: RowRulesIr;
}
export interface ColumnSetIr {
  name: string; // e.g. TaskListRow
  columns: string[]; // TaskRow column names, in print order
}

export interface ErrorCodeIr {
  name: string; // VALIDATION_ERROR
  variant: string; // ValidationError
  exit: number;
}

export type FlagKindIr =
  | { kind: "bool" }
  | { kind: "line" }
  | { kind: "uint" }
  | { kind: "enum"; enum: string }
  | { kind: "columns"; row: string; base: string };
export interface FlagIr {
  name: string; // as typed after `--`
  flag: FlagKindIr;
}

export type HintWhen = "always" | "empty" | "nonEmpty" | "blocked";
export interface HintIr {
  when: HintWhen;
  line: string;
  filters: string[];
}
export interface OutputIr {
  label: string;
  columns: string[]; // fully expanded: base set then extras
}
export interface CommandIr {
  name: string;
  aliases: string[];
  help: string; // final text, placeholders resolved
  usage: string; // first line of help
  flags: FlagIr[];
  positionals: { names: string[]; min: number; max: number; idType: boolean };
  outputs: OutputIr[];
  hints: HintIr[];
}

export interface CliIr {
  bin: string;
  version: string;
  noun: string;
  globalFlags: FlagIr[];
  topHelp: string;
  refused: string[];
  refusal: { message: string; suggestion: string; home: string };
  commands: CommandIr[];
}

export interface Ir {
  enums: EnumIr[];
  values: StructIr[]; // Hold, Dep, Link — emitted before Task
  task: StructIr;
  row: { name: string; columns: ColumnIr[]; sets: ColumnSetIr[] };
  errors: ErrorCodeIr[];
  cli: CliIr;
}
