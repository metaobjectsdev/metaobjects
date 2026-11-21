// Runs fixtures/writer-conformance/ against the TypeScript writer (spec/code-writer.md).
// `core` cases run on CodeWriter with the options the case states; `typescript` cases run on
// TsWriter with its own defaults unless the case overrides them.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CodeWriter, type CodeWriterOptions, Group, type Piece, WriterError } from "../src/writer/code-writer.js";
import { TsWriter } from "../src/writer/ts-writer.js";

const CASES = resolve(import.meta.dir, "../../../../../fixtures/writer-conformance/cases");

type JsonPiece = string | { list: { open: string; items: JsonPiece[]; close: string; pad?: boolean } } | JsonPiece[];
type Op = [string, ...unknown[]];

interface WriterCase {
  description: string;
  dialect: string;
  options?: CodeWriterOptions;
  ops: Op[];
  expected?: string[];
  error?: string;
  errorQuotes?: string;
}

function toPiece(p: JsonPiece): Piece {
  if (typeof p === "string") return p;
  if (Array.isArray(p)) return p.map(toPiece);
  return new Group(p.list.open, p.list.items.map(toPiece), p.list.close, p.list.pad === true);
}

function run(c: WriterCase): string {
  const w = c.dialect === "core" ? new CodeWriter(c.options) : new TsWriter(c.options);
  for (const [op, ...args] of c.ops) {
    const pieces = (args as JsonPiece[]).map(toPiece);
    const s = args as string[];
    switch (op) {
      case "line": w.line(...pieces); break;
      case "open": w.open(...pieces); break;
      case "close": w.close(...pieces); break;
      case "blank": w.blank(); break;
      case "text": w.text(s[0]!); break;
      default: {
        if (!(w instanceof TsWriter)) throw new Error(`op ${op} is not a core op`);
        switch (op) {
          case "use": w.use(s[0]!, s[1]!); break;
          case "useType": w.useType(s[0]!, s[1]!); break;
          case "useDefault": w.useDefault(s[0]!, s[1]!); break;
          case "useNamespace": w.useNamespace(s[0]!, s[1]!); break;
          case "useSideEffect": w.useSideEffect(s[0]!); break;
          case "header": w.header(...s); break;
          case "doc": w.doc(...s); break;
          default: throw new Error(`unknown op ${op}`);
        }
      }
    }
  }
  return w.toString();
}

const files = readdirSync(CASES).filter((f) => f.endsWith(".json")).sort();

describe("writer conformance", () => {
  test("the corpus is present", () => {
    expect(files.length).toBeGreaterThanOrEqual(25);
  });

  for (const file of files) {
    const c = JSON.parse(readFileSync(join(CASES, file), "utf8")) as WriterCase;
    // A case of another port's dialect (`java`, ...) belongs to that port's writer.
    if (c.dialect !== "core" && c.dialect !== "typescript") continue;
    test(`${file.replace(/\.json$/, "")}: ${c.description}`, () => {
      if (c.dialect === "core") expect(c.options, "a core case states its options").toBeDefined();
      if (c.error !== undefined) {
        let thrown: unknown;
        try {
          run(c);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(WriterError);
        expect((thrown as WriterError).code).toBe(c.error as WriterError["code"]);
        if (c.errorQuotes !== undefined) expect((thrown as WriterError).message).toContain(c.errorQuotes);
        return;
      }
      const lines = c.expected!;
      expect(run(c)).toBe(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
    });
  }
});
