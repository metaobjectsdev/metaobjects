// The capability ledger — `metaobjects/capabilities.yaml` (issue #290).
//
// A record of what the product does, checked by `meta verify` when the file is
// present. The ledger is RESERVED, NOT REGISTERED (the ADR-0040 treatment): it
// adds no metamodel vocabulary, no `capability.*` type, no registry entry. It
// enters the registry only when a shipping consumer *dispatches* on capability
// records, per the ADR-0007 Amendment 2 bar. Nothing does today, so this is a
// TS-CLI-only artifact — the D1 / leading-wildcard precedent for single-port
// tooling.
//
// The one payload with controlled evidence behind it is `status`. Agents given
// only the model proposed extending a deliberately-retired capability 0 times
// out of 24 — each believing it was reusing rather than reviving, because a
// retired feature is *more* attractive to a retrieval-driven agent than a live
// one: purpose-built for exactly the request, never complicated by production.
// A `status: abandoned` line says so where nothing in the model can.
//
// Levels are organisational, and the link boundary is the rule that matters:
// L1 solution / L2 segment (app, library) / L3 service are ORGANISATIONAL and
// never reference the model; L4 binds an object and L5 binds a member (field,
// view, identity). Architectural entries are level-less — they are
// object-independent by definition — and carry their claim set directly.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  TYPE_OBJECT,
  OBJECT_SUBTYPE_ENTITY,
  PACKAGE_SEPARATOR,
  resolveObjectRef,
  didYouMeanHint,
  type MetaData,
} from "@metaobjectsdev/metadata";

// Repository ROOT, beside `metaobjects.config.ts` — deliberately NOT inside
// `metaobjects/`. Issue #290 specified `metaobjects/capabilities.yaml`, and that
// path cannot work: the loader treats every .json/.yaml/.yml under `metaobjects/`
// as metadata (sdk `memory.ts` isMetadataFile), so a ledger there is parsed as a
// metadata root and fails the load outright with `Unknown root type
// "capabilities.base"`. Excluding it by filename would mean the metamodel loader
// knowing about a CLI-only artifact, which is exactly the coupling the
// reserved-not-registered ruling forbids. The root also keeps it discoverable —
// an agent that lists the repository sees it, which is how a ledger gets read
// unprompted.
export const LEDGER_PATH = "capabilities.yaml";

/** Closed enum. An unknown value is a hard error — a typo must not silently
 *  disable the one field with controlled evidence behind it. */
export const CAPABILITY_STATUSES = ["live", "partial", "abandoned", "superseded"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** Statuses whose nodes are supposed to still exist. A dangling `implementedBy`
 *  on one of these means the model moved and the ledger is stale (error). On
 *  `abandoned`/`superseded` the nodes are supposed to be GONE, so a dangling
 *  reference is correct and carries no diagnostic — that asymmetry is the
 *  entire point of the entry. */
const STATUSES_REQUIRING_LIVE_NODES: readonly CapabilityStatus[] = ["live", "partial"];

/** The lowest level at which an entry may reference the model. Nothing above
 *  L4 links into objects, fields or views. */
export const LINK_FLOOR_LEVEL = 4;
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;

/** Severity of the object-coverage gate. Ships as a warning until it runs clean
 *  on a real repository; promotion to `"error"` is a one-line flip here, which
 *  activates an already-written test rather than requiring new authoring under
 *  release pressure (#290 test regime). */
export const OBJECT_COVERAGE_SEVERITY: Severity = "warn";

export type Severity = "error" | "warn";

export interface Diagnostic {
  severity: Severity;
  code: string;
  /** Ledger entry id the diagnostic belongs to, when it has one. */
  id?: string;
  message: string;
}

export const ERR_LEDGER_PARSE = "ERR_LEDGER_PARSE";
export const ERR_LEDGER_SHAPE = "ERR_LEDGER_SHAPE";
export const ERR_LEDGER_DUPLICATE_ID = "ERR_LEDGER_DUPLICATE_ID";
export const ERR_LEDGER_BAD_STATUS = "ERR_LEDGER_BAD_STATUS";
export const ERR_LEDGER_BAD_LEVEL = "ERR_LEDGER_BAD_LEVEL";
export const ERR_LEDGER_LINK_ABOVE_FLOOR = "ERR_LEDGER_LINK_ABOVE_FLOOR";
export const ERR_LEDGER_DANGLING_REF = "ERR_LEDGER_DANGLING_REF";
export const ERR_LEDGER_BAD_PARENT = "ERR_LEDGER_BAD_PARENT";
export const ERR_LEDGER_L5_NOT_MEMBER = "ERR_LEDGER_L5_NOT_MEMBER";
export const ERR_LEDGER_L4_NOT_OBJECT = "ERR_LEDGER_L4_NOT_OBJECT";
export const ERR_LEDGER_ARCH_NO_IMPLEMENTERS = "ERR_LEDGER_ARCH_NO_IMPLEMENTERS";
export const ERR_LEDGER_MISSING_VIOLATION = "ERR_LEDGER_MISSING_VIOLATION";
export const WARN_LEDGER_OBJECT_UNCLAIMED = "WARN_LEDGER_OBJECT_UNCLAIMED";

export interface CapabilityEntry {
  id: string;
  level?: number;
  parent?: string;
  statement?: string;
  violation?: string;
  status?: string;
  implementedBy?: string[];
  verifiedBy?: string[];
  supersededBy?: string;
  notes?: string;
  /** True for entries under the level-less `architectural:` list. */
  architectural: boolean;
}

export interface LoadedLedger {
  present: boolean;
  path: string;
  entries: CapabilityEntry[];
  /** Set when the file exists but could not be parsed into the expected shape. */
  parseError?: string;
}

function asStringArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
  return [];
}

