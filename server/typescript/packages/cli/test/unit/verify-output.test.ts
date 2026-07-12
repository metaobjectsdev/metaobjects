// server/typescript/packages/cli/test/unit/verify-output.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("meta verify — template.output drift", () => {
  let dir: string;
  let cwdBefore: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verify-output-"));
    cwdBefore = process.cwd();
    process.chdir(dir);
    mkdirSync(join(dir, "metaobjects"));
  });
  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("passes when template.output references a resolvable @payloadRef", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.ai.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::ai",
          children: [
            { "object.value": { name: "P", children: [{ "field.string": { name: "x" } }] } },
            {
              "template.output": {
                name: "Out",
                "@payloadRef": "P",
                "@textRef": "o/x",
                "@format": "json",
              },
            },
          ],
        },
      }),
    );
    mkdirSync(join(dir, "prompts", "o"), { recursive: true });
    writeFileSync(join(dir, "prompts", "o", "x"), "schema spec text");

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(0);
  });

  test("fails (exit 1) when template.output references a missing @payloadRef", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.ai.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::ai",
          children: [
            {
              "template.output": {
                name: "Broken",
                "@payloadRef": "DoesNotExist",
                "@textRef": "x/y",
                "@format": "json",
              },
            },
          ],
        },
      }),
    );
    mkdirSync(join(dir, "prompts", "x"), { recursive: true });
    writeFileSync(join(dir, "prompts", "x", "y"), "...");

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(1);
  });

  test("passes when only template.prompt nodes are present (no regression)", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.ai.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::ai",
          children: [
            { "object.value": { name: "P", children: [{ "field.string": { name: "name" } }] } },
            {
              "template.prompt": {
                name: "P1",
                "@payloadRef": "P",
                "@textRef": "p/1",
                "@format": "text",
              },
            },
          ],
        },
      }),
    );
    mkdirSync(join(dir, "prompts", "p"), { recursive: true });
    writeFileSync(join(dir, "prompts", "p", "1"), "Hello {{name}}");

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(0);
  });

  // #193 — verify --templates must drift-check @kind=email templates against
  // their @payloadRef (parity with template.prompt), not silently skip them.
  function writeEmailProject(htmlBody: string): void {
    writeFileSync(
      join(dir, "metaobjects", "meta.ai.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::ai",
          children: [
            { "object.value": { name: "P", children: [{ "field.string": { name: "name" } }] } },
            {
              "template.output": {
                name: "Welcome",
                "@kind": "email",
                "@payloadRef": "P",
                "@subjectRef": "e/subj",
                "@htmlBodyRef": "e/html",
              },
            },
          ],
        },
      }),
    );
    mkdirSync(join(dir, "prompts", "e"), { recursive: true });
    writeFileSync(join(dir, "prompts", "e", "subj"), "Hello {{name}}");
    writeFileSync(join(dir, "prompts", "e", "html"), htmlBody);
  }

  test("fails (exit 1) when a template.output @kind=email mustache references a field not on the payload (#193)", async () => {
    writeEmailProject("<p>Hi {{nonExistentField}}</p>"); // drift: field not on payload P

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(1);
  });

  test("passes when a template.output @kind=email mustache references only payload fields (#193)", async () => {
    writeEmailProject("<p>Hi {{name}}</p>"); // clean: {{name}} is on payload P

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(0);
  });

  test("fails (exit 1) when a document template.output @textRef mustache references a field not on the payload (#193 parity)", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.ai.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::ai",
          children: [
            { "object.value": { name: "P", children: [{ "field.string": { name: "name" } }] } },
            {
              "template.output": {
                name: "Doc",
                "@payloadRef": "P",
                "@textRef": "o/x",
                "@format": "json",
              },
            },
          ],
        },
      }),
    );
    mkdirSync(join(dir, "prompts", "o"), { recursive: true });
    writeFileSync(join(dir, "prompts", "o", "x"), "spec for {{missingField}}"); // drift

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(1);
  });
});
