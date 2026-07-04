import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLinks } from "../src/link-check";

test("detects dangling files and anchors", () => {
  const d = mkdtempSync(join(tmpdir(), "lc-"));
  mkdirSync(join(d, "a"), { recursive: true });
  writeFileSync(join(d, "index.html"), `<a href="a/one.html">ok</a><a href="a/two.html">bad</a><a href="a/one.html#f-x">ok</a><a href="a/one.html#f-y">bad</a>`);
  writeFileSync(join(d, "a/one.html"), `<div id="f-x"></div>`);
  const errs = checkLinks(d, ["index.html", "a/one.html"]);
  expect(errs).toEqual(["index.html -> a/two.html", "index.html -> a/one.html#f-y"]);
});
