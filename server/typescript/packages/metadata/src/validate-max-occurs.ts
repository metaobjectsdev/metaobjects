// maxOccurs enforcement — a type definition may declare `maxOccurs` (the max
// number of children of that `type.subType` permitted under one parent; `1` =
// singleton, e.g. identity.primary). This pass enforces it. It is the safety
// complement to config-driven `defaultName`: a singleton's static default name is
// only collision-free if the singleton constraint is actually enforced (two
// nameless identity.primary nodes would otherwise both default to "primary").
import type { MetaData } from "./shared/meta-data.js";
import type { TypeRegistry } from "./registry.js";
import { ParseError } from "./errors.js";

export function validateMaxOccurs(root: MetaData, registry: TypeRegistry): ParseError[] {
  const errors: ParseError[] = [];
  walk(root, registry, errors);
  return errors;
}

function walk(node: MetaData, registry: TypeRegistry, errors: ParseError[]): void {
  const counts = new Map<string, MetaData[]>();
  // ADR-0039: own — maxOccurs constrains the AUTHORED declaration layer (how many
  // children a node may DECLARE); inherited children were counted at their
  // declaring parent, so only own children count against this node's limit.
  for (const child of node.ownChildren()) {
    const key = `${child.type}.${child.subType}`;
    const list = counts.get(key);
    if (list === undefined) counts.set(key, [child]);
    else list.push(child);
  }
  for (const [key, group] of counts) {
    const [type, subType] = key.split(".") as [string, string];
    const max = registry.find(type, subType)?.maxOccurs;
    if (max !== undefined && group.length > max) {
      const owner = node.name !== "" ? ` under '${node.name}'` : "";
      errors.push(
        new ParseError(
          `${key} appears ${group.length} times${owner} but at most ${max} is allowed`,
          { code: "ERR_TOO_MANY_OCCURRENCES", source: group[max]!.source },
        ),
      );
    }
  }
  // ADR-0039: own — structural walk over the physical declaration tree (each
  // declared node is visited once at its declaration site).
  for (const child of node.ownChildren()) walk(child, registry, errors);
}