function readList(raw: unknown, architectural: boolean, out: CapabilityEntry[], errs: string[]): void {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) {
    errs.push(`'${architectural ? "architectural" : "capabilities"}' must be a list`);
    return;
  }
  for (const [i, item] of raw.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errs.push(`${architectural ? "architectural" : "capabilities"}[${i}] must be a mapping`);
      continue;
    }
    const rec = item as Record<string, unknown>;
    const id = rec["id"];
    if (typeof id !== "string" || id.length === 0) {
      errs.push(`${architectural ? "architectural" : "capabilities"}[${i}] is missing a string 'id'`);
      continue;
    }
    const entry: CapabilityEntry = { id, architectural };
    if (typeof rec["level"] === "number") entry.level = rec["level"];
    else if (rec["level"] !== undefined) errs.push(`${id}: 'level' must be a number`);
    if (typeof rec["parent"] === "string") entry.parent = rec["parent"];
    if (typeof rec["statement"] === "string") entry.statement = rec["statement"];
    if (typeof rec["violation"] === "string") entry.violation = rec["violation"];
    if (rec["status"] !== undefined) entry.status = String(rec["status"]);
    if (typeof rec["supersededBy"] === "string") entry.supersededBy = rec["supersededBy"];
    if (typeof rec["notes"] === "string") entry.notes = rec["notes"];
    const impl = asStringArray(rec["implementedBy"]);
    if (impl !== undefined) entry.implementedBy = impl;
    const ver = asStringArray(rec["verifiedBy"]);
    if (ver !== undefined) entry.verifiedBy = ver;
    out.push(entry);
  }
}

/**
 * Read + shape-parse the ledger. Returns `present: false` when the file is
 * absent — the ledger is opt-in, so its absence is never a diagnostic.
 *
 * Duplicate YAML keys FAIL. `uniqueKeys` is passed explicitly rather than left
 * to the parser default: a lenient last-wins merge is exactly what silently
 * corrupted a control arm during the investigation that produced this feature,
 * and a default is not a guarantee.
 */
export function loadCapabilityLedger(cwd: string): LoadedLedger {
  const path = join(cwd, LEDGER_PATH);
  if (!existsSync(path)) return { present: false, path, entries: [] };
  let doc: unknown;
  try {
    doc = YAML.parse(readFileSync(path, "utf8"), { uniqueKeys: true });
  } catch (err) {
    return { present: true, path, entries: [], parseError: (err as Error).message };
  }
  if (doc === null || doc === undefined) return { present: true, path, entries: [] };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { present: true, path, entries: [], parseError: "expected a mapping at the document root" };
  }
  const rec = doc as Record<string, unknown>;
  const entries: CapabilityEntry[] = [];
  const errs: string[] = [];
  readList(rec["capabilities"], false, entries, errs);
  readList(rec["architectural"], true, entries, errs);
  const out: LoadedLedger = { present: true, path, entries };
  if (errs.length > 0) out.parseError = errs.join("; ");
  return out;
}

/**
 * Split a member reference into its owning object ref and the dotted member
 * path. The package separator is `::` and qualifies the ROOT-level node only,
 * so the object ref ends at the FIRST `.` after the last `::`.
 * `acme::sales::Order.total.display` -> `["acme::sales::Order", ["total","display"]]`
 */
