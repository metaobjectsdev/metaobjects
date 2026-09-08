// `describeLoadError` / `reportLoadError` — the one rendering of a metadata LOAD failure.
//
// It shipped with NO test. That matters more than the usual "add coverage" argument, because
// the whole point of the function is a NEGATIVE guarantee: it reports exactly what the
// ADR-0009 envelope carried and stays silent about what it does not, so a caller can never
// read more precision into the line than the loader actually had. A function whose contract
// is "invents nothing" is exactly the kind that needs the invention pinned as impossible.
//
// Five commands used to print `failed to load metadata: ${err.message}` and throw the code,
// the file, the json path and the loader's own suggestions away. These assert each of those
// halves survives, and that a plain Error is not dressed up as an envelope.

import { describe, test, expect } from "bun:test";
import { describeLoadError, reportLoadError } from "../../src/lib/load-error.js";

/** A LoaderError-shaped throwable: a string `code` plus an object `source`. */
function loaderError(over: {
  message?: string;
  code?: string;
  files?: string[];
  jsonPath?: string;
  suggestions?: string[];
}): unknown {
  const err = new Error(over.message ?? "something is wrong") as Error & Record<string, unknown>;
  err["code"] = over.code ?? "ERR_UNKNOWN_ATTR";
  err["source"] = {
    ...(over.files !== undefined ? { files: over.files } : {}),
    ...(over.jsonPath !== undefined ? { jsonPath: over.jsonPath } : {}),
  };
  if (over.suggestions !== undefined) err["suggestions"] = over.suggestions;
  return err;
}

function captured(prefix: string, err: unknown): string[] {
  const lines: string[] = [];
  reportLoadError({ error: (m: string) => lines.push(m) }, prefix, err);
  return lines;
}

describe("describeLoadError", () => {
  test("a plain Error yields its message and NOTHING else", () => {
    // The invention guard. No code, no files, no jsonPath may be conjured for a throwable
    // that carried none — a caller reading `report.code` must get undefined, not a guess.
    const r = describeLoadError(new Error("boom"));
    expect(r.text).toBe("boom");
    expect(r.code).toBeUndefined();
    expect(r.files).toBeUndefined();
    expect(r.jsonPath).toBeUndefined();
    expect(r.suggestions).toBeUndefined();
  });

  test("a non-Error throwable is stringified rather than dropped", () => {
    expect(describeLoadError("just a string").text).toBe("just a string");
    expect(describeLoadError(undefined).text).toBe("undefined");
  });

  test("an object with a code but no source object is NOT an envelope", () => {
    // Both halves of the guard are required. A thrown `{ code: "..." }` from somewhere
    // else in the stack must not be rendered as loader provenance.
    const err = new Error("nope") as Error & Record<string, unknown>;
    err["code"] = "ENOENT";
    const r = describeLoadError(err);
    expect(r.text).toBe("nope");
    expect(r.code).toBeUndefined();
  });

  test("the code leads the line — it is the part a CI job keys on", () => {
    const r = describeLoadError(loaderError({ code: "ERR_ABSTRACT_SUBTYPE_AUTHORED", message: "field.base is abstract" }));
    expect(r.text.startsWith("ERR_ABSTRACT_SUBTYPE_AUTHORED: ")).toBe(true);
    expect(r.code).toBe("ERR_ABSTRACT_SUBTYPE_AUTHORED");
  });

  test("WHERE is reported: the file and the json path the message cannot name", () => {
    const r = describeLoadError(loaderError({
      files: ["metaobjects/meta.users.json"],
      jsonPath: "$.children[2].object.entity",
    }));
    expect(r.text).toContain("in metaobjects/meta.users.json at $.children[2].object.entity");
    expect(r.files).toEqual(["metaobjects/meta.users.json"]);
    expect(r.jsonPath).toBe("$.children[2].object.entity");
  });

  test("multiple files are joined, and an EMPTY entry is dropped rather than printed", () => {
    // An overlay failure legitimately spans files. An empty string is not a file, and a
    // line reading "in , b.json" claims provenance the loader did not have.
    const r = describeLoadError(loaderError({ files: ["a.json", "", "b.json"] }));
    expect(r.files).toEqual(["a.json", "b.json"]);
    expect(r.text).toContain("in a.json, b.json");
  });

  test("a source carrying NEITHER file nor path adds no `in` clause", () => {
    const r = describeLoadError(loaderError({ message: "bare" }));
    expect(r.text).toBe("ERR_UNKNOWN_ATTR: bare");
    expect(r.text).not.toContain(" in ");
  });

  test("only the file is known — the path clause is omitted, not faked", () => {
    const r = describeLoadError(loaderError({ files: ["only.json"] }));
    expect(r.text).toContain("in only.json");
    expect(r.text).not.toContain(" at ");
    expect(r.jsonPath).toBeUndefined();
  });

  test("only the path is known", () => {
    const r = describeLoadError(loaderError({ jsonPath: "$.a" }));
    expect(r.text).toContain("in at $.a");
    expect(r.files).toBeUndefined();
  });

  test("suggestions come through verbatim, empties filtered", () => {
    // Printed verbatim and never paraphrased: they are the loader's own next steps, and
    // verify.ts chooses between them and its own hint on the strength of this array being
    // non-empty. An empty string surviving here would silence that hint for nothing.
    const r = describeLoadError(loaderError({ suggestions: ["do X", "", "then Y"] }));
    expect(r.suggestions).toEqual(["do X", "then Y"]);
  });

  test("an all-empty suggestions array reads as ABSENT, not present-and-blank", () => {
    const r = describeLoadError(loaderError({ suggestions: ["", ""] }));
    expect(r.suggestions).toBeUndefined();
  });
});

describe("reportLoadError", () => {
  test("prints the prefixed line, then each suggestion indented", () => {
    const lines = captured("failed to load metadata", loaderError({
      message: "unknown attribute @forgeFoo",
      code: "ERR_UNKNOWN_ATTR",
      files: ["metaobjects/meta.users.json"],
      suggestions: ["remove @forgeFoo", "or opt the provider in"],
    }));
    expect(lines[0]).toBe(
      "failed to load metadata: ERR_UNKNOWN_ATTR: unknown attribute @forgeFoo\n  in metaobjects/meta.users.json",
    );
    expect(lines.slice(1)).toEqual(["  remove @forgeFoo", "  or opt the provider in"]);
  });

  test("a plain Error prints one line and no remedy it does not have", () => {
    expect(captured("gen: failed to load metadata", new Error("boom")))
      .toEqual(["gen: failed to load metadata: boom"]);
  });
});
