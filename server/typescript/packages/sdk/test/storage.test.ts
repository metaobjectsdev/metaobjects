import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRecord } from "../src/storage/write.js";
import { readRecord, recordExists } from "../src/storage/read.js";
import { ForgeRecordNotFoundError } from "../src/storage/errors.js";

let metaRoot: string;
beforeEach(() => {
  metaRoot = mkdtempSync(join(tmpdir(), "metaobjects-storage-"));
  mkdirSync(join(metaRoot, "memory"), { recursive: true });
});
afterEach(() => {
  rmSync(metaRoot, { recursive: true, force: true });
});

const aDecision = {
  schema_version: 1 as const,
  type: "decision" as const,
  id: "decision-tanstack",
  title: "Use TanStack Query",
  confidence: 1,
  source: "human" as const,
  captured_at: "2026-05-09T00:00:00Z",
  last_validated_against_commit: "abc",
  deviations: [],
  rationale: "Why",
  alternatives_considered: ["Redux"],
  scope: "global" as const,
};

describe("writeRecord", () => {
  test("writes a record to the canonical path", async () => {
    await writeRecord(metaRoot, aDecision);
    const round = await readRecord(metaRoot, "decision", "decision-tanstack");
    expect(round.id).toBe("decision-tanstack");
  });
  test("throws on invalid record before any IO", async () => {
    const bad = { ...aDecision, confidence: 5 };
    await expect(writeRecord(metaRoot, bad as never)).rejects.toThrow();
  });
  test("writes to _pending when opts.pending is true", async () => {
    await writeRecord(metaRoot, aDecision, { pending: true });
    expect(await recordExists(metaRoot, "decision", "decision-tanstack", { pending: true })).toBe(true);
    expect(await recordExists(metaRoot, "decision", "decision-tanstack")).toBe(false);
  });
});

describe("readRecord", () => {
  test("throws ForgeRecordNotFoundError when missing", async () => {
    await expect(readRecord(metaRoot, "decision", "missing")).rejects.toBeInstanceOf(
      ForgeRecordNotFoundError,
    );
  });
  test("round-trips a record losslessly", async () => {
    await writeRecord(metaRoot, aDecision);
    const round = await readRecord(metaRoot, "decision", "decision-tanstack");
    expect(round).toEqual(aDecision);
  });
});

describe("recordExists", () => {
  test("returns false when record does not exist", async () => {
    expect(await recordExists(metaRoot, "decision", "x")).toBe(false);
  });
  test("returns true after write", async () => {
    await writeRecord(metaRoot, aDecision);
    expect(await recordExists(metaRoot, "decision", "decision-tanstack")).toBe(true);
  });
});
import { listRecords } from "../src/storage/list.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join as joinPath } from "node:path";

describe("listRecords", () => {
  test("returns empty array when directory missing", async () => {
    expect(await listRecords(metaRoot, "decision")).toEqual([]);
  });
  test("returns parsed records", async () => {
    await writeRecord(metaRoot, aDecision);
    const list = await listRecords(metaRoot, "decision");
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("decision-tanstack");
  });
  test("skips invalid files and reports them via onInvalid", async () => {
    await writeRecord(metaRoot, aDecision);
    const dir = joinPath(metaRoot, "memory", "decision");
    await mkdir(dir, { recursive: true });
    await writeFile(joinPath(dir, "broken.json"), "{not json", "utf8");

    const invalids: Array<{ path: string; err: unknown }> = [];
    const list = await listRecords(metaRoot, "decision", {
      onInvalid: (path, err) => invalids.push({ path, err }),
    });
    expect(list).toHaveLength(1);
    expect(invalids).toHaveLength(1);
    expect(invalids[0]!.path).toContain("broken.json");
  });
});
import { promoteRecord, supersede } from "../src/storage/lifecycle.js";
import { ForgeAlreadyPromotedError, ForgeRecordNotFoundError as NotFoundError } from "../src/storage/errors.js";

