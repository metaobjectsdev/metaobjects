// TsWriter beyond the shared corpus: ts-poet `Code` interop (so a generator can convert one
// function at a time), the object-literal helpers, and the refusals.

import { describe, expect, test } from "bun:test";
import { OBJECT_SUBTYPE_ENTITY } from "@metaobjectsdev/metadata";
import { code, Import, imp, joinCode } from "ts-poet";
import { renderInferredTypes } from "../src/templates/inferred-types.js";
import { WRITER_ERRORS, WriterError } from "../src/writer/code-writer.js";
import { arr, call, key, props, str, TsWriter } from "../src/writer/ts-writer.js";
import { metaObject } from "./_meta-build.js";

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof WriterError ? e.code : `not a WriterError: ${String(e)}`;
  }
  return undefined;
}

describe("TsWriter accepts ts-poet Code", () => {
  test("an inline fragment is written as its text and its imports are collected", () => {
    const w = new TsWriter();
    w.line("export const a = ", code`${imp("eq@drizzle-orm")}(x, y)`, ";");
    w.line("export type T = ", imp("t:Row@./row"), ";");
    expect(w.toString()).toBe(
      'import { eq } from "drizzle-orm";\nimport type { Row } from "./row";\n\nexport const a = eq(x, y);\nexport type T = Row;\n',
    );
  });

  test("a multi-line fragment is re-indented to the current level and its blank-line runs collapse", () => {
    const w = new TsWriter();
    const body = code`
const ${imp("z@zod")}Schema = z.object({});


export default zSchema;
`;
    w.block("namespace N {", () => w.code(body));
    expect(w.toString()).toBe(
      'import { z } from "zod";\n\nnamespace N {\n  const zSchema = z.object({});\n\n  export default zSchema;\n}\n',
    );
  });

  test("default, namespace, side-effect and renamed imports carry over", () => {
    const w = new TsWriter();
    w.line(code`${imp("React=react")}; ${imp("path*node:path")}; ${imp("Poly+./polyfill")};`);
    w.line(code`${Import.importsName("Local", "./mod", false, "Exported")};`);
    expect(w.toString()).toBe(
      [
        'import * as path from "node:path";',
        'import React from "react";',
        'import { Exported as Local } from "./mod";',
        'import "./polyfill";',
        "",
        "React; path; Poly;",
        "Local;",
        "",
      ].join("\n"),
    );
  });

  test("nested and joined fragments are walked for imports", () => {
    const parts = [code`${imp("and@drizzle-orm")}(a)`, code`${imp("or@drizzle-orm")}(b)`];
    const w = new TsWriter();
    w.line("const c = [", joinCode(parts, { on: ", " }), "];");
    expect(w.toString()).toBe('import { and, or } from "drizzle-orm";\n\nconst c = [and(a), or(b)];\n');
  });

  test("a real generator section moves into a writer-built file with its imports hoisted", () => {
    const section = renderInferredTypes(metaObject(OBJECT_SUBTYPE_ENTITY, "Post"));
    const w = new TsWriter();
    w.line("export const posts = table;");
    w.blank();
    w.code(section);
    expect(w.toString()).toBe(
      [
        'import type { InferInsertModel, InferSelectModel } from "drizzle-orm";',
        "",
        "export const posts = table;",
        "",
        "export type Post = InferSelectModel<typeof posts>;",
        "export type PostInsert = InferInsertModel<typeof posts>;",
        "export type PostUpdate = Partial<PostInsert>;",
        "",
      ].join("\n"),
    );
  });

  test("a fragment from a different ts-poet copy is refused, not written without its imports", () => {
    const foreign = { toCodeString: () => "x", childNodes: [] };
    expect(errorCode(() => new TsWriter().line(foreign))).toBe(WRITER_ERRORS.unknownPiece);
  });

  test("a multi-line fragment passed to line() is refused", () => {
    expect(errorCode(() => new TsWriter().line(code`a;\nb;`))).toBe(WRITER_ERRORS.newlineInLine);
  });
});

describe("TsWriter expression helpers", () => {
  test("props, arr, call, str and key build literals that fit or break", () => {
    const rule = props()
      .set("ops", [arr(["eq", "ne"].map(str)), " as const"])
      .set(key("leading-wildcard"), "false")
      .add("...rest");
    const w = new TsWriter({ width: 90 });
    w.line("export const a = ", rule, ";");
    w.line("export const b = ", call("define", [str("a value that is long enough"), rule]), ";");
    expect(w.toString()).toBe(
      [
        'export const a = { ops: ["eq", "ne"] as const, "leading-wildcard": false, ...rest };',
        "export const b = define(",
        '  "a value that is long enough",',
        '  { ops: ["eq", "ne"] as const, "leading-wildcard": false, ...rest },',
        ");",
        "",
      ].join("\n"),
    );
  });

  test("a doc comment escapes a closing delimiter in its text", () => {
    const w = new TsWriter();
    w.doc("Ends a comment with */ in its text.");
    expect(w.toString()).toBe("/** Ends a comment with *\\/ in its text. */\n");
  });

  test("a doc comment too long for one line becomes a block", () => {
    const w = new TsWriter({ width: 20 });
    w.doc("A sentence that does not fit.");
    expect(w.toString()).toBe("/**\n * A sentence that does not fit.\n */\n");
  });

  test("the same default imported under two names is refused", () => {
    const w = new TsWriter();
    w.useDefault("React", "react");
    expect(errorCode(() => w.useDefault("R", "react"))).toBe(WRITER_ERRORS.importConflict);
  });
});

describe("the writer is extended by subclassing (ADR-0063)", () => {
  test("a subclass overrides one method and keeps everything else", () => {
    // An adopter who wants relative imports first changes only the ordering step.
    class RelativeFirst extends TsWriter {
      protected override orderModules(modules: readonly string[]): string[] {
        const base = super.orderModules(modules);
        return [...base.filter((m) => m.startsWith(".")), ...base.filter((m) => !m.startsWith("."))];
      }
    }
    const w = new RelativeFirst();
    w.line("const x = ", w.use("x", "zod"), "(", w.use("y", "./local"), ");");
    expect(w.toString()).toBe(
      ['import { y } from "./local";', 'import { x } from "zod";', "", "const x = x(y);", ""].join("\n"),
    );
  });
});
