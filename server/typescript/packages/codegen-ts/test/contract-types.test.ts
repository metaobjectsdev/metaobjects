// `contractTypes()` — the contract types layer (ADR-0067 §1, layer 1): the shapes a caller and a
// service exchange, with no persistence mapping in them.
//
// The oracles, stated per test:
//   - the wire error codes are ADR-0066's list (O5 names every code a route answers itself: the
//     shell's five in §6 and the API contract's six), and their statuses are §6's shell steps
//     (404, 403, 409) and the error tables of docs/features/api-contract.md;
//   - an operation's business errors are the fixture's `@errors`, its output a list when the
//     fixture says `@many`, and its input the `@inputRef` value object's insert schema;
//   - an entity's contract read type is the read type the entity generator already promises for
//     the same object (the Drizzle select row, or the read schema's inferred type) — two modules
//     that describe one row two ways are the defect this layer would add;
//   - a projection is read-only (ADR-0028): it has a read shape and nothing a caller sends.
// The compile tests hold the emitted types to what a consumer may write, with the real compiler.

import { describe, test, expect, setDefaultTimeout, beforeAll, afterAll } from "bun:test";
import { COMPILE_TEST_TIMEOUT_MS } from "./compile-timeout.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadUris, type MetaRoot } from "@metaobjectsdev/metadata";
import { contractTypes } from "../src/generators/index.js";
import { entityFile } from "../src/generators/entity-file.js";
import { runGen } from "../src/runner.js";
import { defineConfig, type Dialect } from "../src/metaobjects-config.js";
import type { OutputLayout } from "../src/import-path.js";
import { makeScratchDir, removeTree } from "../src/scratch-dir.js";
import type { Generator } from "../src/generator.js";

setDefaultTimeout(COMPILE_TEST_TIMEOUT_MS);

const FIXTURES = join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures");
const RULES_MODEL = join(FIXTURES, "codegen-noop", "rules", "with", "meta.purchasing.json");
const FITNESS_MODEL = join(FIXTURES, "persistence-conformance", "canonical", "meta.fitness.json");

/** ADR-0066 §6: the codes the enforcing shell answers with on its own. */
const SHELL_CODES = ["not_found", "forbidden", "invalid_transition", "transition_condition_failed", "state_managed"];
/** ADR-0066 O5: the API contract's own codes. */
const CONTRACT_CODES = ["validation", "invalid_json", "invalid_id", "method_not_allowed", "constraint_violation", "internal"];

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) removeTree(d);
});

async function load(file: string): Promise<MetaRoot> {
  const r = await loadUris([pathToFileURL(file).href]);
  expect(r.errors.map((e) => e.message)).toEqual([]);
  return r.root;
}

/** A scratch project that resolves `zod`, and the entity file's own packages when asked, the way
 *  an adopter's would. The contract layer alone gets zod only, so a persistence import cannot
 *  compile. */
function project(withDrizzle = false): string {
  const dir = makeScratchDir("contract-types-");
  scratch.push(dir);
  const require = createRequire(import.meta.url);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  for (const pkg of withDrizzle ? ["zod", "drizzle-orm", "@metaobjectsdev/runtime-ts"] : ["zod"]) {
    mkdirSync(dirname(join(dir, "node_modules", pkg)), { recursive: true });
    symlinkSync(dirname(require.resolve(`${pkg}/package.json`)), join(dir, "node_modules", pkg), "dir");
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return dir;
}

const OUT = "gen";

async function generate(
  root: MetaRoot,
  generators: Generator[],
  opts: { layout?: OutputLayout; dialect?: Dialect; withDrizzle?: boolean } = {},
): Promise<{ dir: string; out: string; files: Record<string, string> }> {
  const dir = project(opts.withDrizzle);
  await runGen({
    config: defineConfig({
      outDir: OUT,
      extStyle: "js",
      dbImport: "~/db",
      dialect: opts.dialect ?? "postgres",
      outputLayout: opts.layout ?? "package",
      generators,
    }),
    metadata: root,
    projectRoot: dir,
  });
  const out = join(dir, OUT);
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files[p.slice(out.length + 1)] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(out)) walk(out);
  return { dir, out, files };
}

