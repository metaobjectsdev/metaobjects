// test/agent-context/drift.test.ts
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FIELD_SUBTYPES, OBJECT_SUBTYPES, SOURCE_SUBTYPES, TEMPLATE_SUBTYPES } from "@metaobjectsdev/metadata";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../../agent-context");

function allMarkdown(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allMarkdown(p, acc);
    else if (name.endsWith(".md") || name.endsWith(".mustache")) acc.push(p);
  }
  return acc;
}

describe("agent-context vocabulary drift", () => {
  const files = allMarkdown(CONTENT_ROOT);
  const corpus = files.map((f) => ({ f, text: readFileSync(f, "utf8") }));

  test("there is content to check", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  test("never uses retired tokens (pre-v2 encoding / source subtypes / @dbColumn)", () => {
    const retired = [/source\.dbTable/, /source\.dbView/, /@dbColumn\b/, /"subType"\s*:/, /\bmerge:\s*true\b/];
    const hits: string[] = [];
    for (const { f, text } of corpus) {
      for (const re of retired) if (re.test(text)) hits.push(`${f} :: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  test("every `field.<subtype>` mentioned is a real FIELD_SUBTYPE", () => {
    const known = new Set<string>(FIELD_SUBTYPES as readonly string[]);
    const bad: string[] = [];
    for (const { f, text } of corpus) {
      for (const m of text.matchAll(/\bfield\.([a-z][a-zA-Z0-9]*)\b/g)) {
        if (!known.has(m[1]!)) bad.push(`${f} :: field.${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every `object.`, `source.`, and `template.` subtype mentioned is real", () => {
    const objs = new Set<string>(OBJECT_SUBTYPES as readonly string[]);
    const srcs = new Set<string>(SOURCE_SUBTYPES as readonly string[]);
    const tmpls = new Set<string>(TEMPLATE_SUBTYPES as readonly string[]);
    const bad: string[] = [];
    for (const { f, text } of corpus) {
      for (const m of text.matchAll(/\bobject\.([a-z][a-zA-Z0-9]*)\b/g)) if (!objs.has(m[1]!)) bad.push(`${f} :: object.${m[1]}`);
      for (const m of text.matchAll(/\bsource\.([a-z][a-zA-Z0-9]*)\b/g)) if (!srcs.has(m[1]!)) bad.push(`${f} :: source.${m[1]}`);
      for (const m of text.matchAll(/\btemplate\.([a-z][a-zA-Z0-9]*)\b/g)) if (!tmpls.has(m[1]!)) bad.push(`${f} :: template.${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});
