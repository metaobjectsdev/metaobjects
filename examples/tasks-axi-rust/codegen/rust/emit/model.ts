import type { FieldIr, Ir, ScalarIr } from "../ir.js";
import { GENERATED_BANNER, ident } from "../names.js";

export function scalarType(s: ScalarIr): string {
  switch (s.kind) {
    case "string":
      return "String";
    case "int":
      return "i64";
    case "boolean":
      return "bool";
    case "enum":
      return s.enum;
    case "object":
      return s.object;
  }
}

function fieldType(f: FieldIr): string {
  const t = scalarType(f.scalar);
  if (f.array) return `Vec<${t}>`;
  return f.required ? t : `Option<${t}>`;
}

export function emitModel(ir: Ir): string {
  const structs = [...ir.values, ir.task];
  const enumNames = [...new Set(structs.flatMap((s) => s.fields.flatMap((f) => (f.scalar.kind === "enum" ? [f.scalar.enum] : []))))];
  const out: string[] = [
    GENERATED_BANNER,
    "//! The task record and its value objects, as the markdown backlog parser builds them.\n",
    `use crate::enums::{${enumNames.join(", ")}};\n`,
  ];
  for (const s of structs) {
    out.push(`#[derive(Debug, Clone, PartialEq)]
pub struct ${s.name} {
${s.fields.map((f) => `pub ${ident(f.name)}: ${fieldType(f)},`).join("\n")}
}
`);
  }
  return out.join("\n");
}
