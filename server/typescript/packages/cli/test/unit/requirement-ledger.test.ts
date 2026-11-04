// `requirementLedgerRows` — the per-requirement rows `meta verify --format json` carries.
//
// A requirement's dotted path carries no package, so two packages may each declare one at
// the same path. Each row must hold only the findings against its own node: a finding
// against one package's `Billing` is not a finding against the other's.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  checkRequirements,
  scanRequirements,
  WARN_REQUIREMENT_OBJECT_UNCLAIMED,
} from "../../src/lib/requirement-check.js";
import { lintRequirements } from "../../src/lib/requirement-lint.js";
import { requirementLedgerRows } from "../../src/lib/requirement-ledger.js";

const pkg = (name: string, claim: string): string => `
metadata:
  package: acme::${name}
  children:
    - object.entity:
        name: Invoice
        children:
          - source.rdb: { table: ${name}_invoices }
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
    - requirement.functional:
        name: Billing
        level: 1
        status: live
        statement: "Invoices are issued"
        counterexample: "A sale with no invoice"
        children:
          - requirement.functional:
              name: Invoicing
              level: 4
              status: live
              statement: "Each invoice is stored"
              counterexample: "An invoice that cannot be found again"
              implementedBy: ["${claim}"]
`;

describe("requirementLedgerRows", () => {
  test("two packages' requirements at one path keep their own findings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "req-ledger-"));
    try {
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, "metaobjects/meta.a.yaml"), pkg("a", "acme::a::Invoice"));
      writeFileSync(join(dir, "metaobjects/meta.b.yaml"), pkg("b", "acme::b::Receipt"));
      const root = await loadMemory(dir, { strict: true });
      const scan = scanRequirements(root);
      const gate = checkRequirements(root, scan);
      expect(gate.length).toBeGreaterThan(0);
      for (const d of [...gate, ...lintRequirements(root, scan.addressed)]) {
        // Only the object-coverage row names a structured `node` (the unclaimed entity).
        const allowed = ["code", "message", "path", "severity"];
        if (d.code === WARN_REQUIREMENT_OBJECT_UNCLAIMED) allowed.push("node");
        expect(Object.keys(d).filter((k) => !allowed.includes(k))).toEqual([]);
      }
      const rows = requirementLedgerRows(root, scan, gate, lintRequirements(root, scan.addressed));
      const verdicts = rows.map((r) => [r.qualifiedPath, r.verdict, r.diagnostics.map((d) => d.code)]);
      expect(verdicts).toEqual([
        ["acme::a::Billing", "clean", []],
        ["acme::a::Billing.Invoicing", "clean", []],
        ["acme::b::Billing", "clean", []],
        ["acme::b::Billing.Invoicing", "error", ["ERR_REQUIREMENT_DANGLING_REF"]],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
