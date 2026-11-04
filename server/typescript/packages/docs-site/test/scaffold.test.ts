import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CLASSIC_ASSET_NAMES,
  CLASSIC_TEMPLATE_NAMES,
  EXPLORER_ASSET_NAMES,
  EXPLORER_TEMPLATE_NAMES,
  SITE_ASSET_NAMES,
  SITE_TEMPLATE_NAMES,
  readSiteFile,
} from "../src/scaffold";

const PKG = join(import.meta.dir, "..");

test("CLASSIC_TEMPLATE_NAMES lists the classic site's 9 mustache templates", () => {
  expect([...CLASSIC_TEMPLATE_NAMES].sort()).toEqual([
    "chrome-foot.mustache", "chrome-head.mustache", "coverage.html.mustache",
    "enums.html.mustache", "index.html.mustache", "object.html.mustache",
    "output.html.mustache", "package.html.mustache", "prompt.html.mustache",
  ]);
  expect([...CLASSIC_ASSET_NAMES].sort()).toEqual(["site.css", "site.js"]);
});

test("every bundled explorer template and asset is on the eject list, so an owned theme is whole", () => {
  const templates = readdirSync(join(PKG, "templates")).filter((f) => f.startsWith("explorer-")).sort();
  expect([...EXPLORER_TEMPLATE_NAMES].sort()).toEqual(templates);
  const assets = readdirSync(join(PKG, "assets")).filter((f) => f.startsWith("explorer")).sort();
  expect([...EXPLORER_ASSET_NAMES].sort()).toEqual(assets);
});

test("readSiteFile returns the bundled template + asset contents", () => {
  for (const name of SITE_TEMPLATE_NAMES) expect(readSiteFile("template", name).length).toBeGreaterThan(0);
  for (const name of SITE_ASSET_NAMES) expect(readSiteFile("asset", name).length).toBeGreaterThan(0);
  // chrome-head is the page shell — sanity-check it is real template content
  expect(readSiteFile("template", "chrome-head.mustache")).toContain("{{");
});
