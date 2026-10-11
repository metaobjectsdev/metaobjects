// Cross-port FR-019 conformance (TS — the reference). Loads the shared fixture
// `fixtures/codegen-conformance/shared-provided-enum/input/meta.json`, checks every enum
// field's resolution against the port-neutral decision table beside it
// (`expected-enum-types.json`), and asserts the FR-019 behaviors on generated output (ADR-0026):
//   • Shared materialization — a package-level abstract `field.enum` (`Priority`) extended by
//     TWO entities is materialized ONCE in `enums.ts`; both entities reference it.
//   • `@provided` — a package-level abstract `field.enum` (`Currency`, `@provided: true`) is
//     NOT materialized; consumers import it from the configured `providedEnumModule`, while
//     `@values` still drive the z.enum validation + the DB CHECK.
//   • A `@provided` enum with no `providedEnumModule` config → a codegen-time error.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runGen, defineConfig } from "../../src/index.js";
import { barrel } from "../../src/generators/barrel.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
import { MetaDataLoader, InMemoryStringSource, FIELD_SUBTYPE_ENUM, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { sharedEnumForField, materializedSharedEnums } from "../../src/enum-shared.js";
import { renderSharedEnumsFile } from "../../src/templates/enums-file.js";

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not locate repo root from " + start);
    dir = parent;
  }
}

async function loadSharedFixture(): Promise<MetaRoot> {
  const fxDir = join(findRepoRoot(import.meta.dir), "fixtures", "codegen-conformance", "shared-provided-enum", "input");
  const sources = readdirSync(fxDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => new InMemoryStringSource(readFileSync(join(fxDir, f), "utf-8"), { id: f, format: "json" }));
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors, "shared FR-019 fixture must load cleanly").toEqual([]);
  return res.root;
}

function loadDecisionTable(): {
  fields: Record<string, { shared: string | null; provided: boolean }>;
  materialized: string[];
} {
  const file = join(findRepoRoot(import.meta.dir), "fixtures", "codegen-conformance", "shared-provided-enum", "expected-enum-types.json");
  return JSON.parse(readFileSync(file, "utf-8"));
}

