// The report-export shared writer module: emitted text is imported and exercised, so what is
// tested is what an adopter's project would run.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderExportWriters } from "../src/templates/report-export-file.js";
import { reportExport } from "../src/generators/report-export-file.js";

interface Writers {
  EXPORT_CSV_BOM: boolean;
  EXPORT_XML_NULLS: string;
  cellText(v: unknown): string;
  csvCell(t: string, guard: boolean): string;
  writeCsv(c: { name: string; guard: boolean }[], r: Record<string, unknown>[]): string;
  writeXml(root: string, c: { name: string; guard: boolean }[], r: Record<string, unknown>[]): string;
  xmlText(t: string): string;
}

async function load(opts: { maxRows: number; xmlNulls: "empty" | "nil"; csvBom: boolean }): Promise<Writers> {
  const dir = mkdtempSync(join(tmpdir(), "report-export-writers-"));
  try {
    const file = join(dir, `w-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(file, renderExportWriters(opts));
    return (await import(pathToFileURL(file).href)) as Writers;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DEFAULTS = { maxRows: 100000, xmlNulls: "empty", csvBom: false } as const;
const cols = [{ name: "label", guard: true }, { name: "n", guard: false }];

describe("report-export writers: CSV", () => {
  test("CRLF after every record including the last, header of field names", async () => {
    const w = await load(DEFAULTS);
    expect(w.writeCsv(cols, [{ label: "a", n: 1 }])).toBe("label,n\r\na,1\r\n");
    expect(w.writeCsv(cols, [])).toBe("label,n\r\n");
  });

  test("quotes on quote, comma, CR and LF, doubling embedded quotes", async () => {
    const w = await load(DEFAULTS);
    expect(w.csvCell('say "hi"', false)).toBe('"say ""hi"""');
    expect(w.csvCell("a,b", false)).toBe('"a,b"');
    expect(w.csvCell("a\nb", false)).toBe('"a\nb"');
    expect(w.csvCell("a\rb", false)).toBe('"a\rb"');
    expect(w.csvCell("plain", false)).toBe("plain");
  });

  test("injection guard prefixes = + - @ TAB CR on string cells, then quotes", async () => {
    const w = await load(DEFAULTS);
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(w.csvCell(`${lead}x`, true).replace(/^"|"$/g, "")).toBe(`'${lead}x`);
    }
    // quoting follows the prefix: a leading CR forces quotes, a leading = with a comma too
    expect(w.csvCell("=1,2", true)).toBe(`"'=1,2"`);
    expect(w.csvCell("\rx", true)).toBe(`"'\rx"`);
    expect(w.csvCell("=x", false)).toBe("=x");
  });

  test("numbers, booleans and null are never guarded", async () => {
    const w = await load(DEFAULTS);
    expect(w.writeCsv(cols, [{ label: null, n: -5 }])).toBe("label,n\r\n,-5\r\n");
    expect(w.writeCsv([{ name: "b", guard: true }], [{ b: true }])).toBe("b\r\ntrue\r\n");
    // a negative decimal string in an unguarded column stays a number
    expect(w.writeCsv([{ name: "d", guard: false }], [{ d: "-1.5" }])).toBe("d\r\n-1.5\r\n");
  });

  test("a structured value is its JSON", async () => {
    const w = await load(DEFAULTS);
    expect(w.cellText(["a", "b"])).toBe('["a","b"]');
    expect(w.writeCsv([{ name: "t", guard: false }], [{ t: ["a", "b"] }])).toBe('t\r\n"[""a"",""b""]"\r\n');
  });

  test("EXPORT_CSV_BOM is a generated constant, off by default", async () => {
    expect((await load(DEFAULTS)).EXPORT_CSV_BOM).toBe(false);
    const w = await load({ ...DEFAULTS, csvBom: true });
    expect(w.EXPORT_CSV_BOM).toBe(true);
    expect(w.writeCsv(cols, []).startsWith("﻿label")).toBe(true);
  });
});

describe("report-export writers: XML", () => {
  test("escapes & < > and writes CR as a reference; no injection guard", async () => {
    const w = await load(DEFAULTS);
    expect(w.xmlText("<&>")).toBe("&lt;&amp;&gt;");
    expect(w.xmlText("a\rb")).toBe("a&#13;b");
    expect(w.writeXml("R", cols, [{ label: "=1", n: 1 }])).toBe("<R><row><label>=1</label><n>1</n></row></R>");
  });

  test("characters XML 1.0 cannot carry are replaced", async () => {
    const w = await load(DEFAULTS);
    expect(w.xmlText("a\u0001b")).toBe("a�b");
  });

  test("empty option: a null is an empty element and nothing is declared", async () => {
    const w = await load(DEFAULTS);
    expect(w.writeXml("R", cols, [{ label: null, n: 1 }])).toBe("<R><row><label/><n>1</n></row></R>");
    expect(w.writeXml("R", cols, [])).toBe("<R/>");
  });

  test("nil option: xsi:nil on a null, xmlns:xsi on the root", async () => {
    const w = await load({ ...DEFAULTS, xmlNulls: "nil" });
    expect(w.writeXml("R", cols, [{ label: null, n: 1 }])).toBe(
      '<R xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><row><label xsi:nil="true"/><n>1</n></row></R>',
    );
    expect(w.writeXml("R", cols, [])).toBe('<R xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>');
  });

  test("an empty string is an empty element, not a nil", async () => {
    const w = await load({ ...DEFAULTS, xmlNulls: "nil" });
    expect(w.writeXml("R", cols, [{ label: "", n: 1 }])).toContain("<label/>");
    expect(w.writeXml("R", cols, [{ label: "", n: 1 }])).not.toContain("nil");
  });
});

describe("report-export generator", () => {
  test("carries the marker the routes generators key on, and refuses a bad cap", () => {
    expect(reportExport().emitsReportExport).toBe(true);
    expect(() => reportExport({ maxRows: 0 })).toThrow(/maxRows/);
  });
});
