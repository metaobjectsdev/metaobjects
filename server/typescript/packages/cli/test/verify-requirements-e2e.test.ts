// `meta verify` + requirements — the EXIT CODE contract, end to end.
//
// The unit tests in test/unit/requirement-check.test.ts assert what
// `checkRequirements()` returns. They cannot tell you what `meta verify` DOES with
// it: whether a diagnostic reaches the exit code, whether a warning stays a warning,
// or whether the loader refuses the file before verify runs at all. Those are the
// things an adopter's CI actually depends on, and until this file existed they were
// only ever checked by hand.
//
// Each case drives the real command dispatcher, so a regression in the wiring —
// requirements silently unhooked from the exit-code max, say — fails here.

import { test, expect, describe, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";
import { log } from "../src/lib/log.js";

/** Collects `log.info` lines emitted while `fn` runs. */
async function captureInfo(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const spy = spyOn(log, "info").mockImplementation((m: string) => { seen.push(m); });
  try { await fn(); } finally { spy.mockRestore(); }
  return seen;
}

/** Collects `log.warn` lines emitted while `fn` runs. */
async function captureWarn(fn: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const spy = spyOn(log, "warn").mockImplementation((m: string) => { seen.push(m); });
  try { await fn(); } finally { spy.mockRestore(); }
  return seen;
}

// verify lazily imports its (heavy) command module on first dispatch; a cold runner
// can exceed bun's default 5s. Generous timeout, still fails loudly on a real hang.
const TIMEOUT_MS = 30_000;

const ENTITIES = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.uuid": { name: "id" } },
            { "field.string": { name: "reference" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** A project with the given requirements file (raw JSON string), or none at all. */
function project(requirements?: string, extra?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vreq-"));
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.shop.json"), ENTITIES);
  if (requirements !== undefined) {
    writeFileSync(join(dir, "metaobjects", "meta.requirements.json"), requirements);
  }
  for (const [rel, body] of Object.entries(extra ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

const req = (fields: Record<string, unknown>, subType = "functional") =>
  JSON.stringify({
    "metadata.root": { package: "acme::shop", children: [{ [`requirement.${subType}`]: fields }] },
  });

const L4 = {
  name: "orderRecord",
  "@level": 4,
  "@status": "live",
  "@statement": "An order is a durable record.",
  "@counterexample": "An order vanishes on restart.",
};

describe("meta verify — requirements exit-code contract", () => {
  test("a clean requirement tree exits 0", async () => {
    const dir = project(req({ ...L4, "@implementedBy": ["Order"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(0);
  }, TIMEOUT_MS);

  // The summary is printed on EVERY run precisely so a gate that passes is
  // distinguishable from a gate that checked nothing — and until now nothing asserted
  // that it prints at all, which is the same shape of hole it exists to close.
  test("a CLEAN run still prints the summary, with the denominator's provenance", async () => {
    const dir = project(req({ ...L4, "@implementedBy": ["Order"] }));
    // --format text explicitly: this asserts the HUMAN summary line, and the test
    // runner is not a TTY, where the CLI's default format is TOON — for `verify`
    // as it already was for `gen` and `migrate`. In a structured run this line is
    // narration and moves to stderr, with the same counts carried as payload
    // fields (asserted in verify-structured-output.test.ts).
    const lines = await captureInfo(() => run(["verify", "--format", "text", "--cwd", dir]));

    const summary = lines.find((l) => l.includes("requirements:"));
    expect(summary).toBeDefined();
    expect(summary).toContain("1 entries");
    expect(summary).toContain("1/1 entities claimed");

    // `entitiesTotal` is only ever computed over what LOADED, so a spine covering half
    // an estate reports the covered half as fully claimed. No check can see a tree it
    // was never pointed at; publishing the count it was taken over is what makes a
    // wrong denominator noticeable. Two files here: the entities and the requirements.
    expect(summary).toContain("counted over 2 metadata file(s)");
  }, TIMEOUT_MS);

  test("a model with NO requirements exits 0 — opt-in by declaration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vreq-"));
    mkdirSync(join(dir, "metaobjects"), { recursive: true });
    writeFileSync(join(dir, "metaobjects", "meta.shop.json"), ENTITIES);
    expect(await run(["verify", "--cwd", dir])).toBe(0);
  }, TIMEOUT_MS);

  test("a dangling @implementedBy on status=live exits 1", async () => {
    const dir = project(req({ ...L4, "@implementedBy": ["Ordur"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  // FR-038 (#337) REVERSED this. It used to assert the opposite — that the SAME
  // unresolved reference was an error on `live` and EXPECTED on `abandoned`, because
  // those nodes were "meant to be gone". That exemption is what the retirement
  // removed, and the deciding evidence was second-order: because `verify` was silent
  // on exactly those two statuses, one adopting estate held 29 refs that could never
  // resolve across 14 entries while `meta verify` reported zero dangling refs — true
  // and incomplete at once. There is now no status that exempts a dangling ref, and
  // the two that did no longer parse.
  test("a legacy status=abandoned fails the LOAD — the exempting statuses are gone", async () => {
    const dir = project(req({ ...L4, "@status": "abandoned", "@implementedBy": ["Ordur"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  // The surviving statuses carry no exemption either: `partial` means there IS a gap,
  // not that a reference may point at nothing.
  test("a dangling reference on status=partial exits 1 — no status exempts it", async () => {
    const dir = project(req({ ...L4, "@status": "partial", "@implementedBy": ["Ordur"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  test("@implementedBy above the L4 link floor exits 1", async () => {
    const dir = project(req({ ...L4, "@level": 2, "@implementedBy": ["Order"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  // Refused by the LOADER, before verify runs — the difference between registered
  // vocabulary and a hand-parsed side file.
  test("a typo'd @status exits 1 (loader refuses the load)", async () => {
    const dir = project(req({ ...L4, "@status": "abandonned", "@implementedBy": ["Order"] }));
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  test("a live architectural requirement claimed by nothing exits 1", async () => {
    const dir = project(
      req(
        {
          name: "uuidPks",
          "@status": "live",
          "@statement": "Every entity has a uuid primary key.",
          "@counterexample": "An entity keyed by a composite string.",
        },
        "architectural",
      ),
    );
    expect(await run(["verify", "--cwd", dir])).toBe(1);
  }, TIMEOUT_MS);

  // Coverage is advisory: an unclaimed entity WARNS and must not fail the build.
  // If this flips to 1, OBJECT_COVERAGE_SEVERITY was promoted without the
  // completeness precondition its comment requires.
  test("an unclaimed entity WARNS but still exits 0", async () => {
    const dir = project(
      req({ ...L4, name: "unrelated", "@implementedBy": [] }),
    );
    expect(await run(["verify", "--cwd", dir])).toBe(0);
  }, TIMEOUT_MS);

  // FR-038: `@verifiedBy` is retired vocabulary. It used to be scanned against the
  // test corpus; both arms of that scan (name found / name missing) are gone, and
  // what replaces them is a LOAD failure — the sealed registry refuses the attr
  // before verify runs at all. Pinning the load failure is the point: a silent
  // accept would mean the retirement never happened in this port.
  test("@verifiedBy is retired — metadata carrying it fails to load", async () => {
    const dir = project(
      req({ ...L4, "@implementedBy": ["Order"], "@verifiedBy": ["OrderServiceTest"] }),
      { "test/order.test.ts": "test('OrderServiceTest', () => {});" },
    );
    // Non-zero either way; the naming a real, present test is deliberate — under
    // the old scan this exact project exited 0.
    expect(await run(["verify", "--cwd", dir])).not.toBe(0);
  }, TIMEOUT_MS);

  // -- the authoring lint reaches the command, and stops there ----------------
  // The unit tests prove what `lintRequirements()` returns. These prove `meta
  // verify` prints it and that it cannot reach the exit code — which is the whole
  // safety argument for turning a new check on by default in a shipping gate.

  test("an authoring warning is printed under its own heading and still exits 0", async () => {
    const dir = project(
      req({
        ...L4,
        "@implementedBy": ["Order"],
        "@title": "FR-467 — Order recording",
      }),
    );
    const warns = await captureWarn(async () => {
      expect(await run(["verify", "--cwd", dir])).toBe(0);
    });
    // Its OWN heading, separate from the gate's warnings — the separate cap is
    // what stops a few hundred prose findings burying every unclaimed-entity line.
    expect(warns.some((w) => w.includes("authoring warning"))).toBe(true);
    expect(warns.some((w) => w.includes("WARN_REQUIREMENT_TITLE_IS_AN_ID"))).toBe(true);
  }, TIMEOUT_MS);

  test("a cleanly authored ledger prints no lint section at all", async () => {
    // Carries a well-formed `@title` deliberately: it is CHARTERED on a requirement
    // (spec/capability-ledger.md's requirement attribute table), so a lint that fires
    // here would be telling two real adopters to delete 355 authored labels.
    const dir = project(req({ ...L4, "@implementedBy": ["Order"], "@title": "Order recording" }));
    const warns = await captureWarn(async () => {
      expect(await run(["verify", "--cwd", dir])).toBe(0);
    });
    expect(warns.some((w) => w.includes("authoring warning"))).toBe(false);
  }, TIMEOUT_MS);

  test("--no-requirement-lint mutes the lint but leaves the GATE failing", async () => {
    // The split is the point: muting the advisory half must not mute the half that
    // can fail a build, or the flag becomes "turn off requirements checking".
    const dir = project(
      req({
        ...L4,
        "@implementedBy": ["NoSuchEntity"],
        "@title": "FR-467 — Order recording",
      }),
    );
    const warns = await captureWarn(async () => {
      expect(await run(["verify", "--cwd", dir, "--no-requirement-lint"])).toBe(1);
    });
    expect(warns.some((w) => w.includes("authoring warning"))).toBe(false);
  }, TIMEOUT_MS);

  test("META_NO_REQUIREMENT_LINT=1 mutes it too", async () => {
    const dir = project(req({ ...L4, "@implementedBy": ["Order"], "@title": "FR-467" }));
    process.env.META_NO_REQUIREMENT_LINT = "1";
    try {
      const warns = await captureWarn(async () => {
        expect(await run(["verify", "--cwd", dir])).toBe(0);
      });
      expect(warns.some((w) => w.includes("authoring warning"))).toBe(false);
    } finally {
      delete process.env.META_NO_REQUIREMENT_LINT;
    }
  }, TIMEOUT_MS);

  test("a project with no requirements is never linted", async () => {
    const dir = project();
    const warns = await captureWarn(async () => {
      expect(await run(["verify", "--cwd", dir])).toBe(0);
    });
    expect(warns.some((w) => w.includes("authoring warning"))).toBe(false);
  }, TIMEOUT_MS);
});
