// The advisory passes must be REACHABLE, not just emitted.
//
// The defect these pin: `meta gen`/`meta verify` run an advisory scan that reports
// where a project hand-rolls what MetaObjects can model. On one adopter estate it
// found 239 sites and printed 10 ("…and 229 more"), and the other 96% were
// reachable by NOTHING — not `--help | grep`, not an env var, not `--json`. Worse,
// the findings existed only as stderr TEXT: `meta gen --format json` emitted a
// payload that mentioned none of them, so an agent reading the documented
// structured output of a run carrying hundreds of findings saw a clean result and
// reported "all green".
//
// Four properties are pinned here, and the last is the one most easily broken by
// accident:
//   1. the structured payload CONTAINS the findings, with their real fields;
//   2. `meta verify --format json` emits a structured document at all (it used to
//      accept the flag, exit 0, and print human text);
//   3. the structured payload is UNCAPPED — more findings than the text cap yields
//      all of them;
//   4. EXIT CODES are unchanged in every case. The advisory is warnings-only by
//      design ("ADVISORY ONLY — never a non-zero exit"), and making it
//      machine-readable must not promote it to a build failure.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";
import { DEFAULT_ADVISORY_LIMIT } from "../src/lib/advisory.js";

// verify/gen lazily import their (heavy) command modules on first dispatch; a cold
// runner can exceed bun's default 5s.
const TIMEOUT_MS = 30_000;

/** More money-float sites than the text cap, so truncation is observable. */
const FINDINGS = DEFAULT_ADVISORY_LIMIT + 12;

const ENTITY_JSON = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { name: "src", "@table": "orders" } },
            { "field.string": { name: "id" } },
            { "field.int": { name: "total" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "uuid" } },
          ],
        },
      },
    ],
  },
});

/**
 * A project with metadata, a gen config, and `FINDINGS` authored anti-pattern
 * sites — each a money word plus minor-unit math on one line, which is the
 * scanner's high-precision `money-float` rule.
 */
