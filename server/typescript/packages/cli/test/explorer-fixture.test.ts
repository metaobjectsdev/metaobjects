// The explorer data spine, end to end, over `fixtures/explorer-conformance/shop/`:
//
//   `meta export --effective`   → effective.json   (committed)
//   `meta verify --format json` → verify.json      (committed; carries `requirementLedger`)
//   buildExplorer(both + the manifest)             → expected.json (committed, byte-checked in docs-site)
//
// This file keeps the committed INPUTS honest: regenerating them from `project/` must give
// the same bytes, so a change to either command's output shows up here as a fixture diff
// rather than as an explorer that quietly reads stale data.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildExplorer, serializeExplorer } from "@metaobjectsdev/docs-site";
import { run } from "../src/index.js";

const FIXTURE = resolve(import.meta.dir, "../../../../../fixtures/explorer-conformance/shop");
const PROJECT = join(FIXTURE, "project");
const committed = (name: string): string => readFileSync(join(FIXTURE, name), "utf8");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let out: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
beforeEach(() => {
  out = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = () => {};
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

async function exportJson(effective: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "explorer-export-"));
  dirs.push(dir);
  const file = join(dir, "model.json");
  const exit = await run(["export", ...(effective ? ["--effective"] : []), "--out", file, "--cwd", PROJECT]);
  expect(exit).toBe(0);
  return readFileSync(file, "utf8");
}

async function verifyJson(): Promise<string> {
  const exit = await run(["verify", "--format", "json", "--cwd", PROJECT]);
  expect(exit).toBe(0);
  return out.join("\n") + "\n";
}

interface LedgerRow {
  path: string;
  qualifiedPath: string;
  verdict: string;
  digest: string;
  implementedBy: { ref: string; resolves: boolean; target?: string }[];
  diagnostics: { code: string; severity: string; source: string; message: string }[];
}

describe("explorer fixture — the committed inputs are what the CLI writes today", () => {
  test("`meta export --effective` reproduces effective.json", async () => {
    expect(await exportJson(true)).toBe(committed("effective.json"));
  });

  test("`meta verify --format json` reproduces verify.json", async () => {
    expect(await verifyJson()).toBe(committed("verify.json"));
  });

  test("the fresh inputs build the committed expected.json", async () => {
    const model = JSON.parse(await exportJson(true));
    out = [];
    const verify = JSON.parse(await verifyJson());
    const manifest = JSON.parse(committed("hashes.json"));
    expect(serializeExplorer(buildExplorer({ model, verify, manifest }))).toBe(committed("expected.json"));
  });
});

describe("meta export --effective", () => {
  test("materializes inherited members; the plain export does not", async () => {
    const own = JSON.parse(await exportJson(false));
    const eff = JSON.parse(await exportJson(true));
    const fieldNames = (doc: unknown, object: string): string[] => {
      const root = (doc as { "metadata.root": { children: Record<string, { name: string; children?: Record<string, { name?: string }>[] }>[] } })["metadata.root"];
      const node = root.children.map((c) => Object.values(c)[0]).find((b) => b?.name === object);
      return (node?.children ?? []).map((c) => Object.values(c)[0]?.name ?? "");
    };
    expect(fieldNames(own, "Customer")).not.toContain("id");
    expect(fieldNames(eff, "Customer")).toContain("id");
    expect(fieldNames(eff, "Customer")).toContain("createdAt");
  });
});

describe("meta verify --format json — requirementLedger rows", () => {
  async function rows(): Promise<Map<string, LedgerRow>> {
    const payload = JSON.parse(await verifyJson()) as { requirementLedger: LedgerRow[] };
    return new Map(payload.requirementLedger.map((r) => [r.path, r]));
  }

  test("one row per requirement, in document order, each with a sha-256 digest", async () => {
    const r = await rows();
    expect([...r.keys()]).toEqual([
      "Addressable",
      "Shop",
      "Shop.Checkout",
      "Shop.Checkout.Orders",
      "Shop.Checkout.Orders.Recorded",
      "Shop.Checkout.Orders.Recorded.Quotable",
      "Shop.Checkout.Orders.Noted",
      "Shop.Checkout.Orders.Refunded",
      "Shop.Checkout.Shipping",
    ]);
    for (const row of r.values()) expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.get("Shop.Checkout")?.qualifiedPath).toBe("acme::shop::Shop.Checkout");
  });

  test("each @implementedBy link carries the node the gate resolved it to", async () => {
    const r = await rows();
    expect(r.get("Shop.Checkout.Orders.Recorded")?.implementedBy).toEqual([
      { ref: "Order", resolves: true, target: "acme::shop::Order" },
      { ref: "Customer", resolves: true, target: "acme::shop::Customer" },
    ]);
    expect(r.get("Shop.Checkout.Orders.Recorded.Quotable")?.implementedBy).toEqual([
      { ref: "Order.reference", resolves: true, target: "acme::shop::Order.reference" },
    ]);
    // A planned requirement may name a node that does not exist yet: the row says so.
    expect(r.get("Shop.Checkout.Orders.Refunded")?.implementedBy).toEqual([{ ref: "Refund", resolves: false }]);
  });

  test("the verdict comes from the gate's findings against that path", async () => {
    const r = await rows();
    const shipping = r.get("Shop.Checkout.Shipping");
    expect(shipping?.verdict).toBe("warn");
    expect(shipping?.diagnostics).toEqual([
      {
        code: "WARN_REQUIREMENT_NOTHING_IMPLEMENTS",
        severity: "warn",
        source: "gate",
        message: expect.stringContaining("is 'live' but neither it nor anything nested under it names an implementing node"),
      },
    ]);
    expect(r.get("Shop.Checkout.Orders.Recorded")?.verdict).toBe("clean");
  });

  test("text output carries no ledger rows", async () => {
    const exit = await run(["verify", "--format", "text", "--cwd", PROJECT]);
    expect(exit).toBe(0);
    expect(out.join("\n")).not.toContain("requirementLedger");
  });
});
