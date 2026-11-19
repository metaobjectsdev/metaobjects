import type { Ir } from "../ir.js";
import { GENERATED_BANNER, lit } from "../names.js";

export function emitEnums(ir: Ir): string {
  const out: string[] = [GENERATED_BANNER, "//! Closed sets of the tasks-axi model: the three task states, the five hold kinds, and so on.\n"];
  for (const e of ir.enums) {
    const n = e.members.length;
    out.push(`#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ${e.name} {
${e.members.map((m) => `${m.variant},`).join("\n")}
}

impl ${e.name} {
    /// Every member, in declaration order.
    pub const ALL: [${e.name}; ${n}] = [${e.members.map((m) => `${e.name}::${m.variant}`).join(", ")}];

    /// The printed and parsed spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
${e.members.map((m) => `${e.name}::${m.variant} => ${lit(m.wire)},`).join("\n")}
        }
    }

    /// The member spelled \`s\`, if any.
    pub fn parse(s: &str) -> Option<${e.name}> {
        match s {
${e.members.map((m) => `${lit(m.wire)} => Some(${e.name}::${m.variant}),`).join("\n")}
            _ => None,
        }
    }
}
`);
  }
  return out.join("\n");
}
