// `agent/ui.md` must agree with the artifacts `meta gen` WROTE — the endpoint it names for
// an object, and whether it says a form exists for it.
//
// Under each object heading the page prints one line: the address the generated routes
// serve that object at, and whether the form generator emits a `<Entity>.form.tsx` for it.
// Four separate defects have been fixed in that one line — a TPH subtype printed at its
// own `$path` when the hierarchy is mounted from its base; a multi-word projection printed
// snake-cased when its const emits kebab; a form announced for a discriminator base the
// form generator skips; and the project's `apiPrefix` omitted, so every address was wrong
// for every project that sets one. Each fix pointed the page at a shared predicate
// (`restPath`, `hasGeneratedForm`), and each was found by READING the page, because
// nothing compared it to what the generators emit. This is that comparison.
//
// IT COMPARES AGAINST THE EMITTED FILES, NOT AGAINST THE PREDICATES. `routes-file.ts`
// composes a TPH subtype's mount as emitted CODE — `Vehicle.$path + "/car"` — while
// `api-surface.ts`'s `restPath` composes `resourcePath(base) + "/" + segment` in
// TypeScript: the inputs are shared but the composition is written twice. A test asserting
// "the page contains `restPath(obj)`" proves only that two spellings agree with each other,
// which is exactly the shape of the projection-path defect — the page and `api/AGENT-API.md`
// agreed with each other and both were wrong. So the routes side here is the `path:`
// expression of every `mountCrudRoutes` / `mountReadOnlyCrudRoutes` call in every emitted
// `*.routes.ts`, EVALUATED against the `$path` each emitted `<Entity>` const declares (the
// technique `check-constraint-name-parity.test.ts` uses to recover a run-time value from
// generated source), under the `{ prefix }` the file registers its mounts with. The form
// side is the set of `*.form.tsx` files on disk after `formFile()` ran.
//
// IT ENUMERATES. Every object the page documents is compared, and every mount the routes
// emit must be documented — one assertion over the whole set, so adding an object to the
// fixture extends the coverage for free. The three parity tests beside this one each pin
// one hand-named pair, which is exactly why none of them generalised to the next defect.
//
// THE FIXTURE IS DE-BLINDED, and a test below checks that it stays so rather than trusting
// this comment. A fixture where two spellings coincide cannot see a divergence between
// them:
//   • a non-empty `apiPrefix` arm (its omission was one of the four), beside an empty one —
//     the routes file has a DIFFERENT shape with no prefix (no `register` wrapper), so
//     both emission arms are parsed;
//   • a multi-word PROJECTION (`OwnerSummary` → `/owner-summaries`, kebab) AND a multi-word
//     ENTITY (`ServiceRecord` → `/service_records`, snake): `resourcePath` splits the
//     spelling BY SUBTYPE, so a page applying either rule to both objects is visible only
//     when both are multi-word — the SHAPES fixture in `agent-docs-surface.test.ts` has
//     single-word entities only and could not see the entity half;
//   • a TPH subtype whose `@discriminatorValue` (`SportsCoupe`) is NOT its name and is
//     mixed-case: with `Car` / `"Car"` the segment is `car` whether you lowercase the
//     value, lowercase the NAME or kebab-case either, so a page deriving the segment from
//     the wrong input passes by coincidence. `sportscoupe` ≠ `sportscar` ≠ `sports-coupe`;
//   • a TPH subtype's own emitted `$path` (`/cars`) differs from the address it is mounted
//     at (`/vehicles/car`) — the "own `$path` names nothing" defect — asserted, not assumed;
//   • both form arms: objects with a `.form.tsx` (a vanilla entity, a write-through entity,
//     each concrete subtype) and objects without (the discriminator base, the projection).
//
// WHAT IT DOES NOT COVER, and why:
//   • the Hono routes file (`routesFileHono`) — a different template that mounts NO TPH
//     subtype at all (`routes-hono-parity.test.ts`); the page has no per-framework mode;
//   • M:N traversal mounts (`mountM2mRoute`) — not an object's address, and the page does
//     not document them;
//   • `routesFile({ expose })` verb narrowing (#348) — the page states whether a FORM is
//     emitted, and `formFile()` does not consult `expose`, so a form can exist for an
//     endpoint that refuses POST; that is a product question, not a page/artifact one;
//   • the FIELD rows (Control / Filter / Sort) against the emitted `<Entity>` const and
//     allowlists — the same const is on disk and the same technique applies, but that is a
//     second gate over a different line of the page;
//   • the TanStack hooks' fetch URL (`hooks-file.ts` composes `Base.$path + "/car"` a
//     third time) — a hooks-versus-routes parity, not a page one;
//   • `targets:` / `outputLayout: "package"` layouts, and multi-package models whose bare
//     names collide (this fixture is one package and mount→object is keyed by bare name;
//     the test refuses a fixture where that key is ambiguous rather than guessing).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { runGen } from "../src/runner.js";
import { agentDocsFile, entityFile, routesFile } from "../src/generators/index.js";
// Both derivations, read through the package barrel so this test exercises the surface a
// consumer has. The de-blinding check below needs BOTH: agreement is only a measurement
// while the two still spell different addresses for the fixture's TPH subtype.
import { resourcePath, restPath } from "../src/index.js";
import { defineConfig, type Dialect } from "../src/metaobjects-config.js";

