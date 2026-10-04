// gen-report-shapes.ts — (re)generate the committed report-shapes artifact.
//
// Run: `bun run gen:report-shapes` (from this package). Pure metadata → JSON, no DB.
// Writes fixtures/persistence-conformance/report-shapes.json: the derived
// fields (contract Table B) of every object.report in the canonical model, in declaration
// order. TypeScript produces it; the C#, Java, Kotlin and Python ports each derive the
// same shapes from the same model and byte-match this file in a container-free unit test,
// so the derivation cannot drift between ports.
//
// Format (a contract, every port serialises the same bytes): reports in declaration order;
// keys in the order below; two-space indent; a trailing newline. `typeSource` is
// `<resolutionKey of the declaring entity>.<field name>` or null; `view` is the report's
// OWN read-only source's physical name or null.
//
// The artifact sits BESIDE canonical/, not inside it: every port directory-loads
// canonical/ as metadata, and a non-metadata .json there fails the load.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  OBJECT_SUBTYPE_REPORT,
  reportReadSource,
  reportShape,
  type MetaField,
  type MetaRoot,
} from "@metaobjectsdev/metadata";

import { loadMetadataDir } from "./load-metadata.ts";
import { CANONICAL_DIR, CORPUS_DIR } from "./paths.ts";

/** Absolute path to the committed report-shapes artifact. */
export const REPORT_SHAPES_PATH = resolve(CORPUS_DIR, "report-shapes.json");

interface ShapeFieldJson {
  name: string;
  role: string;
  subType: string;
  required: boolean;
  typeSource: string | null;
}

interface ShapeReportJson {
  report: string;
  from: string;
  view: string | null;
  fields: ShapeFieldJson[];
}

function typeSourceOf(field: MetaField | undefined): string | null {
  if (field === undefined) return null;
  const owner = field.parent;
  if (owner === undefined) throw new Error(`field '${field.name}' has no owning entity.`);
  return `${owner.resolutionKey()}.${field.name}`;
}

/** The artifact's bytes for a loaded model. Deterministic: declaration order, no clock. */
export function generateReportShapesJson(root: MetaRoot): string {
  const reports: ShapeReportJson[] = [];
  for (const report of root.objects()) {
    if (report.subType !== OBJECT_SUBTYPE_REPORT) continue;
    const shape = reportShape(report, root);
    // The ONE source-selection rule (own read-only source with role primary, else the first
    // own read-only source): the source the lowering names the view by and the runtime reads.
    // A sourceless report has no view.
    const source = reportReadSource(report);
    reports.push({
      report: report.resolutionKey(),
      from: shape.from.resolutionKey(),
      view: source === undefined ? null : source.physicalName,
      fields: shape.fields.map((f) => ({
        name: f.name,
        role: f.role,
        subType: f.subType,
        required: f.required,
        typeSource: typeSourceOf(f.typeSource),
      })),
    });
  }
  return `${JSON.stringify({ reports }, null, 2)}\n`;
}

/** Read the committed report-shapes artifact. */
export function readReportShapesJson(): string {
  return readFileSync(REPORT_SHAPES_PATH, "utf8");
}

async function main(): Promise<void> {
  const root = await loadMetadataDir(CANONICAL_DIR);
  const json = generateReportShapesJson(root);
  writeFileSync(REPORT_SHAPES_PATH, json, "utf8");
  /* eslint-disable no-console */
  console.log(`wrote ${REPORT_SHAPES_PATH} (${json.length} bytes)`);
  /* eslint-enable no-console */
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
