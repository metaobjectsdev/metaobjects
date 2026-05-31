// test/integrity/baseline-marker.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { ensureLedger, recordBaseline, baselineRecord } from "../../src/apply/ledger.js";

const tmps: string[] = [];
function db(file: string) { return new Kysely<Record<string, unknown>>({ dialect: new LibsqlDialect({ url: `file:${file}` }) }); }
async function root() { const d = await mkdtemp(join(tmpdir(), "baseline-")); tmps.push(d); return d; }
afterAll(async () => { for (const d of tmps) await rm(d, { recursive: true, force: true }); });

describe("ledger baseline marker", () => {
  test("recordBaseline stores the checksum; baselineRecord reads it back", async () => {
    const k = db(join(await root(), "b.db"));
    try {
      await ensureLedger(k, "sqlite");
      expect(await baselineRecord(k, "sqlite")).toBeNull();
      await recordBaseline(k, "sqlite", "abc123checksum");
      const rec = await baselineRecord(k, "sqlite");
      expect(rec?.checksum).toBe("abc123checksum");
    } finally { await k.destroy(); }
  });
});
