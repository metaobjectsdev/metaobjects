// `meta eject docs-site` (ADR-0034 Amendment 9): copy the HTML site's templates and assets
// into `codegen/docs-site/{templates,assets}`, where `docsSiteFile()` reads them in place of
// the bundled ones. The site's BUILDER stays packaged (it assembles the page data the
// templates read; Amendment 8 ruling 3); what an adopter changes is the look, and that is
// these files. It was `meta docs --scaffold-site` until 1.1.0, and writes the same files to
// the same place.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OWNED_DOCS_SITE_DIR } from "@metaobjectsdev/codegen-ts";
import { readSiteFile, SITE_ASSET_NAMES, SITE_TEMPLATE_NAMES } from "@metaobjectsdev/docs-site";

/** The name `meta eject` takes for the site theme. A catalog entry, but not a generator copy. */
export const DOCS_SITE_NAME = "docs-site";

export interface DocsSiteFileResult {
  /** Project-relative path. */
  path: string;
  status: "created" | "preserved" | "replaced";
  /** Set when a kept file already holds exactly the shipped bytes. */
  identical?: true;
}

/**
 * Write each template and asset that is missing. A file already there is kept unless
 * `force`: a re-run never clobbers a theme the adopter has edited.
 */
export async function ejectDocsSite(projectRoot: string, force: boolean): Promise<DocsSiteFileResult[]> {
  const out: DocsSiteFileResult[] = [];
  const sets: Array<{ dir: string; names: readonly string[]; kind: "template" | "asset" }> = [
    { dir: `${OWNED_DOCS_SITE_DIR}/templates`, names: SITE_TEMPLATE_NAMES, kind: "template" },
    { dir: `${OWNED_DOCS_SITE_DIR}/assets`, names: SITE_ASSET_NAMES, kind: "asset" },
  ];
  for (const { dir, names, kind } of sets) {
    await mkdir(join(projectRoot, dir), { recursive: true });
    for (const name of names) {
      const path = `${dir}/${name}`;
      const abs = join(projectRoot, path);
      const existed = existsSync(abs);
      const text = readSiteFile(kind, name);
      // Kept unless --force; and --force over identical bytes writes nothing either.
      const identical = existed && (await readFile(abs, "utf8")) === text;
      if (existed && (!force || identical)) {
        out.push({ path, status: "preserved", ...(identical && { identical: true as const }) });
        continue;
      }
      await writeFile(abs, text, "utf8");
      out.push({ path, status: existed ? "replaced" : "created" });
    }
  }
  return out;
}