/** Compile `files` (paths under `out`) plus `extra` (written beside them), strictest settings. */
function compile(out: string, files: string[], extra: Record<string, string> = {}): string[] {
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(out, name), text);
  const program = ts.createProgram(
    [...files, ...Object.keys(extra)].map((f) => join(out, f)),
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
    },
  );
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file && d.start !== undefined ? `${d.file.fileName.slice(out.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "";
    return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
}

const EQ = "type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;";

/** A specifier is a third-party or MetaObjects package the module imports. */
const imported = (text: string): string[] =>
  [...text.matchAll(/^import .* from "([^".][^"]*)";$/gm)].map((m) => m[1]!).sort();

describe("contractTypes() over the rules model (package layout)", () => {
  let gen: Awaited<ReturnType<typeof generate>>;
  beforeAll(async () => {
    gen = await generate(await load(RULES_MODEL), [contractTypes()]);
  });

  test("writes the entity's and projection's contracts, the reached value, the operations and the error bodies", () => {
    expect(Object.keys(gen.files).sort()).toEqual([
      "acme/purchasing/DecisionInput.ts",
      "acme/purchasing/PurchaseRequest.contract.ts",
      "acme/purchasing/RequestSummary.contract.ts",
      "acme/purchasing/operations.contract.ts",
      "errors.contract.ts",
    ]);
  });

  test("imports no persistence: zod is the one package any module needs", () => {
    for (const [path, text] of Object.entries(gen.files)) {
      expect({ path, imports: imported(text).filter((s) => s !== "zod") }).toEqual({ path, imports: [] });
    }
  });

  test("a projection is read-only: a read schema and type, nothing a caller sends", async () => {
    const m = await import(pathToFileURL(join(gen.out, "acme/purchasing/RequestSummary.contract.ts")).href);
    expect(Object.keys(m).sort()).toEqual(["RequestSummarySchema"]);
    // A view row carries every declared column; the key is never null.
    expect(m.RequestSummarySchema.safeParse({ id: 1, title: null }).success).toBe(true);
    expect(m.RequestSummarySchema.safeParse({ id: null, title: "x" }).success).toBe(false);
  });

  test("the wire codes and their statuses are the ADR-0066 and api-contract ones", async () => {
    const m = await import(pathToFileURL(join(gen.out, "errors.contract.ts")).href);
    expect([...m.ShellErrorCodes]).toEqual(SHELL_CODES);
    expect([...m.ContractErrorCodes]).toEqual(CONTRACT_CODES);
    expect(m.ErrorStatus).toEqual({
      not_found: 404,
      forbidden: 403,
      invalid_transition: 409,
      transition_condition_failed: 409,
      state_managed: 409,
      validation: 400,
      invalid_json: 400,
      invalid_id: 400,
      method_not_allowed: 405,
      internal: 500,
    });
  });

  test("an operation's input schema is its @inputRef value's, and validates the value's fields", async () => {
    const m = await import(pathToFileURL(join(gen.out, "acme/purchasing/operations.contract.ts")).href);
    expect(m.DecideInputSchema.safeParse({ requestId: 7, comment: "within budget" }).success).toBe(true);
    expect(m.DecideInputSchema.safeParse({ requestId: "seven" }).success).toBe(false);
  });

  test("the emitted types compile and say what the model declares", () => {
    const check = `${EQ}
