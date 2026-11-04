// The requirement ledger as `meta verify --format json` states it, for the docs site's model
// explorer (`docsSiteFile()`), which runs inside `meta gen` and `meta verify --codegen`.
//
// codegen-ts cannot run the requirement gate (it lives here, in the CLI), so the two commands
// compute this and hand it to the run as `RunGenOpts.requirementLedger`. It is the same scan,
// gate, lint and ledger rows `meta verify` uses, with the gate's defaults: no
// `--require-implementers`, the authoring lint on. Fixed defaults rather than the caller's
// flags, so the generated site depends on the model alone and `verify --codegen` can hold it.

import type { MetaData } from "@metaobjectsdev/metadata";
import { REQUIREMENT_STATUSES } from "@metaobjectsdev/metadata";
import type { AdvisoryDiagnosticRow } from "./advisory.js";
import {
  checkRequirements,
  scanRequirements,
  summariseRequirements,
  type Diagnostic,
  type RequirementSummary,
} from "./requirement-check.js";
import { lintRequirements } from "./requirement-lint.js";
import { requirementLedgerRows, type RequirementLedgerRow } from "./requirement-ledger.js";

/** The ledger counts `meta verify` prints on every run, machine-readable. */
export interface RequirementCounts {
  total: number;
  functional: number;
  architectural: number;
  byStatus: { status: string; count: number }[];
  undecided: number;
  /** Absent when coverage was not measured — FR-043 §5.4. */
  entitiesClaimed?: number;
  entitiesTotal?: number;
  /** How many metadata files the two entity counts were taken over. */
  metadataFiles: number;
}

/** The counts as the structured payload carries them. */
export function requirementCountsOf(s: RequirementSummary, metadataFiles: number): RequirementCounts {
  const order = [...REQUIREMENT_STATUSES];
  return {
    total: s.total,
    functional: s.functional,
    architectural: s.architectural,
    byStatus: order
      .filter((k) => (s.byStatus[k] ?? 0) > 0)
      .map((k) => ({ status: k, count: s.byStatus[k] ?? 0 })),
    undecided: s.undecided,
    // Absent when coverage was not measured (FR-043 §5.4), never zeroed: a reader cannot tell
    // `0/0 claimed` from "not measured", and the two mean opposite things.
    ...(s.entitiesTotal === undefined
      ? {}
      : { entitiesClaimed: s.entitiesClaimed ?? 0, entitiesTotal: s.entitiesTotal }),
    metadataFiles,
  };
}

/** One requirement finding as the structured payload carries it. */
export interface RequirementDiagnosticRow extends AdvisoryDiagnosticRow {
  /** The fully-qualified name of the entity the finding is about when its subject is not a
   *  requirement (`WARN_REQUIREMENT_OBJECT_UNCLAIMED`), or "". */
  node: string;
}

/** One finding as the structured payload carries it. */
export function requirementDiagnosticRow(d: Diagnostic, source: "gate" | "lint"): RequirementDiagnosticRow {
  return {
    code: d.code,
    // "" rather than omitted: a tabular encoder (TOON) needs every row to carry the same keys.
    path: d.path ?? "",
    node: d.node ?? "",
    severity: d.severity,
    source,
    message: d.message,
  };
}

/** The part of `meta verify --format json` the explorer builder reads. */
export interface RequirementPayload {
  requirementLedger: RequirementLedgerRow[];
  requirementCounts: RequirementCounts;
  requirements: { rows: RequirementDiagnosticRow[] };
}

/**
 * The requirement ledger of a loaded model, or undefined when it declares no requirement.
 * `coverable` and `metadataFiles` are the collection's (`inCoverage`, `files.length`).
 */
export function requirementPayload(
  root: MetaData,
  collection: { inCoverage: (fqn: string) => boolean; files: readonly string[] },
): RequirementPayload | undefined {
  const scan = scanRequirements(root, { coverable: collection.inCoverage, requireImplementers: false });
  const s = summariseRequirements(root, scan);
  if (s === undefined) return undefined;
  const diags = [...checkRequirements(root, scan)];
  const lint = lintRequirements(root, scan.addressed);
  return {
    requirementLedger: requirementLedgerRows(root, scan, diags, lint),
    requirementCounts: requirementCountsOf(s, collection.files.length),
    requirements: {
      rows: [
        ...diags.map((d) => requirementDiagnosticRow(d, "gate")),
        ...lint.map((d) => requirementDiagnosticRow(d, "lint")),
      ],
    },
  };
}
