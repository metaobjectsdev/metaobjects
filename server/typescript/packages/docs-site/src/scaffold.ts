import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The classic site's 9 mustache templates (basenames under templates/). */
export const CLASSIC_TEMPLATE_NAMES: readonly string[] = [
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

/** The classic site's themeable assets. search-index.json is generated, not themed. */
export const CLASSIC_ASSET_NAMES: readonly string[] = ["site.css", "site.js"];

/** The explorer's templates (basenames under templates/), which `meta eject docs-site` copies. */
export const EXPLORER_TEMPLATE_NAMES: readonly string[] = [
  "explorer-head.mustache",
  "explorer-foot.mustache",
  "explorer-card.mustache",
  "explorer-overview.html.mustache",
  "explorer-map.html.mustache",
  "explorer-object.html.mustache",
  "explorer-prompt.html.mustache",
  "explorer-prompts.html.mustache",
  "explorer-requirements.html.mustache",
  "explorer-requirement.html.mustache",
  "explorer-matrix.html.mustache",
  "explorer-trace.html.mustache",
  "explorer-gaps.html.mustache",
  "explorer-api.html.mustache",
  "explorer-model.html.mustache",
  "explorer-package.html.mustache",
];

/** The explorer's themeable assets (basenames under assets/). */
export const EXPLORER_ASSET_NAMES: readonly string[] = ["explorer.css", "explorer.js"];

/** Every template `meta eject docs-site` copies: both sites' themes, so either can be owned. */
export const SITE_TEMPLATE_NAMES: readonly string[] = [...CLASSIC_TEMPLATE_NAMES, ...EXPLORER_TEMPLATE_NAMES];

/** Every asset `meta eject docs-site` copies. */
export const SITE_ASSET_NAMES: readonly string[] = [...CLASSIC_ASSET_NAMES, ...EXPLORER_ASSET_NAMES];

/** Read a bundled template or asset by basename (for scaffolding into a consumer). */
export function readSiteFile(kind: "template" | "asset", name: string): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const dir = resolve(selfDir, kind === "template" ? "../templates" : "../assets");
  return readFileSync(join(dir, name), "utf8");
}