/** `only`, when given, narrows the run to the objects it accepts (a generator `filter`). */
async function gen(
  root: MetaRoot,
  providedEnumModule?: string,
  only?: (entity: MetaObject) => boolean,
): Promise<Record<string, string>> {
  const tmp = mkdtempSync(join(tmpdir(), "fr019-conf-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "none",
        dbImport: "~/db",
        dialect: "postgres",
        generators:
          only !== undefined ? [entityFile({ filter: only })] : [entityFile(), queriesFile(), barrel()],
        ...(providedEnumModule !== undefined && { providedEnumModule }),
      }),
      metadata: root,
    });
    const files: Record<string, string> = {};
    for (const name of readdirSync(tmp)) if (name.endsWith(".ts")) files[name] = readFileSync(join(tmp, name), "utf-8");
    return files;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("FR-019 shared + provided enum conformance (TS)", () => {
  test("shared abstract enum is materialized ONCE; both consumers reference it", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums");
    const enums = files["enums.ts"]!;
    expect(enums, "shared enums.ts must be emitted").toBeDefined();
    // Materialized exactly once.
    expect(enums.split('export type Priority =').length - 1).toBe(1);
    expect(enums).toContain('export type Priority = "LOW" | "MEDIUM" | "HIGH";');
    // Both entities reference it, neither redeclares the union.
    for (const name of ["Ticket.ts", "Order.ts"]) {
      const f = files[name]!;
      expect(f).toBeDefined();
      expect(f).toContain('from "./enums"');
      expect(f).toContain("PriorityEnum");
      expect(f).not.toContain("export type Priority =");
    }
  });

  test("@provided enum is NOT materialized; referenced from the configured module; @values still drive validation + CHECK", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums");
    const enums = files["enums.ts"]!;
    // Currency is provided → never materialized.
    expect(enums).not.toContain("Currency");
    const t = files["Ticket.ts"]!;
    // Referenced from the configured external module.
    expect(t).toContain('export { type Currency } from "@acme/ext-enums";');
    // @values stay the SSOT: validation + CHECK are still emitted from the members.
    expect(t).toContain('z.enum(["USD", "EUR", "GBP"])');
    expect(t).toContain("currency IN ('USD', 'EUR', 'GBP')");
  });

  // A CHAINED declaration: root abstract `Money extends` root abstract `@provided Currency`.
  // Per ADR-0026 §2 a materialized type is named for ITS OWN declaration, and ADR-0039 makes
  // @provided declaration-layer (it does not flow down the chain), so `Money` is its own type,
  // materialized from the members it inherits — NOT a reference to a hand-written `Money` the
  // adopter never declared. #246 guarantees the chain can rename the vocabulary but never
  // mutate it. All five ports must agree here.
  test("a root abstract enum extending a @provided enum is materialized under its OWN name", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums");
    const enums = files["enums.ts"]!;
    expect(enums).toContain('export type Money = "USD" | "EUR" | "GBP";');
    // Currency itself stays provided — the chain must not drag it into materialization.
    expect(enums).not.toContain("export type Currency =");
    const inv = files["Invoice.ts"]!;
    expect(inv).toBeDefined();
    expect(inv).toContain('from "./enums"');
    expect(inv).not.toContain('from "@acme/ext-enums"');
  });

  // The DECISION TABLE (`expected-enum-types.json`) is the port-neutral oracle: for every
  // object-hosted enum field in the shared input, which shared declaration its type resolves
  // to (or none), and whether that declaration is `@provided`. Every port computes the table
  // from the function its generators call and must match it exactly, in both directions, so a
  // case cannot be added to the input without all five ports answering it.
  test("every enum field resolves to the shared declaration the decision table names", async () => {
    const root = await loadSharedFixture();
    const expected = loadDecisionTable();
    const actual: Record<string, { shared: string | null; provided: boolean }> = {};
    for (const obj of root.objects()) {
      for (const field of obj.fields()) {
        if (field.subType !== FIELD_SUBTYPE_ENUM) continue;
        const shared = sharedEnumForField(field);
        actual[`${obj.resolutionKey()}.${field.name}`] = {
          shared: shared?.declaration ?? null,
          provided: shared?.provided ?? false,
        };
      }
    }
    expect(actual).toEqual(expected.fields);
    expect(materializedSharedEnums(root).map((e) => e.name).sort()).toEqual(expected.materialized);
  });

  // MULTI-HOP, on generated output. Each consumer below reaches the shared `Priority` through
  // one or more intermediate fields whose NAME differs from the declaration's (`severity`,
  // `importance`), so naming the type after the immediate super would emit `Severity` /
  // `Importance` instead. The hosts are two entities and a value object.
  test("multi-hop consumers reference the shared type; it is materialized exactly once", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums");
    const enums = files["enums.ts"]!;
    expect(enums.split("export type Priority =").length - 1).toBe(1);
    expect(enums.split("export type Money =").length - 1).toBe(1);

    const task = files["Task.ts"]!;
    expect(task).toContain('export { type Priority, PriorityEnum } from "./enums";');
    expect(task).toContain("urgency: PriorityEnum.optional()");
    expect(task).toContain("importance: PriorityEnum.optional()");
    expect(task).not.toContain("export type Priority =");
    expect(task).not.toContain("TaskUrgency");
    expect(task).not.toContain("export type Importance");
    expect(task).not.toContain("ImportanceEnum");

    const subtask = files["Subtask.ts"]!;
    expect(subtask).toContain('export { type Priority, PriorityEnum } from "./enums";');
    expect(subtask).toContain("rank: PriorityEnum.optional()");
    expect(subtask).not.toContain("export type Priority =");
    expect(subtask).not.toContain("export type Importance");
    expect(subtask).not.toContain("export type Rank");
    expect(subtask).not.toContain("RankEnum");

    const badge = files["TicketBadge.ts"]!;
    expect(badge).toContain('import { type Priority, PriorityEnum } from "./enums";');
    expect(badge).toContain("badge?: Priority | undefined;");
    expect(badge).toContain("badge: PriorityEnum.optional()");
    expect(badge).not.toContain("export type Severity");
    expect(badge).not.toContain("SeverityEnum");
    expect(badge).not.toContain("TicketBadgeBadge");
  });

  // The projection over a view. Its read schema validates with the declaration's members and
  // declares no named enum of its own, so there is no per-projection enum type to drift from
  // the shared one (in TypeScript the row's field type is the same literal union structurally).
  test("a multi-hop projection field takes the shared declaration's members and no enum of its own", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums");
    const summary = files["TicketSummary.ts"]!;
    expect(summary).toBeDefined();
    expect(summary).toContain('level: z.enum(["LOW", "MEDIUM", "HIGH"])');
    expect(summary).not.toContain("TicketSummaryLevel");
    expect(summary).not.toContain("export type Level");
    expect(summary).not.toContain("export type Severity");
  });

  // Two fields of ONE object whose immediate supers are same-named fields (`tier`) of different
  // objects, resolving to DIFFERENT shared declarations. Naming by the immediate super gives both
  // the name `Tier`, and the per-file dedupe then drops one of them.
  test("same-named immediate supers resolving to different shared types stay distinct", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums");
    const refund = files["Refund.ts"]!;
    expect(refund).toBeDefined();
    expect(refund).not.toContain("export type Tier");
    expect(refund).not.toContain("TierEnum");
    expect(refund).toContain("ticketTier: PriorityEnum.optional()");
    expect(refund).toContain("invoiceTier: MoneyEnum.optional()");
    // `unit` reaches the materialized `Money`; `tender` reaches the @provided `Currency`,
    // which is referenced from the configured module and never materialized.
    expect(refund).toContain("unit: MoneyEnum.optional()");
    expect(refund).toContain('export { type Currency } from "@acme/ext-enums";');
    expect(refund).toContain('tender: z.enum(["USD", "EUR", "GBP"]).optional()');
    expect(files["enums.ts"]!).not.toContain("Currency");
  });

  // NEGATIVES. A field that redeclares `@values` or `@intValueMap` part-way down the chain
  // starts a new vocabulary, and so does everything extending it; an enum that never reaches a
  // shared declaration stays inline. Each keeps a locally declared union and takes nothing
  // from the shared module for that field.
  test("a mid-chain redeclaration and a chain with no shared declaration stay inline", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums");
    const task = files["Task.ts"]!;
    // `phase` redeclares @values: its own members, not the shared Priority's.
    expect(task).toContain('export type Tier = "OPEN" | "DONE";');
    // `weight` redeclares @intValueMap over the inherited members: its own inline union.
    expect(task).toContain('export type Severity = "LOW" | "MEDIUM" | "HIGH";');
    const subtask = files["Subtask.ts"]!;
    expect(subtask).toContain('export type Phase = "OPEN" | "DONE";');
    expect(subtask).toContain('export type Weight = "LOW" | "MEDIUM" | "HIGH";');
    const refund = files["Refund.ts"]!;
    expect(refund).toContain('export type Status = "NEW" | "PAID";');
  });

  // MUST-GENERATE. When the run is scoped to one object whose only enum reaches `Priority`
  // through `Ticket.severity`, the shared module must still carry `Priority` — otherwise a
  // consumer references a type nothing generated (the failure #259 reported). Scoping to the
  // projection, and to the value object, each leaves `Priority` as the one materialized enum.
  for (const only of ["TicketSummary", "TicketBadge"]) {
    test(`a run scoped to ${only} alone still materializes the shared enum`, async () => {
      const root = await loadSharedFixture();
      const enums = renderSharedEnumsFile(root, { select: (fqn) => fqn === `acme::shop::${only}` });
      expect(enums).not.toBeNull();
      expect(enums!).toContain('export type Priority = "LOW" | "MEDIUM" | "HIGH";');
      expect(enums!).not.toContain("Money");
    });
  }

  // A generator `filter` narrows which entity files are written, not which enums exist.
  test("an entity-file run filtered to the projection still writes the shared enums module", async () => {
    const files = await gen(await loadSharedFixture(), "@acme/ext-enums", (e) => e.name === "TicketSummary");
    expect(Object.keys(files).sort()).toEqual(["TicketSummary.ts", "enums.ts"]);
    expect(files["enums.ts"]!).toContain('export type Priority = "LOW" | "MEDIUM" | "HIGH";');
  });

  test("a @provided enum with no providedEnumModule config is a codegen-time error naming the enum", async () => {
    let err: unknown;
    try {
      await gen(await loadSharedFixture()); // no providedEnumModule
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Currency");
  });
});
