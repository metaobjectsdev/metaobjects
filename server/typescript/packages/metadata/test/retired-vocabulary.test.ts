// The retired-vocabulary map — turning "unknown X" into "retired in V, here is the migration".
//
// WHY THIS EXISTS (#337). An adopter's ledger stopped loading on 0.24.0 and the error said
// `@verifiedBy` was "not declared by any registered provider". That is TRUE and it is the
// wrong story: it tells the author their metadata is malformed, when in fact the vocabulary
// was retired deliberately, in a documented release, with a written migration. Reading the
// generic error they concluded the tool had a registration BUG, filed it as one, and argued
// against a decision whose reasoning they never found — because nothing in the error pointed
// at it.
//
// The map's entire job is that pointer. It changes no load outcome: retired vocabulary still
// fails, with the same error code. Only the message improves.

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  retiredAttr,
  retiredAttrValue,
  retiredSubType,
  RETIRED_VOCABULARY,
} from "../src/retired-vocabulary.js";

describe("retiredAttr", () => {
  test("knows @verifiedBy retired from requirement.*", () => {
    const note = retiredAttr("requirement.architectural", "verifiedBy");
    expect(note).toBeDefined();
    expect(note?.since).toBe("0.24.0");
    expect(note?.migration).toContain("verified-by-retirement");
  });

  test("matches a wildcard type entry across every subtype of that type", () => {
    expect(retiredAttr("requirement.functional", "verifiedBy")).toBeDefined();
    expect(retiredAttr("requirement.architectural", "verifiedBy")).toBeDefined();
  });

  test("@supersededBy is NOT retired — FR-039 registered it again, resolving", () => {
    expect(retiredAttr("requirement.functional", "supersededBy")).toBeUndefined();
    expect(retiredAttr("requirement.architectural", "supersededBy")).toBeUndefined();
  });

  test("knows @readOnly became @mutability", () => {
    const note = retiredAttr("field.string", "readOnly");
    expect(note?.since).toBe("0.24.0");
    expect(note?.replacedBy).toBe("@mutability");
  });

  test("is scoped by TYPE — @unique is retired on identity.secondary only", () => {
    expect(retiredAttr("identity.secondary", "unique")).toBeDefined();
    // `@unique` remains live vocabulary on a field; a blanket name match would
    // mislabel a perfectly valid declaration as retired, which is worse than the
    // generic message it replaces.
    expect(retiredAttr("field.string", "unique")).toBeUndefined();
  });

  test("returns undefined for a genuine typo — the common case must stay generic", () => {
    expect(retiredAttr("field.string", "maxLenght")).toBeUndefined();
    expect(retiredAttr("object.entity", "notAThing")).toBeUndefined();
  });
});

describe("retiredAttrValue", () => {
  test("knows @status: abandoned and superseded are rewritten to `retired` (FR-039)", () => {
    // Still retired VALUES — authoring either fails the load — but 0.24.2 made the fix
    // mechanical rather than a refusal, so the `since` moves with the entry that owns it.
    expect(retiredAttrValue("requirement.functional", "status", "abandoned")?.since).toBe("0.24.2");
    expect(retiredAttrValue("requirement.functional", "status", "superseded")?.since).toBe("0.24.2");
  });

  test("a surviving value of the same attr is NOT reported as retired", () => {
    expect(retiredAttrValue("requirement.functional", "status", "live")).toBeUndefined();
    expect(retiredAttrValue("requirement.functional", "status", "planned")).toBeUndefined();
  });

  test("knows the dropped @dbColumnType array kinds", () => {
    expect(retiredAttrValue("field.uuid", "dbColumnType", "uuid_array")).toBeDefined();
    expect(retiredAttrValue("field.string", "dbColumnType", "text_array")).toBeDefined();
  });
});

describe("retiredSubType", () => {
  test("knows origin.collection retired to reserved-not-registered", () => {
    const note = retiredSubType("origin", "collection");
    expect(note?.since).toBe("0.24.0");
    expect(note?.migration).toContain("origin-collection-retirement");
  });

  test("returns undefined for a live subtype", () => {
    expect(retiredSubType("origin", "aggregate")).toBeUndefined();
    expect(retiredSubType("field", "string")).toBeUndefined();
  });
});

