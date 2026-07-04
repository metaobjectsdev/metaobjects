import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The 9 mustache templates the site is built from (basenames under templates/). */
export const SITE_TEMPLATE_NAMES: readonly string[] = [
  "chrome-head.mustache",
  "chrome-foot.mustache",
  "index.html.mustache",
  "package.html.mustache",
  "object.html.mustache",
  "prompt.html.mustache",
  "output.html.mustache",
  "enums.html.mustache",
  "coverage.html.mustache",
];

/** The site's themeable assets (basenames under assets/). search-index.json is generated, not themed. */
export const SITE_ASSET_NAMES: readonly string[] = ["site.css", "site.js"];

/** Read a bundled template or asset by basename (for scaffolding into a consumer). */
export function readSiteFile(kind: "template" | "asset", name: string): string {
  const dir = resolve(import.meta.dir, kind === "template" ? "../templates" : "../assets");
  return readFileSync(join(dir, name), "utf8");
}