// The dialect decides column builders, never an address or a form, so one arm suffices.
// There is no registered constant for it — `Dialect` is codegen config, not metamodel
// vocabulary — hence a typed declaration here rather than a literal at the call site.
const DIALECT: Dialect = "sqlite";

const PACKAGE = "acme::fleet";

// Authored metadata, in the on-disk form an adopter writes (the same convention as every
// fixture beside this file). The shapes are chosen for what they make VISIBLE — see the
// header — and each is annotated with the arm it exists for.
const FIXTURE = {
  "metadata.root": {
    package: PACKAGE,
    children: [
      // Vanilla entity, single word: full CRUD, a form. The common case, and the one every
      // wrong spelling rule still gets right — which is why it is not the only entity.
      {
        "object.entity": {
          name: "Owner",
          children: [
            { "source.rdb": { "@table": "owners" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            { "field.string": { name: "name", "@required": true } },
            { "field.enum": { name: "tier", "@values": ["standard", "fleet"] } },
            { "relationship.aggregation": { name: "vehicles", "@cardinality": "many", "@objectRef": "Vehicle" } },
          ],
        },
      },
      // Write-through entity, MULTI-WORD: a writable table plus a replica view with a
      // derived passthrough field, so its mount carries `readView` (#214) — a distinct
      // branch of the routes template — and its `$path` is SNAKE-cased (`/service_records`),
      // the entity half of the spelling split.
      {
        "object.entity": {
          name: "ServiceRecord",
          children: [
            { "source.rdb": { "@role": "primary", "@table": "service_records" } },
            { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_service_records" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            { "field.long": { name: "ownerId", "@required": true } },
            { "identity.reference": { name: "ownerRef", "@fields": "ownerId", "@references": "Owner" } },
            { "relationship.association": { name: "owner", "@cardinality": "one", "@objectRef": "Owner" } },
            {
              "field.string": {
                name: "ownerName",
                children: [{ "origin.passthrough": { "@from": "Owner.name", "@via": "ServiceRecord.owner" } }],
              },
            },
          ],
        },
      },
      // TPH discriminator base: its own mount is list/get only and it gets NO form; the
      // hierarchy's routes live in ITS file, one mount per concrete subtype.
      {
        "object.entity": {
          name: "Vehicle",
          "@discriminator": "kind",
          children: [
            { "source.rdb": { "@table": "vehicles" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            { "field.string": { name: "kind", "@required": true } },
            { "field.long": { name: "ownerId" } },
            { "identity.reference": { name: "ownerRef", "@fields": "ownerId", "@references": "Owner" } },
            { "relationship.association": { name: "owner", "@cardinality": "one", "@objectRef": "Owner" } },
          ],
        },
      },
      // Subtype whose discriminator value IS its name — the blind case, kept because it is
      // the common one and its own `$path` (`/cars`) is still not where it is served.
      {
        "object.entity": {
          name: "Car",
          extends: "Vehicle",
          "@discriminatorValue": "Car",
          children: [{ "field.int": { name: "doors" } }],
        },
      },
      // Subtype whose discriminator value is NOT its name and is mixed-case, so the three
      // candidate segment derivations — lowercase the value, lowercase the name, kebab-case
      // — all differ: `sportscoupe` / `sportscar` / `sports-coupe`.
      {
        "object.entity": {
          name: "SportsCar",
          extends: "Vehicle",
          "@discriminatorValue": "SportsCoupe",
          children: [{ "field.int": { name: "topSpeed" } }],
        },
      },
      // Sourceless value: no endpoint, no form, no `$path` — must appear on neither side.
      {
        "object.value": {
          name: "Party",
          children: [{ "field.string": { name: "name" } }],
        },
      },
      // Multi-word PROJECTION: read-only mount, no form, KEBAB `$path` (`/owner-summaries`).
      {
        "object.projection": {
          name: "OwnerSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_owner_summary" } },
            { "field.long": { name: "id", extends: "Owner.id" } },
            { "identity.primary": { name: "pk", extends: "Owner.pk" } },
            { "field.string": { name: "name", children: [{ "origin.passthrough": { "@from": "Owner.name" } }] } },
          ],
        },
      },
    ],
  },
};

const ROUTES_SUFFIX = ".routes.ts";
const FORM_SUFFIX = ".form.tsx";
const UI_PAGE = join("agent", "ui.md");
const NO_FORM_MARKER = "**no form is generated**";

/** One `mount…CrudRoutes({ … })` call as the routes file emitted it. */
interface Mount {
  /** The object the mount serves, read off its `filterAllowlist: <Name>FilterAllowlist`. */
  readonly object: string;
  /** The `path:` expression, verbatim — `Owner.$path` or `Vehicle.$path + "/car"`. */
  readonly pathExpr: string;
  /** `pathExpr` evaluated against the emitted `$path`s, under the file's `{ prefix }`. */
  readonly address: string;
  /** The `discriminator: { …, value }` a per-subtype mount pins, when it is one. */
  readonly discriminatorValue: string | undefined;
}

interface RoutesFile {
  readonly prefix: string;
  readonly mounts: readonly Mount[];
}

/** What the page claims under one object heading. */
interface Documented {
  readonly address: string;
  readonly hasForm: boolean;
}

interface Emitted {
  readonly root: MetaRoot;
  /** `<Name>` → the `$path` its emitted const declares. A value object declares none. */
  readonly ownPaths: ReadonlyMap<string, string>;
  readonly routes: readonly RoutesFile[];
  /** The bare names a `<Name>.form.tsx` was written for. */
  readonly forms: ReadonlySet<string>;
  /** `resolutionKey()` → the page's claim. */
  readonly page: ReadonlyMap<string, Documented>;
}

/**
 * The `$path` the emitted `<Name>` const declares, read from inside that const's block so
 * a `$path` belonging to some other const in the file cannot be mistaken for it.
 */
function ownPathOf(name: string, source: string): string | undefined {
  const start = source.indexOf(`export const ${name} = {`);
  if (start < 0) return undefined;
  const end = source.indexOf("} as const;", start);
  const block = source.slice(start, end < 0 ? undefined : end);
  return /\$path:\s*"([^"]*)"/.exec(block)?.[1];
}