describe("the map itself", () => {
  // Every entry promises a document. A pointer to a file that does not exist is worse
  // than no pointer: it sends the reader looking and then strands them, which is the
  // exact failure #337 is about.
  test("every migration guide named actually EXISTS on disk", () => {
    // Checking the path SHAPE would pass against a file nobody ever wrote. The claim this
    // map makes is "go read this", so the test has to be that the document is there.
    const repoRoot = resolve(import.meta.dir, "../../../../..");
    for (const e of RETIRED_VOCABULARY) {
      if (e.migration === undefined) continue;
      expect(e.migration).toStartWith("docs/features/migrations/");
      const abs = join(repoRoot, e.migration);
      if (!existsSync(abs)) throw new Error(`${e.type}.${e.subType}: missing guide ${e.migration}`);
    }
  });

  test("every entry states the version that retired it", () => {
    for (const e of RETIRED_VOCABULARY) {
      expect(e.since).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("every entry says something about what to do instead", () => {
    for (const e of RETIRED_VOCABULARY) {
      expect((e.replacedBy ?? "") + (e.migration ?? "") + e.why).not.toBe("");
    }
  });
});

// ── `rewrite`: what `meta upgrade` can do mechanically, and what it must refuse ──
//
// The split is the honest half of the feature. A tool that silently skipped the judgment
// cases would report success on a half-migrated ledger — worse than refusing outright,
// because the adopter would believe the migration was finished.
describe("mechanical rewrites", () => {
  test("every entry either rewrites mechanically OR names a guide for the human", () => {
    for (const e of RETIRED_VOCABULARY) {
      if (e.rewrite === undefined && e.migration === undefined) {
        throw new Error(`${e.type}.${e.subType} ${e.attr ?? ""}: no rewrite and no guide — a dead end`);
      }
    }
  });

  test("a VALUE retirement never claims a plain key rename", () => {
    // `@status: abandoned` cannot be fixed by renaming the key. Claiming otherwise would
    // emit metadata that loads and means something different — the worst outcome available.
    for (const e of RETIRED_VOCABULARY) {
      if (e.attrValues !== undefined && e.rewrite?.kind === "renameAttr") {
        throw new Error(`${String(e.attr)}: a value retirement cannot be a key rename`);
      }
    }
  });

  test("@verifiedBy is mechanically droppable", () => {
    expect(RETIRED_VOCABULARY.find((x) => x.attr === "verifiedBy")?.rewrite?.kind).toBe("dropAttr");
  });

  test("@status: abandoned is MECHANICAL now — it rewrites to `retired` (FR-039)", () => {
    // This was the canonical judgement case: 0.24.0 deleted the capability, so what
    // became of a retired entry's record was the author's call and `meta upgrade`
    // refused. FR-039 restored the capability under a prescriptive name, which makes
    // the edit determinate — the entry it names is the one the loader now accepts.
    const e = RETIRED_VOCABULARY.find((x) => x.attrValues?.includes("abandoned") === true);
    expect(e?.rewrite).toEqual({
      kind: "renameAttrValue",
      toAttr: "status",
      fromValue: "abandoned",
      toValue: "retired",
      otherwise: "refuse",
    });
    expect(e?.migration).toContain("retired-status-restore");
  });

  test("@status: superseded rewrites to `retired` too — the pointer is @supersededBy", () => {
    const e = RETIRED_VOCABULARY.find((x) => x.attrValues?.includes("superseded") === true);
    expect(e?.rewrite).toMatchObject({ fromValue: "superseded", toValue: "retired" });
  });

  test("@readOnly carries a key+value rewrite, not a bare rename", () => {
    expect(RETIRED_VOCABULARY.find((x) => x.attr === "readOnly")?.rewrite?.kind).toBe("renameAttrValue");
  });
});
