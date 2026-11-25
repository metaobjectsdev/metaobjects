// The generated `.railway/railway.ts` type-checks against the railway 3.17.0 SDK where the
// hand-written one did not. The full check was run against the SDK's own types outside this
// suite (the `railway` package is not a dependency: its install downloads a CLI binary). What
// it found, and what these tests keep from coming back, is read from the golden files, which
// are the generator's public output:
//   - `restartPolicyType` is the SDK's literal union, so only "ALWAYS" | "ON_FAILURE" | "NEVER";
//     a widened `string` is refused.
//   - `variables` is not declared in the SDK's types, so an object literal that names it is
//     refused by the excess-property check; the file spreads it from a declared constant.
// The golden files are parsed, not matched as text, so a comment or a string that mentions
// `variables` is not mistaken for a key.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { RESTART_POLICY, type RestartPolicyType } from "../src/index.js";

/** The SDK's `restartPolicyType` union (railway 3.17.0), the independent oracle for the values. */
const SDK_RESTART_POLICY_TYPES: readonly string[] = ["ALWAYS", "ON_FAILURE", "NEVER"];

// A widened `string` value type fails `bun run typecheck`.
export const restartPolicyIsTheLiteralUnion: Readonly<Record<string, RestartPolicyType>> = RESTART_POLICY;

const GOLDEN = join(import.meta.dir, "golden");
const scenarios = readdirSync(GOLDEN);

function parse(scenario: string): ts.SourceFile {
  const file = join(GOLDEN, scenario, ".railway/railway.ts");
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => visit(c, fn));
}

function propertyName(p: ts.ObjectLiteralElementLike): string | undefined {
  return p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
}

describe("the RESTART_POLICY map is the SDK's literal union", () => {
  test("its values are exactly the SDK's restartPolicyType values", () => {
    expect([...new Set<string>(Object.values(RESTART_POLICY))].sort()).toEqual([...SDK_RESTART_POLICY_TYPES].sort());
  });
});

describe.each(scenarios)("golden %s", (scenario) => {
  const source = parse(scenario);

  test("`variables` is never a key of a project(...) object, only spread from the declared constant", () => {
    const projects: ts.ObjectLiteralExpression[] = [];
    visit(source, (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "project") {
        const arg = n.arguments[1];
        if (arg !== undefined && ts.isObjectLiteralExpression(arg)) projects.push(arg);
      }
    });
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      for (const el of p.properties) expect(propertyName(el)).not.toBe("variables");
    }
  });

  test("an unmanaged-variables spread names a top-level const declaring `variables`", () => {
    const declared = new Set<string>();
    for (const st of source.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer !== undefined && ts.isObjectLiteralExpression(d.initializer) && d.initializer.properties.some((p) => propertyName(p) === "variables")) {
          declared.add(d.name.text);
        }
      }
    }
    visit(source, (n) => {
      if (ts.isSpreadAssignment(n) && ts.isIdentifier(n.expression) && /ariables/.test(n.expression.text)) {
        expect(declared.has(n.expression.text)).toBe(true);
      }
    });
  });

  test("every restartPolicyType is a string literal of the SDK's union", () => {
    visit(source, (n) => {
      if (ts.isPropertyAssignment(n) && propertyName(n) === "restartPolicyType") {
        expect(ts.isStringLiteral(n.initializer)).toBe(true);
        expect(SDK_RESTART_POLICY_TYPES).toContain((n.initializer as ts.StringLiteral).text);
      }
    });
  });
});

test("the checks are not vacuous: some golden spreads the constant and some sets a restart policy", () => {
  let spreads = 0;
  let policies = 0;
  for (const scenario of scenarios) {
    visit(parse(scenario), (n) => {
      if (ts.isSpreadAssignment(n) && ts.isIdentifier(n.expression) && n.expression.text === "unmanagedVariables") spreads++;
      if (ts.isPropertyAssignment(n) && propertyName(n) === "restartPolicyType") policies++;
    });
  }
  expect(spreads).toBeGreaterThan(0);
  expect(policies).toBeGreaterThan(0);
});
