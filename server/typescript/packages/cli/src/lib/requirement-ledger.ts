// `meta verify --format json` — the per-requirement ledger rows.
//
// The requirement gate and its counts say how the ledger fares as a WHOLE; a reader
// (the explorer builder, an agent, a dashboard) also needs each entry's own verdict, and
// before this it had to infer "checked and clean" from a path's absence in the
// diagnostics. One row per `requirement.*` node states it outright: what the entry
// declares, the digest of its claim, whether each `@implementedBy` link resolves and to
// WHAT, and the codes the gate and the authoring lint reported against it.
//
// Every value here comes from the SAME scan, resolver and diagnostics the gate used on
// this run. Nothing is re-derived: a row that disagreed with the gate beside it would be
// a second answer to one question.

import {
  effectiveRequirementPackage,
  resolveClaimTarget,
  resolveMember,
  type MetaRequirement,
  type MetaData,
} from "@metaobjectsdev/metadata";
import { requirementDigest } from "@metaobjectsdev/codegen-ts";
import {
  diagnosticRequirement,
  resolveRequirementRef,
  splitMemberRef,
  type Diagnostic,
  type RequirementScan,
} from "./requirement-check.js";

/** One `@implementedBy` (or `@supersededBy`) link, as the gate resolved it. */
export interface RequirementLinkRow {
  /** The link exactly as authored. */
  ref: string;
  resolves: boolean;
  /** The node it binds to — `<owner resolution key>` or `<owner resolution key>.<member path>`
   *  for `@implementedBy`, `<package>::<path>` for `@supersededBy`. Absent when it does not
   *  resolve. */
  target?: string;
}

export interface RequirementDiagnosticRef {
  code: string;
  severity: string;
  /** "gate" can fail the build; "lint" never can. */
  source: "gate" | "lint";
}

/** One `requirement.*` node, as this run of `meta verify` judged it. */
export interface RequirementLedgerRow {
  /** The dotted child-name address every diagnostic prints. */
  path: string;
  /** The requirement's effective package, "" when it has none. */
  package: string;
  /** `<package>::<path>`, or `<path>` with no package — the prefix of every generated
   *  requirement test's id (`<qualifiedPath> [<unit>]`). */
  qualifiedPath: string;
  subType: string;
  level?: number;
  status?: string;
  disposition?: string;
  /** SHA-256 over the claim (subtype, level, status, statement, counterexample,
   *  `@implementedBy`) — the digest every port's requirement tests carry. */
  digest: string;
  implementedBy: RequirementLinkRow[];
  supersededBy?: RequirementLinkRow;
  /** Every finding this run reported against this requirement, gate and lint, in report order. */
  diagnostics: RequirementDiagnosticRef[];
  /** From the GATE findings only: "error" when one can fail the build, "warn" when the
   *  worst is a warning, "clean" when the gate reported nothing against this entry. */
  verdict: "clean" | "warn" | "error";
}

function implementedByRows(root: MetaData, req: MetaRequirement): RequirementLinkRow[] {
  // referrerPkg is the requirement's own effective package — the binding the gate uses
  // (ADR-0042), so a row resolves exactly the links the gate resolved.
  const referrerPkg = effectiveRequirementPackage(req);
  return req.implementedBy().map((ref) => {
    const { owner, path } = splitMemberRef(ref);
    const node = resolveClaimTarget(root, owner, referrerPkg);
    if (node === undefined) return { ref, resolves: false };
    if (path.length > 0 && resolveMember(node, path) === undefined) return { ref, resolves: false };
    const key = node.resolutionKey();
    return { ref, resolves: true, target: path.length === 0 ? key : `${key}.${path.join(".")}` };
  });
}

/**
 * One row per requirement in the scan, in the scan's (document) order.
 *
 * `diags` are this run's gate diagnostics and `lint` its authoring findings. Each is matched
 * to a row by the requirement node it names, and by path only when it names none.
 */
export function requirementLedgerRows(
  root: MetaData,
  scan: RequirementScan,
  diags: readonly Diagnostic[],
  lint: readonly Diagnostic[],
): RequirementLedgerRow[] {
  const byNode = new Map<MetaRequirement, RequirementDiagnosticRef[]>();
  const byPath = new Map<string, RequirementDiagnosticRef[]>();
  const note = (d: Diagnostic, source: "gate" | "lint"): void => {
    const ref = { code: d.code, severity: d.severity, source };
    const requirement = diagnosticRequirement.get(d);
    if (requirement !== undefined) {
      byNode.set(requirement, [...(byNode.get(requirement) ?? []), ref]);
    } else if (d.path !== undefined) {
      byPath.set(d.path, [...(byPath.get(d.path) ?? []), ref]);
    }
  };
  for (const d of diags) note(d, "gate");
  for (const d of lint) note(d, "lint");

  return scan.addressed.map(({ node: req, path }) => {
    const pkg = effectiveRequirementPackage(req);
    const diagnostics = [...(byNode.get(req) ?? []), ...(byPath.get(path) ?? [])];
    const gate = diagnostics.filter((d) => d.source === "gate");
    const verdict = gate.some((d) => d.severity === "error")
      ? "error"
      : gate.length > 0 ? "warn" : "clean";
    const level = req.level();
    const status = req.status();
    const disposition = req.disposition();
    const superseded = req.supersededBy();
    let supersededBy: RequirementLinkRow | undefined;
    if (superseded !== undefined) {
      const target = resolveRequirementRef(scan.addressed, superseded, pkg);
      const hit = target === undefined ? undefined : scan.addressed.find((r) => r.node === target);
      supersededBy = hit === undefined
        ? { ref: superseded, resolves: false }
        : { ref: superseded, resolves: true, target: qualify(effectiveRequirementPackage(hit.node), hit.path) };
    }
    return {
      path,
      package: pkg,
      qualifiedPath: qualify(pkg, path),
      subType: req.subType,
      // `exactOptionalPropertyTypes` — an omitted key, never an explicit `undefined`.
      ...(level !== undefined ? { level } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(disposition !== undefined ? { disposition } : {}),
      digest: requirementDigest(req),
      implementedBy: implementedByRows(root, req),
      ...(supersededBy !== undefined ? { supersededBy } : {}),
      diagnostics,
      verdict,
    };
  });
}

function qualify(pkg: string, path: string): string {
  return pkg === "" ? path : `${pkg}::${path}`;
}
