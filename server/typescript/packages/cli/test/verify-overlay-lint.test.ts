// `meta verify` — the overlay authoring lint (FR-023 §11.1 item 4, Task 17).
//
// The parser's own merge rule (parser-core.ts: "Default: no operator →
// silently reuse existing or create new") means an unflagged top-level
// redeclaration of an EXISTING node works today, whether or not it carries
// `overlay: true` — as long as the target still exists under the same
// (type, resolutionKey). The lint exists because that silent success hides a
// real risk: the same unflagged redeclaration becomes a silent NEW object,
// with no error at all, the day the target is renamed or removed. This suite
// drives `meta verify` end-to-end (temp dirs + `run()`, same pattern as
// `verify-requirements-imported.test.ts` / `gen-imported-nodes.test.ts`)
// rather than unit-testing `lintOverlays` directly, because the finding is a
// property of an on-disk collection of files, not of one loaded model.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../src/index.js";

const DEP_NAME = "acme-common";
const ARTIFACT_BASENAME = "acme-common.metaobjects.json";
// The real, committed dependency-conformance fixture — its bytes hash to the
// pinned `sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d`
// (global-constraints.md's LOCK_V1), and it declares acme::common::Address,
// acme::common::Audited and acme::common::Customer. Reused verbatim rather than
// hand-rolled so this test's snapshot+lock agree with the pinned hash by
// construction, not by a second, easy-to-drift computation.
const ARTIFACT_FIXTURE = resolve(
  import.meta.dirname,
  "../../../../../fixtures/dependency-conformance/artifacts/acme-common-v1.json",
);

/** The reference lock (global-constraints.md's LOCK_V1), verbatim. */
const LOCK_V1 = JSON.stringify({
  schema_version: 1,
  dependencies: {
    [DEP_NAME]: {
      version: "1.0.0",
      metamodelVersion: "1.0",
      resolvedFrom: { path: "../acme-common/metaobjects" },
      artifact: ARTIFACT_BASENAME,
      integrity: "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d",
      packages: ["acme::common"],
      nodes: ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"],
    },
  },
});

/** The reference config (global-constraints.md's CONFIG_REF), verbatim. */
const CONFIG_REF = JSON.stringify({
  schema_version: 1,
  sources: [],
  dependencies: [{ name: DEP_NAME, path: "../acme-common/metaobjects" }],
});

/** The consumer's own model: one entity it owns (global-constraints.md's APP). */
const APP = JSON.stringify({
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** The consumer redeclaring the dependency's Customer, adding a view.text
 *  child — with or without `overlay: true` on the top-level declaration. */
function customerOverlayFile(flagged: boolean): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme::common",
      children: [
        {
          "object.entity": {
            name: "Customer",
            ...(flagged ? { overlay: true } : {}),
            children: [
              {
                "field.string": {
                  name: "email",
                  children: [{ "view.text": { name: "emailView" } }],
                },
              },
            ],
          },
        },
      ],
    },
  });
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A consumer of acme-common, with `metaobjects/meta.ov.json` redeclaring
 *  acme::common::Customer — flagged or not. */
function overlayProject(flagged: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "vov-"));
  dirs.push(root);

  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), APP, "utf8");
  writeFileSync(join(root, "metaobjects", "meta.ov.json"), customerOverlayFile(flagged), "utf8");

  const depDir = join(root, ".metaobjects", "deps", DEP_NAME);
  mkdirSync(depDir, { recursive: true });
  cpSync(ARTIFACT_FIXTURE, join(depDir, ARTIFACT_BASENAME));

  writeFileSync(join(root, ".metaobjects", "config.json"), CONFIG_REF, "utf8");
  writeFileSync(join(root, ".metaobjects", "deps.lock.json"), LOCK_V1, "utf8");
  return root;
}

/** Three own files all declaring app::Subscriber, none flagged. Alphabetical
 *  basename order (a, b, c) is the discovery order the loader/collection use. */
function threeWayProject(): string {
  const root = mkdtempSync(join(tmpdir(), "vov-3way-"));
  dirs.push(root);
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(
    join(root, "metaobjects", "meta.a.json"),
    JSON.stringify({
      "metadata.root": {
        package: "app",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(root, "metaobjects", "meta.b.json"),
    JSON.stringify({
      "metadata.root": {
        package: "app",
        children: [
          { "object.entity": { name: "Subscriber", children: [{ "field.string": { name: "email" } }] } },
        ],
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(root, "metaobjects", "meta.c.json"),
    JSON.stringify({
      "metadata.root": {
        package: "app",
        children: [
          { "object.entity": { name: "Subscriber", children: [{ "field.string": { name: "name" } }] } },
        ],
      },
    }),
    "utf8",
  );
  return root;
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta verify — the overlay authoring lint (FR-023 §11.1 item 4)", () => {
  test("(a) an unflagged redeclaration of an imported node is an advisory finding, exit 0", async () => {
    const root = overlayProject(false);
    const exit = await run(["verify", "--format", "text", "--cwd", root]);
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    expect(all).toContain(
      "acme::common::Customer is redeclared in metaobjects/meta.ov.json without overlay: true",
    );
  });

  test("(b) the same redeclaration WITH overlay: true produces no finding", async () => {
    const root = overlayProject(true);
    const exit = await run(["verify", "--format", "text", "--cwd", root]);
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    expect(all).not.toContain("is redeclared in");
    expect(all).not.toContain("acme::common::Customer");
  });

  test("(c) three own files declaring the same node unflagged: two findings, naming the 2nd and 3rd files", async () => {
    const root = threeWayProject();
    const exit = await run(["verify", "--format", "text", "--cwd", root]);
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    expect(all).toContain("app::Subscriber is redeclared in metaobjects/meta.b.json without overlay: true");
    expect(all).toContain("app::Subscriber is redeclared in metaobjects/meta.c.json without overlay: true");
    // The FIRST unflagged declaration is the base — never reported as a redeclaration.
    expect(all).not.toContain("redeclared in metaobjects/meta.a.json");
    // Exactly two findings, not more (e.g. no third finding produced by comparing
    // b against c a second time).
    const occurrences = all.split("app::Subscriber is redeclared in").length - 1;
    expect(occurrences).toBe(2);
  });

  test("(d) --no-overlay-lint silences the finding from (a)", async () => {
    const root = overlayProject(false);
    const exit = await run(["verify", "--format", "text", "--cwd", root, "--no-overlay-lint"]);
    expect(exit).toBe(0);

    const all = [...out, ...err].join("\n");
    expect(all).not.toContain("is redeclared in");
  });

  test("META_NO_OVERLAY_LINT=1 also silences the finding from (a)", async () => {
    const root = overlayProject(false);
    const prev = process.env.META_NO_OVERLAY_LINT;
    process.env.META_NO_OVERLAY_LINT = "1";
    try {
      const exit = await run(["verify", "--format", "text", "--cwd", root]);
      expect(exit).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.META_NO_OVERLAY_LINT;
      else process.env.META_NO_OVERLAY_LINT = prev;
    }

    const all = [...out, ...err].join("\n");
    expect(all).not.toContain("is redeclared in");
  });
});