/**
 * Evaluate a mount's `path:` expression the way the generated module would — each
 * `<Name>` bound to an object carrying the `$path` its emitted const declares. The
 * composition `Vehicle.$path + "/car"` is code the routes template WROTE, so it is run
 * rather than re-derived; an expression naming a const the run did not emit throws.
 */
function evaluatePath(expr: string, ownPaths: ReadonlyMap<string, string>): string {
  const names = [...ownPaths.keys()];
  const values = names.map((n) => ({ $path: ownPaths.get(n) }));
  const evaluate = new Function(...names, `"use strict"; return (${expr});`) as (...args: unknown[]) => unknown;
  const out = evaluate(...values);
  if (typeof out !== "string") throw new Error(`path expression \`${expr}\` did not evaluate to a string`);
  return out;
}

/**
 * Every mount in one emitted routes file. A line-oriented walk over the biome-formatted
 * output: a mount opens on `mount…CrudRoutes({` and closes on `});`, and the three
 * properties read are each one line. The count of openers is asserted against the
 * mounts recovered, so a formatting change that moved a property onto the opener line
 * fails loudly instead of silently dropping a mount from the comparison.
 */
function parseRoutesFile(source: string, ownPaths: ReadonlyMap<string, string>): RoutesFile {
  const prefixes = [...source.matchAll(/\{\s*prefix:\s*"([^"]*)"\s*\}/g)].map((m) => m[1] ?? "");
  expect(prefixes.length).toBeLessThanOrEqual(1);
  const prefix = prefixes[0] ?? "";

  const mounts: Mount[] = [];
  let open: { pathExpr?: string; object?: string; discriminatorValue?: string } | undefined;
  for (const line of source.split("\n")) {
    if (/^\s*mount(?:ReadOnly)?CrudRoutes\(\{\s*$/.test(line)) {
      expect(open).toBeUndefined();
      open = {};
      continue;
    }
    if (open === undefined) continue;
    const path = /^\s*path:\s*(.+?),\s*$/.exec(line);
    if (path?.[1] !== undefined) open.pathExpr = path[1];
    const allowlist = /^\s*filterAllowlist:\s*(\w+)FilterAllowlist,\s*$/.exec(line);
    if (allowlist?.[1] !== undefined) open.object = allowlist[1];
    const pin = /^\s*discriminator:\s*\{.*\bvalue:\s*"([^"]*)"\s*\},?\s*$/.exec(line);
    if (pin?.[1] !== undefined) open.discriminatorValue = pin[1];
    if (/^\s*\}\);\s*$/.test(line)) {
      if (open.pathExpr === undefined || open.object === undefined) {
        throw new Error(`a mount closed without a path and an allowlist:\n${source}`);
      }
      mounts.push({
        object: open.object,
        pathExpr: open.pathExpr,
        address: `${prefix}${evaluatePath(open.pathExpr, ownPaths)}`,
        discriminatorValue: open.discriminatorValue,
      });
      open = undefined;
    }
  }
  const openers = source.match(/mount(?:ReadOnly)?CrudRoutes\(\{/g) ?? [];
  expect(mounts.length).toBe(openers.length);
  return { prefix, mounts };
}

/** The page, one claim per `## \`<resolutionKey>\`` heading. */
function parsePage(page: string): Map<string, Documented> {
  const out = new Map<string, Documented>();
  for (const section of page.split(/^## /m).slice(1)) {
    const heading = /^`([^`]+)`/.exec(section)?.[1];
    const address = /^Endpoint `([^`]+)`/m.exec(section)?.[1];
    if (heading === undefined || address === undefined) {
      throw new Error(`a section without a heading and an Endpoint line:\n${section}`);
    }
    expect(out.has(heading)).toBe(false);
    out.set(heading, { address, hasForm: !section.includes(NO_FORM_MARKER) });
  }
  return out;
}

async function generate(apiPrefix: string): Promise<Emitted> {
  const repo = mkdtempSync(join(tmpdir(), "agent-ui-parity-"));
  try {
    mkdirSync(join(repo, "metaobjects"), { recursive: true });
    const fixture = join(repo, "metaobjects", "meta.fleet.json");
    writeFileSync(fixture, JSON.stringify(FIXTURE), "utf8");
    const { root, errors } = await new MetaDataLoader().load([new FileSource(fixture)]);
    expect(errors).toEqual([]);

    // The real runner, so every file read below is what `meta gen` would have written —
    // formatted, merged, and under the same `RenderContext` the page's `apiPrefix` comes
    // from. `formFile()` is the React form generator itself, not a stand-in.
    const outDir = join(repo, "out");
    const result = await runGen({
      config: defineConfig({
        outDir,
        dialect: DIALECT,
        extStyle: "js",
        dbImport: "@/db",
        apiPrefix,
        generators: [entityFile(), routesFile(), formFile(), agentDocsFile()],
      }),
      metadata: root,
      projectRoot: repo,
    });
    expect(result.conflicts).toEqual([]);

    const files = readdirSync(outDir, { recursive: true, encoding: "utf8" })
      .filter((f): f is string => typeof f === "string" && statSync(join(outDir, f)).isFile());
    const read = (f: string): string => readFileSync(join(outDir, f), "utf8");

    // The `$path` consts first: the routes' path expressions are evaluated against them.
    const ownPaths = new Map<string, string>();
    for (const f of files) {
      if (!f.endsWith(".ts") || f.endsWith(ROUTES_SUFFIX)) continue;
      const name = basename(f, ".ts");
      const path = ownPathOf(name, read(f));
      if (path !== undefined) ownPaths.set(name, path);
    }
    const routes = files.filter((f) => f.endsWith(ROUTES_SUFFIX)).map((f) => parseRoutesFile(read(f), ownPaths));
    const forms = new Set(files.filter((f) => f.endsWith(FORM_SUFFIX)).map((f) => basename(f, FORM_SUFFIX)));
    const pageFile = files.find((f) => f === UI_PAGE);
    if (pageFile === undefined) throw new Error(`no ${UI_PAGE} emitted; files: ${files.join(", ")}`);
    return { root, ownPaths, routes, forms, page: parsePage(read(pageFile)) };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/**
 * Bare name → `resolutionKey()`, the page's heading. Refuses an ambiguous name rather
 * than picking one: the routes side identifies an object by the bare `<Name>` its
 * allowlist import carries, which is unique only within one package.
 */
function keyOf(root: MetaRoot, name: string): string {
  const matches = root.objects().filter((o: MetaObject) => o.name === name);
  if (matches.length !== 1) throw new Error(`${matches.length} objects named ${name}; this gate keys by bare name`);
  return matches[0]!.resolutionKey();
}

const sorted = <V>(m: ReadonlyMap<string, V>): [string, V][] =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

describe.each([
  ['under apiPrefix "/api"', "/api"],
  ["with no apiPrefix", ""],
] as const)("agent/ui.md agrees with the emitted artifacts (%s)", (_label, apiPrefix) => {
  // One generation per arm, shared by the tests in it.
  let cached: Promise<Emitted> | undefined;
  const emitted = (): Promise<Emitted> => (cached ??= generate(apiPrefix));
  const allMounts = (e: Emitted): Mount[] => e.routes.flatMap((r) => [...r.mounts]);

  test("the fixture can see each defect this gate exists for — checked, not assumed", async () => {
    const e = await emitted();
    const mounts = allMounts(e);
    expect(mounts.length).toBeGreaterThan(0);

    // The routes honoured the configured prefix, so the comparison is against the address
    // a client hits — and in the "/api" arm a page that dropped it cannot pass.
    for (const r of e.routes) expect(r.prefix).toBe(apiPrefix);

    // The composition arm exists: at least one mount's path is not a bare `<Name>.$path`.
    // Every such mount lands at exactly that object's own emitted `$path`, because `$path`
    // is the address an object is SERVED at — a TPH subtype's included.
    //
    // This assertion used to read `.not.toBe(...)`, pinning the opposite: a subtype's own
    // `$path` was its pluralized NAME (`/cars`) while the routes mounted it under its base
    // (`/vehicles/car`), and the comment here called that "the own `$path` names nothing"
    // defect. It was not only a documentation wart — `grid-hook-file.ts` builds its fetch
    // URL from `<Sub>.$path` with no TPH awareness, so an opted-in per-subtype grid asked
    // for an endpoint that 404s. `$path` now carries `restPath`, so the two agree.
    const composed = mounts.filter((m) => m.pathExpr !== `${m.object}.$path`);
    expect(composed.length).toBeGreaterThan(0);
    for (const m of composed) {
      expect(e.ownPaths.get(m.object)).toBeDefined();
      expect(m.address).toBe(`${apiPrefix}${e.ownPaths.get(m.object)}`);
    }

    // …and the agreement above is a real measurement rather than a tautology. The two
    // derivations still DISAGREE for this fixture — `resourcePath(Car)` is `/cars` and
    // `restPath(Car)` is `/vehicles/car` — so if the descriptor ever reverts to the own-
    // path spelling, the loop above fails. Without this the loop would silently go vacuous
    // the day the two collapsed into one, which is how a corpus stops covering the thing
    // it was written for.
    for (const m of composed) {
      const obj = e.root.objects().find((o) => o.name === m.object);
      expect(obj).toBeDefined();
      expect(restPath(obj!)).not.toBe(resourcePath(obj!));
      expect(e.ownPaths.get(m.object)).toBe(restPath(obj!));
    }

    // The segment arm is de-blinded: some subtype's discriminator value is neither its
    // name nor a single word, so lowercasing the value, lowercasing the NAME and
    // kebab-casing all spell different segments.
    expect(
      composed.some(
        (m) =>
          m.discriminatorValue !== undefined &&
          m.discriminatorValue.toLowerCase() !== m.object.toLowerCase() &&
          /[a-z][A-Z]/.test(m.discriminatorValue),
      ),
    ).toBe(true);

    // Both spellings of a multi-word name are on disk — an entity's snake `$path` and a
    // projection's kebab one — so a page applying one rule to both is visible.
    const paths = [...e.ownPaths.values()];
    expect(paths.some((p) => p.includes("_"))).toBe(true);
    expect(paths.some((p) => p.includes("-"))).toBe(true);

    // Both form arms: some objects got a `.form.tsx`, some documented objects did not.
    expect(e.forms.size).toBeGreaterThan(0);
    expect([...e.page.values()].some((d) => !d.hasForm)).toBe(true);
  });

  test("every documented endpoint is the address a routes file mounts, and every mount is documented", async () => {
    const e = await emitted();
    // FQN → mounted address, across ALL routes files: a TPH base's file carries the
    // polymorphic mount plus one per subtype, and those subtype mounts are the subtypes'
    // addresses — a subtype emits no routes file of its own.
    const mounted = new Map<string, string>();
    for (const m of allMounts(e)) {
      const key = keyOf(e.root, m.object);
      expect(mounted.has(key)).toBe(false);
      mounted.set(key, m.address);
    }
    const documented = new Map([...e.page].map(([key, d]) => [key, d.address] as const));
    expect(sorted(documented)).toEqual(sorted(mounted));
  });

  test("a form is announced for exactly the objects a `.form.tsx` was written for", async () => {
    const e = await emitted();
    const announced = [...e.page].filter(([, d]) => d.hasForm).map(([key]) => key).sort();
    const written = [...e.forms].map((name) => keyOf(e.root, name)).sort();
    expect(announced).toEqual(written);
  });
});
