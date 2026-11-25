// `agent/requirements.md` — the ledger, plus the index that answers the question an agent
// actually asks.
//
// The `requirements` docs surface is REQUIREMENT-KEYED: it lists entries and, under each,
// what the entry claims. That is the right shape for reading a ledger and the wrong shape
// for the question that arises while editing code — *"I am about to change this node; does
// anything claim it?"* Answering that from the requirement-keyed page means reading all of
// it, which for this repository's own ledger is 175 rows.
//
// So this page carries the same index PLUS a NODE index: every claimed node → the
// requirements claiming it, at every grain. It is an inversion of `walkRequirements`, not
// a second walk — the same resolution, read the other way, so the two indexes cannot
// disagree about what resolves.
//
// LITERAL FQNs ON EVERY LINE, deliberately and even where it is repetitive. An agent
// retrieving over a long context finds a node by matching the token it is holding; a row
// that says "the field above" is unreachable to it. This is also why the node index is
// FLAT rather than nested under its owning object.
//
// A CLAIM THAT DOES NOT RESOLVE IS OMITTED, silently, exactly as `walkRequirements` omits
// it. Resolution severity depends on `@status` and belongs to `meta verify`; a docs page
// that rendered a dangling reference as though it pointed somewhere would be asserting
// the opposite of what the gate says.
//
// THE LEDGER IS EMBEDDED BELOW THE INDEX, and that duplication is deliberate rather than
// an oversight — the same content also lives at `requirements.md` when that surface is on.
// The node index alone would omit exactly the entries the mechanism is MEASURED on: a
// `retired` capability may carry no `@implementedBy` at all (FR-039 forbids it), so it
// resolves to no node and appears in no node index. The one controlled finding behind this
// whole vocabulary is that a retired capability goes unnoticed without a ledger — 0 of 24
// against 19 of 40 — and the page an agent is told to read *before adding a capability* is
// the last place to drop it. The cost is bytes on a large estate; the alternative is a page
// that silently loses the only part with evidence behind it.
//
// BUILDER, THEN TEMPLATE. `agentRequirementsPageData` makes every cell and line; the shared
// template `templates/agent/requirements.md.mustache` lays them out, and every port renders
// it from the same data (`fixtures/docs-page-conformance/`). The embedded ledger is the
// `requirements` page's own template rendered in its embedded form, so the two cannot
// disagree.

import { REQUIREMENT_ATTR_STATEMENT } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import type { Provider } from "@metaobjectsdev/render";
import { compareCodeUnits } from "../code-unit-order.js";
import { GENERATED_HEADER } from "../constants.js";
import { concernOf, walkRequirements } from "../requirement-walk.js";
import { frameworkTemplatesProvider } from "../render-engine/framework-provider.js";
import { renderDocPage } from "../render-engine/doc-page.js";
import { requirementRows } from "./requirements-view.js";
import { renderRequirementsMarkdown } from "./requirements-markdown.js";

/** The shared template of `agent/requirements.md`. */
export const AGENT_REQUIREMENTS_PAGE_REF = "agent/requirements.md";

const GENERATED_MARKER = `<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`;

/**
 * The address of any claimed node: the ROOT node's `resolutionKey()` (which carries the
 * effective package), then the child-name path down to it.
 *
 * Built by walking parents rather than read off the node, because only a root-level node
 * has a resolution key — a claimed FIELD has a bare name, and `Subscriber.status` and
 * `Order.status` would collide in this index if the owner were dropped.
 */
function nodeAddress(node: MetaData): string {
  const segments: string[] = [];
  let cur: MetaData | undefined = node;
  while (cur !== undefined) {
    const parent: MetaData | undefined = cur.parent;
    // The last node with a parent is the root-level one; the metadata ROOT itself has no
    // name worth printing, so the walk stops when the next step would leave the model.
    if (parent === undefined || parent.parent === undefined) {
      segments.push(cur.resolutionKey());
      break;
    }
    segments.push(cur.name);
    cur = parent;
  }
  return segments.reverse().join(".");
}

interface NodeIndexEntry {
  readonly address: string;
  readonly concern: string;
  readonly claims: { path: string; subType: string; level: number | undefined; status: string | undefined; statement: string | undefined }[];
}