function project(extraConfig = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "mo-advisory-"));
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  mkdirSync(join(dir, ".metaobjects"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.shop.json"), ENTITY_JSON);
  writeFileSync(join(dir, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }));
  writeFileSync(
    join(dir, "src", "checkout.ts"),
    Array.from({ length: FINDINGS }, (_, i) => `const priceCents${i} = Math.round(price * 100);`).join("\n"),
  );
  writeFileSync(
    join(dir, "metaobjects.config.ts"),
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(join(dir, "generated"))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "js",
  generators: [entityFile()],${extraConfig}
});
`,
  );
  return dir;
}

/** Run the dispatcher, capturing stdout (console.log) and stderr (console.error). */
async function capture(argv: string[]): Promise<{ exit: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { outLines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(" ")); };
  let exit: number;
  try {
    exit = await run(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { exit, out: outLines.join("\n"), err: errLines.join("\n") };
}

interface FindingRow {
  file: string; line: number; rule: string; construct: string; message: string;
}
interface DiagnosticRow {
  code: string; path: string; severity: string; source: string; message: string;
}
/** Generic in its row type — the anti-pattern and requirement sections share the
 *  envelope and differ only in what a row is. */
interface AdvisoryBlock<Row = FindingRow> {
  status: string; note?: string; total: number; rows: Row[];
}

describe("meta gen --format json carries the advisory findings", () => {
  test("the payload contains every finding, with its fields and total — and stdout is still parseable JSON", async () => {
    const dir = project();
    try {
      const { exit, out, err } = await capture(["gen", "--format", "json", "--cwd", dir]);

      // (4) exit code unchanged: the advisory can never fail a build.
      expect(exit).toBe(0);

      // Parseable, whole-of-stdout JSON — a prose line in front of it would break `| jq`.
      const payload = JSON.parse(out.trim()) as { antiPatterns: AdvisoryBlock; help: string[] };

      // (1) the findings are IN the payload, not only on stderr as text.
      expect(payload.antiPatterns.status).toBe("ran");
      expect(payload.antiPatterns.total).toBe(FINDINGS);
      // (3) uncapped — more findings than the text cap, all of them present.
      expect(payload.antiPatterns.rows).toHaveLength(FINDINGS);
      expect(FINDINGS).toBeGreaterThan(DEFAULT_ADVISORY_LIMIT);

      // Real fields, not a pre-rendered blob: a consumer must be able to route by
      // file/line/rule without re-parsing English.
      const row = payload.antiPatterns.rows[0]!;
      expect(row.file).toBe("src/checkout.ts");
      expect(row.line).toBe(1);
      expect(row.rule).toBe("money-float");
      expect(row.construct).toBe("field.currency");
      expect(row.message).toContain("meta types field.currency");

      // The count is stated where a reader will see it, not left to be counted.
      expect(payload.help.join(" ")).toContain(String(FINDINGS));

      // The human copy still goes to stderr, where it always did.
      expect(err).toContain("hand-roll what MetaObjects can model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("a suppressed scan is STATED in the payload, never a clean-looking absence", async () => {
    const dir = project();
    try {
      const { exit, out } = await capture(["gen", "--format", "json", "--no-antipatterns", "--cwd", dir]);
      expect(exit).toBe(0);
      const payload = JSON.parse(out.trim()) as { antiPatterns: AdvisoryBlock };
      expect(payload.antiPatterns.status).toBe("skipped");
      expect(payload.antiPatterns.note).toContain("--no-antipatterns");
      expect(payload.antiPatterns.total).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});

describe("meta verify --format json emits a structured result", () => {
  test("stdout is one JSON document — gates, findings, and what is NOT represented", async () => {
    const dir = project();
    try {
      const { exit, out, err } = await capture(["verify", "--format", "json", "--cwd", dir]);

      // (4) exit code unchanged — this project has no drift and the advisory
      // findings must not change that.
      expect(exit).toBe(0);

      // (2) a structured document, not human text. Before the fix this parse threw:
      // `--format` was validated globally and never reached verifyCommand.
      const payload = JSON.parse(out.trim()) as {
        verify: { gate: string; ran: boolean; ok: boolean }[];
        exitCode: number;
        antiPatterns: AdvisoryBlock;
        requirements: AdvisoryBlock<DiagnosticRow>;
        notRepresented: string[];
      };

      // Every gate's verdict, with "did it run" distinct from "did it pass".
      const gates = Object.fromEntries(payload.verify.map((g) => [g.gate, g]));
      expect(gates.templates!.ran).toBe(true);
      expect(gates.schema!.ran).toBe(false);
      expect(payload.exitCode).toBe(exit);

      // (1)+(3) the advisory findings, uncapped.
      expect(payload.antiPatterns.total).toBe(FINDINGS);
      expect(payload.antiPatterns.rows).toHaveLength(FINDINGS);

      // The requirement section is present even for a project declaring none — a
      // reader must be able to tell "found nothing" from "never ran".
      expect(payload.requirements.status).toBe("ran");

      // The honest boundary: what stays on stderr is named, not left to inference.
      expect(payload.notRepresented.length).toBeGreaterThan(0);
      expect(payload.notRepresented.join(" ")).toContain("stderr");

      // Narration moved to stderr so it cannot corrupt the document.
      expect(err).toContain("meta verify");
      expect(out).not.toContain("running --templates");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("--format toon emits a TOON document with a tabular findings block", async () => {
    const dir = project();
    try {
      const { exit, out } = await capture(["verify", "--format", "toon", "--cwd", dir]);
      expect(exit).toBe(0);
      expect(out).toMatch(/verify\[\d+\]\{gate,ran,ok\}:/);
      expect(out).toContain(`rows[${FINDINGS}]{file,line,rule,construct,message}:`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});

describe("text mode caps, --limit raises it, and every site honors one constant", () => {
  /** The advisory lines a run printed to stderr (the teaching lines carry `meta types`). */
  const adviceLines = (err: string): string[] =>
    err.split("\n").filter((l) => l.includes("meta types "));

  test("meta gen text output caps at the default and says how many it held back", async () => {
    const dir = project();
    try {
      const { exit, err } = await capture(["gen", "--format", "text", "--cwd", dir]);
      expect(exit).toBe(0);
      expect(adviceLines(err)).toHaveLength(DEFAULT_ADVISORY_LIMIT);
      expect(err).toContain(`…and ${FINDINGS - DEFAULT_ADVISORY_LIMIT} more`);
      // The tail must name the way OUT. "…and N more." full stop is what sent an
      // adopter hunting through --help, an invented env var and --json.
      expect(err).toContain("--limit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("meta verify text output caps at the same default — one constant, not one per site", async () => {
    const dir = project();
    try {
      const { exit, err } = await capture(["verify", "--format", "text", "--cwd", dir]);
      expect(exit).toBe(0);
      expect(adviceLines(err)).toHaveLength(DEFAULT_ADVISORY_LIMIT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("--limit raises the cap on gen and verify alike, and --limit all removes it", async () => {
    const dir = project();
    try {
      const gen3 = await capture(["gen", "--format", "text", "--limit", "3", "--cwd", dir]);
      expect(gen3.exit).toBe(0);
      expect(adviceLines(gen3.err)).toHaveLength(3);

      const verify3 = await capture(["verify", "--format", "text", "--limit", "3", "--cwd", dir]);
      expect(verify3.exit).toBe(0);
      expect(adviceLines(verify3.err)).toHaveLength(3);

      const all = await capture(["verify", "--format", "text", "--limit", "all", "--cwd", dir]);
      expect(all.exit).toBe(0);
      expect(adviceLines(all.err)).toHaveLength(FINDINGS);
      expect(all.err).not.toContain("more.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("--limit never truncates a structured payload, whatever it is set to", async () => {
    const dir = project();
    try {
      const { exit, out } = await capture(["verify", "--format", "json", "--limit", "1", "--cwd", dir]);
      expect(exit).toBe(0);
      const payload = JSON.parse(out.trim()) as { antiPatterns: AdvisoryBlock };
      // A cap exists to spare a human's terminal; a truncated machine payload is
      // the defect all of this exists to fix.
      expect(payload.antiPatterns.rows).toHaveLength(FINDINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("an invalid --limit is a usage error (exit 2) that names the flag's grammar", async () => {
    const dir = project();
    try {
      const bad = await capture(["verify", "--limit", "nonsense", "--cwd", dir]);
      expect(bad.exit).toBe(2);
      // The MESSAGE is asserted, not only the code: an unrecognised flag also
      // exits 2 ("Unknown option '--limit'"), so a code-only assertion would pass
      // just as well on a build where --limit does not exist at all.
      expect(bad.err).toContain("invalid --limit 'nonsense'");
      expect(bad.err).toContain("all");

      const zero = await capture(["gen", "--limit", "0", "--cwd", dir]);
      expect(zero.exit).toBe(2);
      expect(zero.err).toContain("invalid --limit '0'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});

describe("--json is refused with the flag that works", () => {
  // REJECTED rather than aliased: `--format` is validated once, globally, for all
  // three values, while an alias would have to be added to every command's own
  // strict `parseArgs` option table — the per-command scattering that let
  // `--format` be honored by two commands and ignored by the rest. `parseArgs`
  // already exits 2 on it; what was missing was a message naming the way out.
  test("meta verify --json exits 2 and names --format json", async () => {
    const dir = project();
    try {
      const { exit, err } = await capture(["verify", "--json", "--cwd", dir]);
      expect(exit).toBe(2);
      expect(err).toContain("--format json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("a --format a command ignores is stated, not silently dropped", async () => {
    const { err } = await capture(["docs", "--format", "json", "--help"]);
    expect(err).toContain("--format is honored by");
    expect(err).toContain("verify");
  }, TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// requirement diagnostics — the OTHER capped section (verify.ts's CAP = 20)
// ---------------------------------------------------------------------------

/**
 * A project declaring `count` L4 requirements, none of which claims an entity, so
 * each emits WARN_REQUIREMENT_NOTHING_IMPLEMENTS — plus one unclaimed-object
 * warning. That puts the section past the text cap without inventing a rule.
 */
function ledgerProject(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mo-advisory-req-"));
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.shop.json"), ENTITY_JSON);
  writeFileSync(
    join(dir, "metaobjects", "meta.requirements.json"),
    JSON.stringify({
      "metadata.root": {
        package: "acme::shop",
        children: Array.from({ length: count }, (_, i) => ({
          "requirement.functional": {
            name: `claim${i}`,
            "@level": 4,
            "@status": "live",
            "@statement": `Claim ${i} holds.`,
            "@counterexample": `Claim ${i} does not hold.`,
          },
        })),
      },
    }),
  );
  return dir;
}

describe("verify's requirement diagnostics ride in the payload, uncapped", () => {
  const LEDGER = DEFAULT_ADVISORY_LIMIT + 5;

  test("every diagnostic is in the payload while text still truncates at the cap", async () => {
    const dir = ledgerProject(LEDGER);
    try {
      const structured = await capture(["verify", "--format", "json", "--cwd", dir]);
      // Warnings only: an unclaimed entity and an unimplemented requirement are
      // both WARNINGS by deliberate design, so the exit code stays 0.
      expect(structured.exit).toBe(0);
      const payload = JSON.parse(structured.out.trim()) as {
        requirements: AdvisoryBlock<DiagnosticRow>;
        requirementCounts?: { total: number; entitiesClaimed: number; entitiesTotal: number };
      };
      expect(payload.requirements.status).toBe("ran");
      // Uncapped: more diagnostics than the text cap, all present.
      expect(payload.requirements.total).toBeGreaterThan(DEFAULT_ADVISORY_LIMIT);
      expect(payload.requirements.rows).toHaveLength(payload.requirements.total);
      expect(payload.requirements.rows.every((r) => r.severity === "warn")).toBe(true);
      // Each row says whether it came from the GATE (can fail a build) or the
      // advisory authoring LINT (never can) — the two print as separate sections
      // precisely because they make different claims.
      expect(new Set(payload.requirements.rows.map((r) => r.source)).has("gate")).toBe(true);
      // The ledger counts verify narrates on every run are fields too.
      expect(payload.requirementCounts?.total).toBe(LEDGER);

      // ...while the human rendering still truncates, and says so.
      const text = await capture(["verify", "--format", "text", "--cwd", dir]);
      expect(text.exit).toBe(0);
      const warnLines = text.err.split("\n").filter((l) => l.includes("WARN_REQUIREMENT"));
      expect(warnLines).toHaveLength(DEFAULT_ADVISORY_LIMIT);
      expect(text.err).toContain("more");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("--limit raises the requirement section too — the third site, one constant", async () => {
    const dir = ledgerProject(LEDGER);
    try {
      const { exit, err } = await capture(["verify", "--format", "text", "--limit", "all", "--cwd", dir]);
      expect(exit).toBe(0);
      const warnLines = err.split("\n").filter((l) => l.includes("WARN_REQUIREMENT"));
      expect(warnLines.length).toBeGreaterThan(DEFAULT_ADVISORY_LIMIT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("a FAILING gate still exits 1 and still emits the payload", async () => {
    // A dangling @implementedBy on a live requirement is an ERROR — the one
    // requirement diagnostic that reaches the exit code.
    const dir = mkdtempSync(join(tmpdir(), "mo-advisory-fail-"));
    try {
      mkdirSync(join(dir, "metaobjects"), { recursive: true });
      writeFileSync(join(dir, "metaobjects", "meta.shop.json"), ENTITY_JSON);
      writeFileSync(
        join(dir, "metaobjects", "meta.requirements.json"),
        JSON.stringify({
          "metadata.root": {
            package: "acme::shop",
            children: [{
              "requirement.functional": {
                name: "orderRecord",
                "@level": 4,
                "@status": "live",
                "@statement": "An order is a durable record.",
                "@counterexample": "An order vanishes on restart.",
                "@implementedBy": ["NoSuchEntity"],
              },
            }],
          },
        }),
      );
      const { exit, out } = await capture(["verify", "--format", "json", "--cwd", dir]);
      expect(exit).toBe(1);
      const payload = JSON.parse(out.trim()) as {
        exitCode: number;
        verify: { gate: string; ran: boolean; ok: boolean }[];
        requirements: AdvisoryBlock<DiagnosticRow>;
      };
      expect(payload.exitCode).toBe(1);
      expect(payload.verify.find((g) => g.gate === "requirements")!.ok).toBe(false);
      expect(payload.requirements.rows.some((r) => r.severity === "error")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("a load failure still exits non-zero AND still says so on stdout", async () => {
    // `--format json` on a project that cannot load used to print text on stderr
    // and leave stdout EMPTY — the same silence, one level up. The exit code is
    // unchanged; what is new is that the structured caller is told why.
    const dir = mkdtempSync(join(tmpdir(), "mo-advisory-broken-"));
    try {
      mkdirSync(join(dir, "metaobjects"), { recursive: true });
      writeFileSync(join(dir, "metaobjects", "meta.shop.json"), '{ "metadata.root": { "children": [ { "object.entity": { "name": "X", "@nonsenseAttr": 1 } } ] } }');
      const { exit, out } = await capture(["verify", "--format", "json", "--cwd", dir]);
      expect(exit).toBe(1);
      const payload = JSON.parse(out.trim()) as { error: string; hint: string };
      expect(payload.error).toContain("failed to load metadata");
      expect(typeof payload.hint).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});

// The project's escape hatch has to be REACHABLE from a config file, not merely
// present as a function parameter. An option only a caller inside this repo can set
// is the same dead-seam shape `EXTRA_SUFFIX` had before it was deleted — exported,
// pointed at from generated output, and wired to nothing — so the wiring gets its own
// gate rather than being implied by the unit tests on `scanSourceForAntiPatterns`.
//
// It matters because `--no-antipatterns` is not a substitute: silencing the whole scan
// to quiet one directory is precisely how a useful advisory gets switched off wholesale.
describe("verify.antiPatternIgnore reaches the scan from metaobjects.config.ts", () => {
  test("gen: a declared glob removes those findings from the structured payload", async () => {
    const dir = project(`\n  verify: { antiPatternIgnore: ["src/**"] },`);
    try {
      const { exit, out } = await capture(["gen", "--format", "json", "--cwd", dir]);
      const payload = JSON.parse(out) as { antiPatterns?: { status?: string; total?: number } };
      expect(payload.antiPatterns?.status).toBe("ran");   // it LOOKED, and found nothing
      expect(payload.antiPatterns?.total).toBe(0);
      expect(exit).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verify: same config, same effect on the same findings", async () => {
    const dir = project(`\n  verify: { antiPatternIgnore: ["src/**"] },`);
    try {
      const { out } = await capture(["verify", "--format", "json", "--cwd", dir]);
      const payload = JSON.parse(out) as { antiPatterns?: { total?: number } };
      expect(payload.antiPatterns?.total).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The control, and the half that catches a glob matcher that silently swallows
  // everything: without the key the SAME project must still report every finding.
  test("without the key the findings are all still reported", async () => {
    const dir = project();
    try {
      const { out } = await capture(["gen", "--format", "json", "--cwd", dir]);
      const payload = JSON.parse(out) as { antiPatterns?: { total?: number } };
      expect(payload.antiPatterns?.total).toBe(FINDINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a glob matching nothing changes nothing — no accidental catch-all", async () => {
    const dir = project(`\n  verify: { antiPatternIgnore: ["does/not/exist/**"] },`);
    try {
      const { out } = await capture(["gen", "--format", "json", "--cwd", dir]);
      const payload = JSON.parse(out) as { antiPatterns?: { total?: number } };
      expect(payload.antiPatterns?.total).toBe(FINDINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
