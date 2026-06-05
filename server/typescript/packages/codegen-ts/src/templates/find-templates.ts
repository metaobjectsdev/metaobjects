import type { MetaData } from "@metaobjectsdev/metadata";
import { TYPE_TEMPLATE } from "@metaobjectsdev/metadata";

/** All template nodes of `subType` anywhere in the tree (top-level OR nested in entities). */
export function findTemplates(root: MetaData, subType: string): MetaData[] {
  const out: MetaData[] = [];
  const visit = (node: MetaData) => {
    for (const child of node.ownChildren()) {
      if (child.type === TYPE_TEMPLATE && child.subType === subType) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}
