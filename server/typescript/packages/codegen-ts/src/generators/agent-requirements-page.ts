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

import { REQUIREMENT_ATTR_STATEMENT } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { GENERATED_HEADER } from "../constants.js";
import { walkRequirements } from "../requirement-walk.js";
import { requirementRows } from "./requirements-view.js";
import { renderRequirementsMarkdown } from "./requirements-markdown.js";

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

/** `type.subType` of the claimed node — an agent needs to know what KIND of thing it is. */
function concernOf(node: MetaData): string {
  return `${node.type}.${node.subType}`;
}

interface NodeIndexEntry {
  readonly address: string;
  readonly concern: string;
  readonly claims: { path: string; subType: string; level: number | undefined; status: string | undefined; statement: string | undefined }[];
}

/** Invert the walk: claimed node → the requirements that claim it. */
export function buildNodeIndex(root: MetaData): NodeIndexEntry[] {
  const byAddress = new Map<string, NodeIndexEntry>();
  for (const walked of walkRequirements(root)) {
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
  return [...byAddress.values()].sort((a, b) => a.address.localeCompare(b.address));
}

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Collapse to one line — a statement with a newline in it would end the table row. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render the page. Returns "" for a model declaring no requirements — the same contract
 * `requirementsFile()` keeps, and the only reason a surface that is on by default is a
 * no-op for a project without a ledger.
 */
export function renderAgentRequirementsPage(root: MetaData): string {
  const rows = requirementRows(root);
  if (rows.length === 0) return "";

  const index = buildNodeIndex(root);
  const out: string[] = [];
  out.push(GENERATED_MARKER);
  out.push("");
  out.push("# Requirements");
  out.push("");
  out.push(
    "Read this before adding a capability, and before extending anything that looks like " +
      "it already does what you were asked for.",
  );
  out.push("");
  out.push(
    "- A requirement is **prescriptive**: it states what should be true, never what " +
      "happened. `status: retired` means the capability was BUILT and deliberately " +
      "REMOVED — that entry is a prohibition, not history, and the right response to it " +
      "is to stop, not to rebuild.",
  );
  out.push(
    "- The **node index** below answers *\"does anything claim the thing I am about to " +
      "change?\"*. Match the literal FQN.",
  );
  out.push(
    "- **The ledger under it is not the same list.** A retired capability carries no " +
      "`@implementedBy` — there is nothing left to point at — so it appears there and " +
      "in no index. Read it before you conclude a capability does not exist yet.",
  );
  out.push("");

  if (index.length > 0) {
    out.push("## Node index");
    out.push("");
    out.push("| Node | Kind | Claimed by |");
    out.push("|---|---|---|");
    for (const entry of index) {
      const claims = entry.claims
        .map((c) => {
          const level = c.level === undefined ? "" : ` L${c.level}`;
          const status = c.status === undefined ? "" : ` (${c.status})`;
          return `\`${c.path}\`${level}${status}`;
        })
        .join("<br>");
      out.push(`| \`${entry.address}\` | \`${entry.concern}\` | ${claims} |`);
    }
    out.push("");
    // The statements ride below the table: they are prose, they repeat across nodes a
    // shared architectural entry claims, and putting one in a cell forces the table wide.
    const stated = new Map<string, { subType: string; statement: string }>();
    for (const entry of index) {
      for (const c of entry.claims) {
        if (c.statement !== undefined) stated.set(c.path, { subType: c.subType, statement: c.statement });
      }
    }
    if (stated.size > 0) {
      out.push("### What those requirements say");
      out.push("");
      for (const [path, { subType, statement }] of [...stated.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        out.push(`- \`${path}\` (\`${subType}\`) — ${mdCell(oneLine(statement))}`);
      }
      out.push("");
    }
  } else {
    out.push("## Node index");
    out.push("");
    out.push(
      "No requirement resolves to a model node. Every entry sits above the " +
        "`@implementedBy` link floor (L4), or its claims do not resolve — `meta verify` " +
        "is what says which.",
    );
    out.push("");
  }

  out.push("## The ledger");
  out.push("");
  // The SAME renderer the `requirements` surface uses. A second rendering of the ledger
  // would be a second thing to keep true. `embedded` drops its own H1 and demotes every
  // heading one level, so the entries nest under this section instead of escaping it.
  out.push(renderRequirementsMarkdown(rows, { embedded: true }).replace(/\n+$/, ""));

  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