/** Invert the walk: claimed node → the requirements that claim it. */
export function buildNodeIndex(
  root: MetaData,
  inLedger?: (fqn: string) => boolean,
): NodeIndexEntry[] {
  const byAddress = new Map<string, NodeIndexEntry>();
  for (const walked of walkRequirements(root, inLedger)) {
    const statement = walked.node.attr(REQUIREMENT_ATTR_STATEMENT);
    for (const target of walked.targets) {
      const address = nodeAddress(target.node);
      let entry = byAddress.get(address);
      if (entry === undefined) {
        entry = { address, concern: concernOf(target.node), claims: [] };
        byAddress.set(address, entry);
      }
      entry.claims.push({
        path: walked.view.path,
        subType: walked.view.subType,
        level: walked.view.level,
        status: walked.view.status,
        statement: typeof statement === "string" && statement !== "" ? statement : undefined,
      });
    }
  }
  return [...byAddress.values()].sort((a, b) => compareCodeUnits(a.address, b.address));
}

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Collapse to one line — a statement with a newline in it would end the table row. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** What `agent/requirements.md.mustache` renders. */
export interface AgentRequirementsPageData {
  readonly generatedMarker: string;
  /** False when no requirement resolves to a model node: the page says why instead. */
  readonly hasNodeIndex: boolean;
  /** One row per claimed node; `claims` is the finished cell (`<br>`-joined). */
  readonly nodeIndex: readonly { readonly address: string; readonly concern: string; readonly claims: string }[];
  readonly hasStatements: boolean;
  /** One line per stated requirement in the index, sorted by path; `statement` is one line, `|` escaped. */
  readonly statements: readonly { readonly path: string; readonly subType: string; readonly statement: string }[];
  /** The ledger, rendered by the `requirements` template in its embedded form, with no
   *  trailing line break (the template supplies the page's last one). */
  readonly ledger: string;
}

/** The data the agent requirements template renders. Undefined for a model declaring no
 *  requirements, which gets no page. */
export function agentRequirementsPageData(
  root: MetaData,
  inLedger?: (fqn: string) => boolean,
  provider?: Provider,
): AgentRequirementsPageData | undefined {
  const rows = requirementRows(root, inLedger);
  if (rows.length === 0) return undefined;

  const index = buildNodeIndex(root, inLedger);
  // The statements ride below the table: they are prose, they repeat across nodes a
  // shared architectural entry claims, and putting one in a cell forces the table wide.
  const stated = new Map<string, { subType: string; statement: string }>();
  for (const entry of index) {
    for (const c of entry.claims) {
      if (c.statement !== undefined) stated.set(c.path, { subType: c.subType, statement: c.statement });
    }
  }
  const statements = [...stated.entries()]
    .sort((a, b) => compareCodeUnits(a[0], b[0]))
    .map(([path, { subType, statement }]) => ({ path, subType, statement: mdCell(oneLine(statement)) }));
  return {
    generatedMarker: GENERATED_MARKER,
    hasNodeIndex: index.length > 0,
    nodeIndex: index.map((entry) => ({
      address: entry.address,
      concern: entry.concern,
      claims: entry.claims
        .map((c) => {
          const level = c.level === undefined ? "" : ` L${c.level}`;
          const status = c.status === undefined ? "" : ` (${c.status})`;
          return `\`${c.path}\`${level}${status}`;
        })
        .join("<br>"),
    })),
    hasStatements: statements.length > 0,
    statements,
    // The SAME template the `requirements` surface uses. A second rendering of the ledger
    // would be a second thing to keep true. `embedded` drops its own H1 and demotes every
    // heading one level, so the entries nest under this section instead of escaping it.
    ledger: renderRequirementsMarkdown(rows, { embedded: true, ...(provider !== undefined && { provider }) }).replace(/\n+$/, ""),
  };
}

/**
 * Render the page. Returns "" for a model declaring no requirements — the same contract
 * `requirementsFile()` keeps, and the only reason a surface that is on by default is a
 * no-op for a project without a ledger.
 */
export function renderAgentRequirementsPage(
  root: MetaData,
  inLedger?: (fqn: string) => boolean,
  provider?: Provider,
): string {
  const data = agentRequirementsPageData(root, inLedger, provider);
  if (data === undefined) return "";
  return renderDocPage(
    AGENT_REQUIREMENTS_PAGE_REF,
    data,
    provider ?? frameworkTemplatesProvider,
    "agent/requirements.md",
  );
}
