// The explorer site's requirement views, driven by the ledger the gate itself computes
// (`requirementPayload`) over small real models. The oracle is the gate: each assertion
// names a fact `meta verify` states, and checks the page says the same.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSerializeEffective } from "@metaobjectsdev/metadata";
import { loadMemory } from "@metaobjectsdev/sdk";
import { buildExplorer, generateExplorerSite } from "@metaobjectsdev/docs-site";
import { requirementPayload } from "../src/lib/requirement-payload.js";
import { ERR_REQUIREMENT_DANGLING_REF, WARN_REQUIREMENT_NOTHING_IMPLEMENTS } from "../src/lib/requirement-check.js";
import { WARN_REQUIREMENT_TITLE_IS_AN_ID } from "../src/lib/requirement-lint.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Loads `files`, runs the gate, builds the explorer site, and returns a page reader plus the
 *  gate's own counts. */
async function site(files: Record<string, string>): Promise<{ page: (p: string) => string; undecided: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "explorer-ledger-"));
  dirs.push(dir);
  mkdirSync(join(dir, "metaobjects"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "metaobjects", name), body);
  const root = await loadMemory(dir, { strict: true });
  const verify = requirementPayload(root, { inCoverage: () => true, files: Object.keys(files) });
  if (verify === undefined) throw new Error("the model declares requirements");
  const explorer = buildExplorer({ model: JSON.parse(canonicalSerializeEffective(root)) as unknown, verify });
  const out = join(dir, "site");
  generateExplorerSite({ explorer, outDir: out, title: "Ledger" });
  return { page: (p) => readFileSync(join(out, p), "utf8"), undecided: verify.requirementCounts.undecided };
}

/** The body of the Gaps card titled `title`. */
function gapsCard(gaps: string, title: string): string {
  const card = gaps.split('<div class="card gap">').find((c) => c.startsWith(`<h3>${title} `));
  if (card === undefined) throw new Error(`no "${title}" card`);
  return card;
}

/** The row of a requirement page's proof table that reports `what`. */
function proofRow(html: string, what: string): string {
  const row = html.split("<tr>").find((r) => r.startsWith(`<td>${what}</td>`));
  if (row === undefined) throw new Error(`no "${what}" proof row`);
  return row;
}

/** The `class` attribute values on a page that mark a gate verdict (`v-*`). */
function verdictClasses(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(" ")).filter((c) => c.startsWith("v-"));
}

const billing = (name: string, claim: string): string => `
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

const checkout = `
metadata:
  package: acme::shop
  children:
    - requirement.functional:
        name: Checkout
        level: 1
        status: partial
        statement: "Customers can check out"
        counterexample: "A cart that cannot be paid"
        children:
          - requirement.functional:
              name: Refunds
              level: 2
              status: planned
              statement: "Orders can be refunded"
              counterexample: "A refund nobody can issue"
    - requirement.functional:
        name: Notes
        level: 1
        status: planned
        title: "REQ-12"
        statement: "Orders carry notes"
        counterexample: "A note that is lost"
`;

describe("explorer requirement views follow the gate's ledger", () => {
  test("two packages' requirements at one path each show only their own findings", async () => {
    const s = await site({ "meta.a.yaml": billing("a", "acme::a::Invoice"), "meta.b.yaml": billing("b", "acme::b::Receipt") });
    const a = s.page("requirements/acme/a/Billing.Invoicing.html");
    const b = s.page("requirements/acme/b/Billing.Invoicing.html");
    expect(proofRow(a, "Gate findings")).not.toContain(ERR_REQUIREMENT_DANGLING_REF);
    expect(verdictClasses(a)).toEqual([]);
    expect(proofRow(b, "Gate findings")).toContain(ERR_REQUIREMENT_DANGLING_REF);
    const gate = gapsCard(s.page("gaps.html"), "Gate findings");
    const dangling = gate.split("<tr>").find((r) => r.includes(ERR_REQUIREMENT_DANGLING_REF));
    expect(dangling).toContain('href="requirements/acme/b/Billing.Invoicing.html"');
    expect(gate).not.toContain('href="requirements/acme/a/Billing.Invoicing.html"');
  });

  test("an authoring advisory is listed as one and never drawn as a gate verdict", async () => {
    const s = await site({ "meta.shop.yaml": checkout });
    const notes = s.page("requirements/acme/shop/Notes.html");
    expect(verdictClasses(notes)).toEqual([]);
    expect(proofRow(notes, "Authoring advisories")).toContain(WARN_REQUIREMENT_TITLE_IS_AN_ID);
    expect(proofRow(notes, "Gate findings")).not.toContain(WARN_REQUIREMENT_TITLE_IS_AN_ID);
    const gaps = s.page("gaps.html");
    expect(gapsCard(gaps, "Gate findings")).not.toContain(WARN_REQUIREMENT_TITLE_IS_AN_ID);
    expect(gapsCard(gaps, "Gate findings")).toContain(WARN_REQUIREMENT_NOTHING_IMPLEMENTS);
    const lint = gapsCard(gaps, "Authoring advisories");
    expect(lint).toContain(WARN_REQUIREMENT_TITLE_IS_AN_ID);
    expect(verdictClasses(lint)).toEqual([]);
  });

  test("the undecided card matches the gate: a partial parent over a planned child is not owed", async () => {
    const s = await site({ "meta.shop.yaml": checkout });
    expect(s.undecided).toBe(2);
    const card = gapsCard(s.page("gaps.html"), "Undecided gaps");
    expect(card).toContain('<span class="count">2</span>');
    expect(card).toContain('href="requirements/acme/shop/Checkout.Refunds.html"');
    expect(card).toContain('href="requirements/acme/shop/Notes.html"');
    expect(card).not.toContain('href="requirements/acme/shop/Checkout.html"');
  });
});