describe("promoteRecord", () => {
  test("moves a pending record to canonical", async () => {
    await writeRecord(metaRoot, aDecision, { pending: true });
    await promoteRecord(metaRoot, "decision", "decision-tanstack");
    expect(await recordExists(metaRoot, "decision", "decision-tanstack")).toBe(true);
    expect(await recordExists(metaRoot, "decision", "decision-tanstack", { pending: true })).toBe(false);
  });
  test("throws if pending source does not exist", async () => {
    await expect(promoteRecord(metaRoot, "decision", "missing")).rejects.toBeInstanceOf(NotFoundError);
  });
  test("throws if canonical already exists", async () => {
    await writeRecord(metaRoot, aDecision);
    await writeRecord(metaRoot, aDecision, { pending: true });
    await expect(promoteRecord(metaRoot, "decision", "decision-tanstack")).rejects.toBeInstanceOf(
      ForgeAlreadyPromotedError,
    );
  });
});

describe("supersede", () => {
  test("writes new record and marks old as superseded", async () => {
    await writeRecord(metaRoot, aDecision);
    const replacement = { ...aDecision, id: "decision-tanstack-v2", title: "v2" };
    await supersede(metaRoot, "decision-tanstack", replacement);

    const old = await readRecord(metaRoot, "decision", "decision-tanstack");
    expect(old.superseded_by).toBe("decision-tanstack-v2");

    const fresh = await readRecord(metaRoot, "decision", "decision-tanstack-v2");
    expect(fresh.id).toBe("decision-tanstack-v2");
  });
  test("throws if old record does not exist", async () => {
    const replacement = { ...aDecision, id: "x" };
    await expect(supersede(metaRoot, "missing", replacement)).rejects.toBeInstanceOf(NotFoundError);
  });
});
import type { AnyRecord } from "../src/records/any.js";

describe("storage round-trips for every record type", () => {
  const samples: AnyRecord[] = [
    {
      schema_version: 1,
      type: "convention",
      id: "convention-handler-default-export",
      title: "API handlers default-export",
      confidence: 0.9,
      source: "human",
      captured_at: "2026-05-09T00:00:00Z",
      last_validated_against_commit: "abc",
      deviations: [],
      pattern_description: "default export",
      examples: ["src/api/x.ts"],
      applies_to: ["src/api/**"],
    },
    aDecision,
    {
      schema_version: 1,
      type: "principle",
      id: "principle-no-redux",
      title: "No Redux",
      confidence: 1,
      source: "human",
      captured_at: "2026-05-09T00:00:00Z",
      last_validated_against_commit: "abc",
      deviations: [],
      statement: "Never Redux",
      rationale: "TanStack Query is enough",
      scope: ["src/**"],
      examples: [],
      counter_examples: [],
      enforcement: "advisory",
    },
    {
      schema_version: 1,
      type: "glossary",
      id: "glossary-auditable",
      title: "Auditable",
      confidence: 1,
      source: "human",
      captured_at: "2026-05-09T00:00:00Z",
      last_validated_against_commit: "abc",
      deviations: [],
      term: "Auditable",
      synonyms: [],
      definition: "Has timestamps",
      code_anchors: { entity: "Auditable" },
      see_also: [],
    },
    {
      schema_version: 1,
      type: "failure",
      id: "failure-redux",
      title: "Redux refactor failed",
      confidence: 1,
      source: "human",
      captured_at: "2026-05-09T00:00:00Z",
      last_validated_against_commit: "abc",
      deviations: [],
      what_was_tried: "Redux for server state",
      why_it_failed: "Worse DX than TanStack",
    },
  ];

  test("round-trips every record type losslessly", async () => {
    for (const record of samples) {
      await writeRecord(metaRoot, record);
      const round = await readRecord(metaRoot, record.type, record.id);
      expect(round).toEqual(record);
    }
  });
});
