// `rulesNamesFile()` — the rules names layer (ADR-0067 §1, layer 0) over the ADR-0066 vocabulary.
//
// The expected names come from ADR-0066's derivation rules, stated per test: the states are the
// enum's `@values`, the initial state its `@default`, a terminal state one no transition leaves; a
// transition a declared command claims derives no command (under the default `unclaimed`); an
// absent `@permission` derives `<package>.<operation>` or `<package>.<Entity>.<transition>`, and
// `@public` asks nothing. The compile tests hold the emitted unions to what a consumer may write.

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { COMPILE_TEST_TIMEOUT_MS } from "./compile-timeout.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot, type RulesSettings } from "@metaobjectsdev/metadata";
import { rulesNamesFile } from "../src/generators/index.js";
import type { GenContext } from "../src/generator.js";
import { makeScratchDir, removeTree } from "../src/scratch-dir.js";

setDefaultTimeout(COMPILE_TEST_TIMEOUT_MS);

const transition = (name: string, from: string[], to: string, extra: Record<string, unknown> = {}) =>
  ({ "transition.action": { name, "@from": from, "@to": to, ...extra } });

/** One sourced entity with a three-transition lifecycle, and an API whose command claims two. */
function purchasing(pkg = "acme::purchasing"): unknown {
  return {
    "metadata.root": {
      package: pkg,
      children: [
        {
          "object.entity": {
            name: "PurchaseRequest",
            children: [
              { "source.rdb": { "@table": "purchase_requests" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
              {
                "field.enum": {
                  name: "status",
                  "@values": ["draft", "submitted", "approved", "rejected"],
                  "@default": "draft",
                  children: [
                    transition("submit", ["draft"], "submitted"),
                    transition("withdraw", ["submitted"], "draft", { "@public": true }),
                    transition("approve", ["submitted"], "approved"),
                    transition("reject", ["submitted"], "rejected", { "@permission": "purchasing.review" }),
                  ],
                },
              },
            ],
          },
        },
        { "object.value": { name: "DecisionInput", children: [{ "field.long": { name: "requestId", extends: "PurchaseRequest.id" } }] } },
        {
          "api.operational": {
            name: "Purchasing",
            children: [
              {
                "operation.command": {
                  name: "decide",
                  "@inputRef": "DecisionInput",
                  "@objectRef": "PurchaseRequest",
                  "@transitions": ["approve", "reject"],
                  "@errors": ["over_budget", "already_decided"],
                },
              },
              { "operation.query": { name: "openRequests", "@outputRef": "PurchaseRequest", "@many": true, "@public": true } },
            ],
          },
        },
      ],
    },
  };
}

async function load(...models: unknown[]): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load(
    models.map((m, i) => new InMemoryStringSource(JSON.stringify(m), { id: `rules-${i}.json` })),
  );
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

async function emit(root: MetaRoot, settings?: RulesSettings): Promise<Record<string, string>> {
  if (settings !== undefined) root.rulesSettings = settings;
  const ctx = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    projectRoot: "/",
    config: { outputLayout: "flat", outDir: "/", extStyle: "js", dbImport: "~/db", dialect: "postgres" },
    warn: () => {},
  } as unknown as GenContext;
  const files = await rulesNamesFile().generate(ctx);
  return Object.fromEntries(files.map((f) => [f.path, f.content]));
}

const PATH = "acme/purchasing/rules.names.ts";

describe("rulesNamesFile — what one package's file names", () => {
  test("a lifecycle's states, initial, terminal states and transitions", async () => {
    const file = (await emit(await load(purchasing())))[PATH]!;
    expect(file).toContain(`export const PurchaseRequestStatusLifecycle = {
  field: "status",
  states: ["draft", "submitted", "approved", "rejected"],
  initial: "draft",
  terminal: ["approved", "rejected"],
  transitions: {
    submit: { from: ["draft"], to: "submitted" },
    withdraw: { from: ["submitted"], to: "draft" },
    approve: { from: ["submitted"], to: "approved" },
    reject: { from: ["submitted"], to: "rejected" },
  },
} as const;`);
  });

  test("only unclaimed transitions derive a command; @public asks nothing, an absent @permission derives one", async () => {
    const file = (await emit(await load(purchasing())))[PATH]!;
    expect(file).toContain(`export const PurchaseRequestCommands = {
  submit: { lifecycle: "status", permission: "acme::purchasing.PurchaseRequest.submit" },
  withdraw: { lifecycle: "status", public: true },
} as const;`);
  });

  test("operations, the permission list and the business errors", async () => {
    const file = (await emit(await load(purchasing())))[PATH]!;
    expect(file).toContain(`  decide: {
    kind: "command",
    permission: "acme::purchasing.decide",
    transitions: ["approve", "reject"],
    errors: ["over_budget", "already_decided"],
  },
  openRequests: { kind: "query", public: true },`);
    // decide's own permission and submit's derived one; withdraw and openRequests are public, and
    // the claimed reject's @permission is the command's to ask, not a point of its own.
    expect(file).toContain(`export const Permissions = ["acme::purchasing.PurchaseRequest.submit", "acme::purchasing.decide"] as const;`);
    expect(file).toContain(`export const BusinessErrors = ["already_decided", "over_budget"] as const;`);
  });

  test("rules.lifecycle.commands: all derives every transition's command, none derives no command", async () => {
    const all = (await emit(await load(purchasing()), { permissionNames: "advise", lifecycleCommands: "all" } as RulesSettings))[PATH]!;
    for (const t of ["submit", "withdraw", "approve", "reject"]) expect(all).toMatch(new RegExp(`^  ${t}: \\{ lifecycle: "status"`, "m"));
    expect(all).toContain(`reject: { lifecycle: "status", permission: "purchasing.review" }`);
    const none = (await emit(await load(purchasing()), { permissionNames: "advise", lifecycleCommands: "none" } as RulesSettings))[PATH]!;
    expect(none).not.toContain("PurchaseRequestCommands");
    expect(none).toContain(`export const Permissions = ["acme::purchasing.decide"] as const;`);
  });

  test("an inherited lifecycle is each concrete subtype's, and only a sourced one derives commands", async () => {
    const lifecycleField = {
      "field.enum": { name: "status", "@values": ["draft", "submitted"], "@default": "draft", children: [transition("submit", ["draft"], "submitted")] },
    };
    const root = await load({
      "metadata.root": {
        package: "acme::purchasing",
        children: [
          { "object.entity": { name: "Request", abstract: true, children: [
            { "field.long": { name: "id" } }, { "identity.primary": { name: "pk", "@fields": ["id"] } }, lifecycleField,
          ] } },
          { "object.entity": { name: "TravelRequest", extends: "Request", children: [{ "source.rdb": { "@table": "travel_requests" } }] } },
        ],
      },
    });
    const file = (await emit(root))[PATH]!;
    expect(file).toContain("export const RequestStatusLifecycle = {");
    expect(file).toContain("export const TravelRequestStatusLifecycle = {");
    expect(file).toContain(`export const TravelRequestCommands = {
  submit: { lifecycle: "status", permission: "acme::purchasing.TravelRequest.submit" },
} as const;`);
    expect(file).not.toContain("export const RequestCommands");
  });

  test("one file per package that declares rules, and none for a model without them", async () => {
    const plain = { "metadata.root": { package: "acme::catalog", children: [{ "object.entity": { name: "Item", children: [
      { "source.rdb": { "@table": "items" } }, { "field.long": { name: "id" } }, { "identity.primary": { name: "pk", "@fields": ["id"] } },
    ] } }] } };
    expect(Object.keys(await emit(await load(plain)))).toEqual([]);
    expect(Object.keys(await emit(await load(plain, purchasing())))).toEqual([PATH]);
  });
});

describe("rulesNamesFile — the file compiles and its unions are narrow", () => {
  function diagnostics(files: Record<string, string>): string[] {
    const dir = makeScratchDir("rules-names-compile-");
    try {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      const program = ts.createProgram(Object.keys(files).map((f) => join(dir, f)), {
        strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
      });
      return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    } finally {
      removeTree(dir);
    }
  }

  test("a consumer naming real states, transitions, permissions and errors compiles", async () => {
    const names = (await emit(await load(purchasing())))[PATH]!;
    const consumer = `import type { PurchaseRequestStatusState, PurchaseRequestStatusTransition, Permission, BusinessError, Operation, PurchaseRequestCommand } from "./rules.names.js";
const s: PurchaseRequestStatusState = "approved";
const t: PurchaseRequestStatusTransition = "withdraw";
const p: Permission = "acme::purchasing.decide";
const e: BusinessError = "over_budget";
const o: Operation = "openRequests";
const c: PurchaseRequestCommand = "submit";
export { s, t, p, e, o, c };
`;
    expect(diagnostics({ "rules.names.ts": names, "consumer.ts": consumer })).toEqual([]);
  });

  test("a renamed or misspelt name does not compile", async () => {
    const names = (await emit(await load(purchasing())))[PATH]!;
    const consumer = `import type { PurchaseRequestStatusState, Permission, PurchaseRequestCommand } from "./rules.names.js";
const s: PurchaseRequestStatusState = "approve";
const p: Permission = "purchasing.review";
const c: PurchaseRequestCommand = "approve";
export { s, p, c };
`;
    expect(diagnostics({ "rules.names.ts": names, "consumer.ts": consumer })).toHaveLength(3);
  });
});
