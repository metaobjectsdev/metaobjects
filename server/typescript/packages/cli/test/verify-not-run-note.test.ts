/**
 * `meta verify` gate selection (ADR-0021 D2): naming a gate runs ONLY the gates named, and a
 * bare `verify` runs the template gate. That rule stands — but a reviewer ran
 * `verify --codegen --db <url>`, got a green exit, and reasonably read it as a full run while
 * the template gate never ran. A partial run now says, in one line, which gates it skipped and
 * the flag that selects each.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCommand, notRunNote } from "../src/commands/verify.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [{ "object.value": { name: "Note", children: [{ "field.string": { name: "text" } }] } }],
  },
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-not-run-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.acme.json"), MODEL, "utf8");
  return root;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    return { code: await fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("meta verify — a partial run names the gates that did not run", () => {
  test("notRunNote lists each unselected gate with its selecting flag", () => {
    const note = notRunNote([
      { gate: "templates", ran: false, ok: true },
      { gate: "schema", ran: true, ok: true },
      { gate: "codegen", ran: true, ok: true },
      { gate: "docs", ran: false, ok: true },
      { gate: "requirements", ran: true, ok: true },
    ]);
    expect(note).toBe("meta verify — not run: templates (--templates), docs (--docs)");
  });

  test("notRunNote is silent when every gate ran", () => {
    expect(notRunNote([{ gate: "templates", ran: true, ok: true }])).toBeUndefined();
  });

  test("an explicit --templates run reports the gates it skipped", async () => {
    const root = await project();
    const { code, out } = await capture(() => verifyCommand(["--templates"], root));
    expect(code).toBe(0);
    const line = out.split("\n").find((l) => l.includes("not run:"));
    expect(line).toBeDefined();
    expect(line).toContain("codegen (--codegen)");
    expect(line).toContain("docs (--docs)");
    expect(line).toContain("schema (--db <url>)");
    expect(line).not.toContain("templates");
  });
});
