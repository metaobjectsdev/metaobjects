import type { MetaData, MetaRoot } from "@metaobjectsdev/metadata";
import {
  OBJECT_SUBTYPE_REPORT, TYPE_DIMENSION, TYPE_MEASURE, TYPE_OBJECT, TYPE_SEGMENT,
} from "@metaobjectsdev/metadata";

/** FR-044 reporting vocabulary: a report and the dimension/measure/segment declarations it
 *  is built from. Inert in every generator until the lowering lands, so the site renders
 *  none of it BY DESIGN and the audit must not report that as a gap. */
const REPORTING_TYPES: ReadonlySet<string> = new Set([TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT]);
const isReportingVocabulary = (n: MetaData): boolean =>
  REPORTING_TYPES.has(n.type) || (n.type === TYPE_OBJECT && n.subType === OBJECT_SUBTYPE_REPORT);

export interface CoverageRow { key: string; count: number; consumed: boolean; }
export interface CoverageReport { kinds: CoverageRow[]; attrs: CoverageRow[]; warnings: string[]; }

export class CoverageTracker {
  private kinds = new Set<string>();
  private attrs = new Set<string>();
  consumeNode(n: MetaData): void { this.kinds.add(`${n.type}.${n.subType}`); }
  consumeAttr(n: MetaData, a: string): void { this.attrs.add(`${n.type}:@${a}`); }
  report(root: MetaRoot): CoverageReport {
    const kindCount = new Map<string, number>();
    const attrCount = new Map<string, number>();
    const walk = (n: MetaData) => {
      // FR-044 Plan 1: object.report has no output until its lowering lands (Plan 2/3).
      if (isReportingVocabulary(n)) return;
      kindCount.set(`${n.type}.${n.subType}`, (kindCount.get(`${n.type}.${n.subType}`) ?? 0) + 1);
      for (const [name] of n.ownAttrs()) {
        attrCount.set(`${n.type}:@${name}`, (attrCount.get(`${n.type}:@${name}`) ?? 0) + 1);
      }
      for (const c of n.ownChildren()) walk(c);
    };
    for (const c of root.ownChildren()) walk(c);
    const rows = (m: Map<string, number>, seen: Set<string>) =>
      [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, count]) => ({ key, count, consumed: seen.has(key) }));
    const kinds = rows(kindCount, this.kinds);
    const attrs = rows(attrCount, this.attrs);
    const warnings = [...kinds, ...attrs].filter((r) => !r.consumed).map((r) => `coverage: ${r.key} (${r.count}) not rendered by any page`);
    return { kinds, attrs, warnings };
  }
}