export function splitMemberRef(ref: string): { owner: string; path: string[] } {
  const pkgEnd = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const searchFrom = pkgEnd === -1 ? 0 : pkgEnd + PACKAGE_SEPARATOR.length;
  const dot = ref.indexOf(".", searchFrom);
  if (dot === -1) return { owner: ref, path: [] };
  return { owner: ref.slice(0, dot), path: ref.slice(dot + 1).split(".") };
}

/** Walk dotted member segments by CHILD NAME from an object node. */
function resolveMember(obj: MetaData, path: string[]): MetaData | undefined {
  let cur: MetaData | undefined = obj;
  for (const seg of path) {
    if (cur === undefined) return undefined;
    cur = cur.children().find((c) => c.name === seg);
  }
  return cur;
}

interface RefOutcome {
  resolved: boolean;
  /** True when the ref pointed at an object (no member path). */
  isObject: boolean;
  /** Resolution key of the owning object, when the object half resolved. */
  ownerKey?: string;
}

function resolveLedgerRef(root: MetaData, ref: string): RefOutcome {
  const { owner, path } = splitMemberRef(ref);
  // referrerPkg is "" — a ledger entry has no package of its own, so a bare ref
  // binds only a root-level object. Fail-closed: it can fail to resolve, never
  // mis-resolve across a package boundary (#244 / ADR-0042).
  const { node } = resolveObjectRef(root, owner, "");
  if (node === undefined) return { resolved: false, isObject: path.length === 0 };
  const ownerKey = node.resolutionKey();
  if (path.length === 0) return { resolved: true, isObject: true, ownerKey };
  return { resolved: resolveMember(node, path) !== undefined, isObject: false, ownerKey };
}

/**
 * Validate the ledger against the loaded model.
 *
 * What a clean run proves: referential integrity — statuses parse, levels are
 * in range, links sit at or below the link floor, and references resolve. What
 * it CANNOT prove: that a status is *true*, or that a node actually implements
 * the capability claiming it. No test can. That truth is the adopter's job.
 */
