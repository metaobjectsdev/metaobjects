import type { ColumnIr, Ir } from "../ir.js";
import { GENERATED_BANNER, ident, lit } from "../names.js";
import { scalarType } from "./model.js";

function rowType(c: ColumnIr): string {
  const t = scalarType(c.scalar);
  if (c.array) return `Vec<${t}>`;
  if (c.scalar.kind === "boolean") return "bool";
  return c.rules.absent !== undefined || !c.required ? `Option<${t}>` : t;
}

/** The expression that turns column `c` of `self` into a Cell. */
function cellExpr(c: ColumnIr): string {
  const f = `self.${ident(c.name)}`;
  const absent = lit(c.rules.absent ?? "");
  if (c.scalar.kind === "boolean") {
    return `Cell::Str((if ${f} { ${lit(c.rules.trueText as string)} } else { ${lit(c.rules.falseText as string)} }).to_string())`;
  }
  if (c.array) {
    return c.rules.absent !== undefined
      ? `Cell::Str(if ${f}.is_empty() { ${absent}.to_string() } else { ${f}.join(${lit(c.rules.join)}) })`
      : `Cell::Str(${f}.join(${lit(c.rules.join)}))`;
  }
  const optional = rowType(c).startsWith("Option<");
  switch (c.scalar.kind) {
    case "int":
      return optional
        ? `match ${f} { Some(v) => Cell::Int(v), None => Cell::Str(${absent}.to_string()) }`
        : `Cell::Int(${f})`;
    case "enum":
      return optional
        ? `Cell::Str(${f}.map(|v| v.as_str().to_string()).unwrap_or_else(|| ${absent}.to_string()))`
        : `Cell::Str(${f}.as_str().to_string())`;
    default:
      return optional
        ? c.rules.absent === "" || c.rules.absent === undefined
          ? `Cell::Str(${f}.clone().unwrap_or_default())`
          : `Cell::Str(${f}.clone().unwrap_or_else(|| ${absent}.to_string()))`
        : `Cell::Str(${f}.clone())`;
  }
}

export function emitRows(ir: Ir): string {
  const cols = ir.row.columns;
  const enumsUsed = [...new Set(cols.flatMap((c) => (c.scalar.kind === "enum" ? [c.scalar.enum] : [])))];
  const set = (name: string): string[] => ir.row.sets.find((s) => s.name === name)!.columns;
  const variant = (n: string): string => `Column::${cols.find((c) => c.name === n)!.variant}`;
  const listBase = set("TaskListRow");
  const extra = cols.map((c) => c.name).filter((n) => !listBase.includes(n));
  const constName = (n: string): string => n.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

  const setConsts = ir.row.sets
    .map(
      (s) =>
        `/// Columns of \`${s.name}\`, in print order.\npub const ${constName(s.name)}_COLUMNS: [Column; ${s.columns.length}] = [${s.columns.map(variant).join(", ")}];`,
    )
    .join("\n\n");

  return `${GENERATED_BANNER}
//! The printed row, its columns and the column sets each view prints.

use crate::enums::{${enumsUsed.join(", ")}};

/// One printed value: text, or an integer (printed as a TOON number).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cell {
    Str(String),
    Int(i64),
}

/// ${ir.row.name}: one flat record carrying every derivable column.
#[derive(Debug, Clone, PartialEq)]
pub struct ${ir.row.name} {
${cols.map((c) => `pub ${ident(c.name)}: ${rowType(c)},`).join("\n")}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Column {
${cols.map((c) => `${c.variant},`).join("\n")}
}

impl Column {
    /// Every column, in row order.
    pub const ALL: [Column; ${cols.length}] = [${cols.map((c) => `Column::${c.variant}`).join(", ")}];

    /// The header name.
    pub const fn name(self) -> &'static str {
        match self {
${cols.map((c) => `Column::${c.variant} => ${lit(c.name)},`).join("\n")}
        }
    }

    /// The column called \`s\`, if any.
    pub fn parse(s: &str) -> Option<Column> {
        match s {
${cols.map((c) => `${lit(c.name)} => Some(Column::${c.variant}),`).join("\n")}
            _ => None,
        }
    }

    /// Display limit in UTF-16 units for columns whose text is truncated, else None.
    pub const fn truncate_limit(self) -> Option<usize> {
        match self {
${cols.filter((c) => c.rules.truncate !== undefined).map((c) => `Column::${c.variant} => Some(${c.rules.truncate}),`).join("\n")}
            _ => None,
        }
    }
}

impl ${ir.row.name} {
    /// The printed value of column \`c\`.
    pub fn cell(&self, c: Column) -> Cell {
        match c {
${cols.map((c) => `Column::${c.variant} => ${cellExpr(c)},`).join("\n")}
        }
    }
}

${setConsts}

/// Columns a caller may add to \`list\` with \`--fields\`: every column the default set lacks.
pub const LIST_EXTRA_COLUMNS: [Column; ${extra.length}] = [${extra.map(variant).join(", ")}];
`;
}