import type { ContractErrorCode, ShellErrorCode, ValidationErrorBody, ConstraintViolationBody } from "./errors.contract.js";
import type * as Ops from "./acme/purchasing/operations.contract.js";
import type { RequestSummary } from "./acme/purchasing/RequestSummary.contract.js";
import type { PurchaseRequestCreate, PurchaseRequestPatch } from "./acme/purchasing/PurchaseRequest.contract.js";
type Shell = ${SHELL_CODES.map((c) => JSON.stringify(c)).join(" | ")};
type Contract = ${CONTRACT_CODES.map((c) => JSON.stringify(c)).join(" | ")};
export const shell: Eq<ShellErrorCode, Shell> = true;
export const contract: Eq<ContractErrorCode, Contract> = true;
// @errors: [over_budget, already_decided]
export const business: Eq<Ops.DecideBusinessError, "over_budget" | "already_decided"> = true;
export const decideError: Eq<Ops.DecideError["error"], Shell | Contract | "over_budget" | "already_decided"> = true;
// A query declares no @errors.
export const queryBusiness: Eq<Ops.OpenRequestsBusinessError, never> = true;
// openRequests is @many, requestSummary is not.
export const many: Eq<Ops.OpenRequestsOutput, readonly RequestSummary[]> = true;
export const one: Eq<Ops.RequestSummaryOutput, RequestSummary> = true;
export const input: Ops.DecideInput = { requestId: 7, comment: "within budget" };
export const create: PurchaseRequestCreate = { id: 1, title: "Desk", amountCents: 12000, status: "draft" };
export const patch: PurchaseRequestPatch = { title: null };
export const issue: ValidationErrorBody = { error: "validation", issues: [{ code: "invalid_type", path: ["title"], message: "Expected string" }] };
export const conflict: ConstraintViolationBody = { error: "constraint_violation", constraint: "unique" };
// @ts-expect-error a code the operation does not declare is not one of its errors
export const undeclared: Ops.DecideError = { error: "payment_declined" };
// @ts-expect-error a value outside the lifecycle's states is not a status
export const badState: PurchaseRequestCreate = { id: 1, status: "archived" };
`;
    expect(compile(gen.out, Object.keys(gen.files), { "check.ts": check })).toEqual([]);
  });
});

describe("contractTypes() over the fitness corpus", () => {
  let root: MetaRoot;
  beforeAll(async () => {
    root = await load(FITNESS_MODEL);
  });

  for (const layout of ["flat", "package"] as const) {
    test(`compiles under the strictest settings, ${layout} layout, with no persistence import`, async () => {
      const gen = await generate(root, [contractTypes()], { layout });
      expect(Object.keys(gen.files).length).toBeGreaterThan(20);
      expect(compile(gen.out, Object.keys(gen.files))).toEqual([]);
      for (const [path, text] of Object.entries(gen.files)) {
        expect({ path, imports: imported(text).filter((s) => s !== "zod") }).toEqual({ path, imports: [] });
      }
    });
  }

  // Two objects differ from the entity file's read type, both by intent:
  //   - `Auth`, a TPH base: the entity file unions its subtypes' INPUT interfaces, while the contract
  //     unions their read rows — what the entity file's own `parseAuth` returns at runtime;
  //   - `Asset`: `payload` is a `field.string` whose `@dbColumnType: jsonb` is physical only
  //     (ADR-0037 step 1), so Drizzle reads it as `unknown` and the contract keeps the declared string.
  const DIFFERS = new Set(["Auth", "Asset"]);

  for (const dialect of ["postgres", "sqlite", "mysql"] as const) {
    test(`beside the entity generator (${dialect}): value modules collapse, and every read type matches the entity file's`, async () => {
      // The two generators write the same value modules and enums.ts; runGen refuses a path two
      // generators write with different bytes, so finishing at all is the collapse check.
      const gen = await generate(root, [entityFile({ allowlists: false }), contractTypes()], { layout: "flat", dialect, withDrizzle: true });
      const names = Object.keys(gen.files)
        .map((p) => /^(.*)\.contract\.ts$/.exec(p)?.[1])
        .filter((n): n is string => n !== undefined && n !== "errors" && n !== "operations" && !DIFFERS.has(n));
      expect(names.length).toBeGreaterThan(20);
      const lines = names.map((n) => {
        // The entity file's read type: its read schema's when it declares one (a TPH subtype, a
        // projection, a write-through entity), else the exported row type.
        const row = gen.files[`${n}.ts`]!.includes(`export const ${n}Schema`)
          ? `z.infer<typeof import("./${n}.js").${n}Schema>`
          : `import("./${n}.js").${n}`;
        return `export const ${n}Eq: Eq<${row}, import("./${n}.contract.js").${n}> = true;`;
      });
      const check = [EQ, `import type { z } from "zod";`, ...lines].join("\n");
      expect(compile(gen.out, Object.keys(gen.files), { "check.ts": check })).toEqual([]);
    });
  }
});

describe("contractTypes() is silent without anything to describe", () => {
  test("a model of value objects only gets no file", async () => {
    const dir = makeScratchDir("contract-types-model-");
    scratch.push(dir);
    const file = join(dir, "meta.values.json");
    writeFileSync(file, JSON.stringify({
      "metadata.root": { package: "acme", children: [{ "object.value": { name: "Money", children: [{ "field.long": { name: "cents" } }] } }] },
    }));
    const gen = await generate(await load(file), [contractTypes()]);
    expect(gen.files).toEqual({});
  });
});
