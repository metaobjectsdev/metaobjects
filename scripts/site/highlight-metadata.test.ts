import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadVocabulary, highlightMetadata } from "./highlight-metadata.js";
import { extractMarkedRegion } from "./markers.js";

const REPO = resolve(import.meta.dirname, "../..");
const REGISTRY = resolve(REPO, "fixtures/registry-conformance/expected-registry.json");
const vocab = loadVocabulary(REGISTRY);

describe("loadVocabulary", () => {
  test("reads every type.subType pair from the manifest", () => {
    expect(vocab.subTypes.has("object.entity")).toBe(true);
    expect(vocab.subTypes.has("field.string")).toBe(true);
    expect(vocab.subTypes.size).toBeGreaterThan(60);
  });

  test("reads attribute names sigil-free, as the YAML surface spells them", () => {
    expect(vocab.attrs.has("column")).toBe(true);
    expect(vocab.attrs.has("@column")).toBe(false);
  });

  test("carries defaultSubTypes so a bare type key resolves", () => {
    expect(vocab.defaultSubTypes.metadata).toBe("root");
  });
});

describe("highlightMetadata", () => {
  test("a registered subtype is a keyword, not a key", () => {
    expect(highlightMetadata("- object.entity:", vocab))
      .toBe('- <span class="keyword">object.entity</span>:');
  });

  test("a bare TYPE key resolves through defaultSubTypes and is a keyword", () => {
    expect(highlightMetadata("metadata:", vocab))
      .toBe('<span class="keyword">metadata</span>:');
  });

  test("a reserved structural keyword is a key", () => {
    expect(highlightMetadata("  name: Subscriber", vocab))
      .toBe('  <span class="key">name</span>: Subscriber');
  });

  test("a comment is a comment", () => {
    expect(highlightMetadata("# hello", vocab))
      .toBe('<span class="comment"># hello</span>');
  });

  test("THE LIVE DEFECT: requirement.functional is a subtype, never a comment", () => {
    const html = highlightMetadata("- requirement.functional:", vocab);
    expect(html).toContain('class="keyword"');
    expect(html).not.toContain('class="comment"');
  });

  // Without this the gate is VACUOUS on the showcase's own primary snippet, which
  // is written almost entirely as inline flow maps.
  test("classifies keys INSIDE an inline flow map", () => {
    const html = highlightMetadata("- source.rdb: { table: subscribers }", vocab);
    expect(html).toContain('<span class="keyword">source.rdb</span>');
    expect(html).toContain('<span class="key">table</span>');
  });

  test("classifies EVERY key in a multi-entry flow map", () => {
    const html = highlightMetadata(
      "- field.string: { name: email, maxLength: 320, required: true }", vocab);
    for (const k of ["name", "maxLength", "required"])
      expect(html).toContain(`<span class="key">${k}</span>`);
  });

  // TOLERANT, not throwing — see the note on classify(). A closed-world key check
  // is impossible: attr.properties is an arbitrary bag and attr.expression carries
  // its own node grammar. The LOADER is the vocabulary gate; this reports.
  test("reports a key it cannot place, and still renders it as a key", () => {
    const unknown: string[] = [];
    const html = highlightMetadata("  verifiedBy: [x]", vocab, (k) => unknown.push(k));
    expect(unknown).toEqual(["verifiedBy"]);
    expect(html).toContain('<span class="key">verifiedBy</span>');
  });

  test("reports an unplaceable key inside a flow map, not just at line start", () => {
    const unknown: string[] = [];
    highlightMetadata("- requirement.functional: { verifiedBy: [x] }", vocab,
      (k) => unknown.push(k));
    expect(unknown).toEqual(["verifiedBy"]);
  });

  test("reports NOTHING for either real corpus — provider vocabulary included", () => {
    const unknown: string[] = [];
    for (const f of [
      "examples/showcase/metaobjects/meta.subscriber.yaml",
      "examples/advanced-modeling/metaobjects/meta.catalog.yaml",
      "examples/advanced-modeling/metaobjects/meta.content.yaml",
      "examples/advanced-modeling/metaobjects/meta.prompts.yaml",
    ]) {
      highlightMetadata(readFileSync(resolve(REPO, f), "utf8"), vocab,
        (k) => unknown.push(`${f.split("/").pop()}:${k}`));
    }
    // Expression-tree node keys are the one legitimate residue: `arg` is part of
    // attr.expression's closed grammar, not a registry attribute.
    expect(unknown.filter((u) => !u.endsWith(":arg"))).toEqual([]);
  });

  test("view.image is a SUBTYPE — gold — even though the cross-port manifest omits it", () => {
    expect(highlightMetadata("- view.image:", vocab))
      .toBe('- <span class="keyword">view.image</span>:');
  });

  test("a QUOTED value gets the string class; an unquoted one stays plain", () => {
    const html = highlightMetadata('  pattern: "^[^@]+$"', vocab);
    expect(html).toContain('<span class="string">"^[^@]+$"</span>');
    expect(highlightMetadata("  package: acme", vocab)).toBe(
      '  <span class="key">package</span>: acme');
  });

  test("a trailing comment is a comment", () => {
    expect(highlightMetadata("  name: x   # why", vocab))
      .toBe('  <span class="key">name</span>: x   <span class="comment"># why</span>');
  });

  test("a # inside a quoted value is NOT a comment", () => {
    const html = highlightMetadata('  pattern: "a#b"', vocab);
    expect(html).not.toContain('class="comment"');
  });

  test("escapes HTML so a regex pattern cannot inject markup", () => {
    expect(highlightMetadata('  pattern: "^<a>$"', vocab)).toContain("&lt;a&gt;");
  });

  test("every marked region of the real showcase model highlights with no unknowns", () => {
    const yaml = readFileSync(
      resolve(REPO, "examples/showcase/metaobjects/meta.subscriber.yaml"), "utf8");
    for (const id of ["showcase-model", "showcase-requirement", "showcase-prompt"]) {
      const unknown: string[] = [];
      const html = highlightMetadata(extractMarkedRegion(yaml, id), vocab,
        (k) => unknown.push(k));
      expect(unknown).toEqual([]);
      expect(html).toContain('class="keyword"');
    }
  });
});
