import { expect, test } from "bun:test";
import { SITE_TEMPLATE_NAMES, SITE_ASSET_NAMES, readSiteFile } from "../src/scaffold";

test("SITE_TEMPLATE_NAMES lists all 9 mustache templates", () => {
  expect([...SITE_TEMPLATE_NAMES].sort()).toEqual([
    "chrome-foot.mustache", "chrome-head.mustache", "coverage.html.mustache",
    "enums.html.mustache", "index.html.mustache", "object.html.mustache",
    "output.html.mustache", "package.html.mustache", "prompt.html.mustache",
  ]);
});

test("SITE_ASSET_NAMES lists the two assets", () => {
  expect([...SITE_ASSET_NAMES].sort()).toEqual(["site.css", "site.js"]);
});

test("readSiteFile returns the bundled template + asset contents", () => {
  for (const name of SITE_TEMPLATE_NAMES) expect(readSiteFile("template", name).length).toBeGreaterThan(0);
  expect(readSiteFile("asset", "site.css").length).toBeGreaterThan(0);
  // chrome-head is the page shell — sanity-check it is real template content
  expect(readSiteFile("template", "chrome-head.mustache")).toContain("{{");
});