export function validateCapabilityLedger(ledger: LoadedLedger, root: MetaData): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!ledger.present) return out;
  if (ledger.parseError !== undefined) {
    out.push({ severity: "error", code: ERR_LEDGER_PARSE, message: `${LEDGER_PATH}: ${ledger.parseError}` });
    if (ledger.entries.length === 0) return out;
  }

  const seen = new Set<string>();
  for (const e of ledger.entries) {
    if (seen.has(e.id)) {
      out.push({
        severity: "error", code: ERR_LEDGER_DUPLICATE_ID, id: e.id,
        message: `duplicate capability id '${e.id}'. Ids are permanent and never reused — regrouping edits 'parent' only.`,
      });
      continue;
    }
    seen.add(e.id);
  }

  const claimedObjects = new Set<string>();

  for (const e of ledger.entries) {
    const status = e.status;
    // -- status: closed enum, hard error on an unknown value ------------------
    if (status !== undefined && !(CAPABILITY_STATUSES as readonly string[]).includes(status)) {
      out.push({
        severity: "error", code: ERR_LEDGER_BAD_STATUS, id: e.id,
        message: `unknown status '${status}'. Expected one of: ${CAPABILITY_STATUSES.join(", ")}.`,
      });
    }
    const knownStatus = (CAPABILITY_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as CapabilityStatus)
      : undefined;

    // -- levels ---------------------------------------------------------------
    if (e.architectural) {
      if (e.level !== undefined) {
        out.push({
          severity: "error", code: ERR_LEDGER_BAD_LEVEL, id: e.id,
          message: `architectural entries carry no level. Levels come from object-in-focus decomposition, and an architectural requirement is object-independent.`,
        });
      }
      if (e.parent !== undefined) {
        out.push({
          severity: "error", code: ERR_LEDGER_BAD_PARENT, id: e.id,
          message: `architectural entries carry no parent — they are a flat list.`,
        });
      }
    } else {
      if (e.level === undefined || !Number.isInteger(e.level) || e.level < MIN_LEVEL || e.level > MAX_LEVEL) {
        out.push({
          severity: "error", code: ERR_LEDGER_BAD_LEVEL, id: e.id,
          message: `level must be an integer ${MIN_LEVEL}-${MAX_LEVEL} (got ${String(e.level)}). ` +
            `L1 solution, L2 segment (app/library), L3 service, L4 object, L5 member.`,
        });
      }
      if (e.level !== undefined && e.level > MIN_LEVEL && e.parent === undefined) {
        out.push({
          severity: "error", code: ERR_LEDGER_BAD_PARENT, id: e.id,
          message: `level ${e.level} entry needs a 'parent'; only L${MIN_LEVEL} has none.`,
        });
      }
      if (e.parent !== undefined && !seen.has(e.parent)) {
        out.push({
          severity: "error", code: ERR_LEDGER_BAD_PARENT, id: e.id,
          message: `parent '${e.parent}' is not a capability id in this ledger.`,
        });
      }
    }

    // -- violability is a schema requirement, not a quality lint ---------------
    // The ledger requires the FIELD on anything carrying a status; whether the
    // sentence is a good one is the authoring skill's job. A heuristic here
    // would re-create the "did I find a number" collapse.
    if (status !== undefined && e.violation === undefined) {
      out.push({
        severity: "error", code: ERR_LEDGER_MISSING_VIOLATION, id: e.id,
        message: `an entry with a status must state its 'violation' — what breaking it looks like, in one sentence.`,
      });
    }

    // -- the link boundary ----------------------------------------------------
    const refs = e.implementedBy ?? [];
    if (refs.length > 0 && !e.architectural && (e.level === undefined || e.level < LINK_FLOOR_LEVEL)) {
      out.push({
        severity: "error", code: ERR_LEDGER_LINK_ABOVE_FLOOR, id: e.id,
        message: `'implementedBy' is legal at L${LINK_FLOOR_LEVEL} (object) and L${MAX_LEVEL} (member) only. ` +
          `L1-L3 are organisational and never reference the model — move the links to an L${LINK_FLOOR_LEVEL} child.`,
      });
      continue;
    }

    for (const ref of refs) {
      const outcome = resolveLedgerRef(root, ref);
      if (outcome.resolved && outcome.ownerKey !== undefined) claimedObjects.add(outcome.ownerKey);

      if (!e.architectural && e.level === LINK_FLOOR_LEVEL && !outcome.isObject) {
        out.push({
          severity: "error", code: ERR_LEDGER_L4_NOT_OBJECT, id: e.id,
          message: `L${LINK_FLOOR_LEVEL} references an object; '${ref}' names a member. ` +
            `Move it to an L${MAX_LEVEL} child, or reference the object itself.`,
        });
        continue;
      }
      if (!e.architectural && e.level === MAX_LEVEL && outcome.isObject) {
        out.push({
          severity: "error", code: ERR_LEDGER_L5_NOT_MEMBER, id: e.id,
          message: `L${MAX_LEVEL} references a member (field, view or identity); '${ref}' names an object. ` +
            `Move it to its L${LINK_FLOOR_LEVEL} parent.`,
        });
        continue;
      }

      if (!outcome.resolved) {
        // Severity is CONDITIONAL ON STATUS, and the asymmetry inverts as a pair.
        if (knownStatus === undefined || STATUSES_REQUIRING_LIVE_NODES.includes(knownStatus)) {
          out.push({
            severity: "error", code: ERR_LEDGER_DANGLING_REF, id: e.id,
            message: `'${ref}' does not resolve in the loaded model (status '${status ?? "unset"}' — the model moved and the ledger is stale).` +
              didYouMeanHint(root, ref),
          });
        }
        // abandoned / superseded: the nodes are SUPPOSED to be gone. No diagnostic.
      }
    }

    // -- architectural universality, v1: claim-set arithmetic -----------------
    // An architectural requirement that is live but claimed by nothing is the
    // BaseAuditedEntity case — a policy every entity was supposed to follow and
    // none does, which four independent analyses had to find the hard way.
    // Deliberately NOT a violation-predicate DSL: that would be the registration
    // this ruling forbade, arriving through the back door.
    if (e.architectural && knownStatus !== undefined
        && STATUSES_REQUIRING_LIVE_NODES.includes(knownStatus) && refs.length === 0) {
      out.push({
        severity: "error", code: ERR_LEDGER_ARCH_NO_IMPLEMENTERS, id: e.id,
        message: `architectural requirement is '${status}' but nothing implements it. ` +
          `An architectural requirement's check is universality — a claim set of zero means the policy is declared and unapplied.`,
      });
    }
  }

  // -- object coverage: adding an entity forces a ledger entry -----------------
  // Binary per entity, never a ratio: a "% claimed" number measures what the
  // schema can express, is biased against the hardest rules, and invites
  // optimising the number.
  const entities = root.children().filter((c) => c.type === TYPE_OBJECT && c.subType === OBJECT_SUBTYPE_ENTITY);
  for (const ent of entities) {
    const key = ent.resolutionKey();
    if (!claimedObjects.has(key)) {
      out.push({
        severity: OBJECT_COVERAGE_SEVERITY, code: WARN_LEDGER_OBJECT_UNCLAIMED,
        message: `no capability claims '${key}'. Add it to an L${LINK_FLOOR_LEVEL} entry's 'implementedBy'.`,
      });
    }
  }

  return out;
}
