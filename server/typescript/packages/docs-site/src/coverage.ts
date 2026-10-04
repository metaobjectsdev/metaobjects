import type { MetaData, MetaRoot } from "@metaobjectsdev/metadata";
import {
  OBJECT_SUBTYPE_REPORT, TYPE_DIMENSION, TYPE_MEASURE, TYPE_OBJECT, TYPE_SEGMENT,
} from "@metaobjectsdev/metadata";

/** FR-044 reporting vocabulary — all four types: `dimension.*`, `measure.*`, `segment.*`
 *  and `object.report`. A view-backed report is lowered to a view (FR-044 Plan 2), but no
 *  site page renders any of this vocabulary until Plan 3, so the site shows none of it BY DESIGN.
 *
 *  The audit reports these as DEFERRED, not as "not rendered by any page" and not by
 *  silently dropping them: the gap stays visible on the returned report (`deferred`, one
 *  `deferred (FR-044 Plan 2/3)` warning per type) without changing a rendered page, because
 *  `meta docs` output must be identical with and without the vocabulary until then.
 *
 *  DELETE this predicate, `deferred`, and the branch in `walk` when the Plan 2/3 lowering
 *  lands and the site renders reports — from then on an unrendered dimension is a real gap. */
const REPORTING_TYPES: ReadonlySet<string> = new Set([TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT]);
const isReportingVocabulary = (n: MetaData): boolean =>
  REPORTING_TYPES.has(n.type) || (n.type === TYPE_OBJECT && n.subType === OBJECT_SUBTYPE_REPORT);

export interface CoverageRow { key: string; count: number; consumed: boolean; }
export interface CoverageReport {
  kinds: CoverageRow[];
  attrs: CoverageRow[];
  /** FR-044 reporting kinds present in the model and deliberately not rendered yet. */
  deferred: CoverageRow[];
  warnings: string[];
}

export class CoverageTracker {
  private kinds = new Set<string>();
  private attrs = new Set<string>();
  consumeNode(n: MetaData): void { this.kinds.add(`${n.type}.${n.subType}`); }
  consumeAttr(n: MetaData, a: string): void { this.attrs.add(`${n.type}:@${a}`); }
  report(root: MetaRoot): CoverageReport {
    const kindCount = new Map<string, number>();
    const attrCount = new Map<string, number>();
    const deferredCount = new Map<string, number>();
    const walk = (n: MetaData) => {
      // FR-044 Plan 1: object.report has no output until its lowering lands (Plan 2/3).
      // Counted as deferred (with its whole subtree), never as a rendering gap.
      if (isReportingVocabulary(n)) {
        deferredCount.set(`${n.type}.${n.subType}`, (deferredCount.get(`${n.type}.${n.subType}`) ?? 0) + 1);
        return;
      }
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
    const deferred = rows(deferredCount, new Set());
    const warnings = [
      ...[...kinds, ...attrs].filter((r) => !r.consumed).map((r) => `coverage: ${r.key} (${r.count}) not rendered by any page`),
      ...deferred.map((r) => `coverage: ${r.key} (${r.count}) deferred (FR-044 Plan 2/3)`),
    ];
    return { kinds, attrs, deferred, warnings };
  }
}
