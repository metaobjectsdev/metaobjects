import type { MetaData } from "@metaobjectsdev/metadata";
import { TYPE_TEMPLATE } from "@metaobjectsdev/metadata";

/** All template nodes of `subType` anywhere in the tree (top-level OR nested in entities). */
export function findTemplates(root: MetaData, subType: string): MetaData[] {
  const out: MetaData[] = [];
  const visit = (node: MetaData) => {
    // ADR-0039: own — structural declaration walk. Enumerates every template node
    // physically DECLARED in the tree exactly once (each → one emitted file);
    // resolving would re-visit an inherited template on every subclass.
    for (const child of node.ownChildren()) {
      if (child.type === TYPE_TEMPLATE && child.subType === subType) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}
