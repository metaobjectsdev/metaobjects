// api-doc-render.ts — the two documentation FORMS that an ApiModel feeds:
//   • a per-unit HUMAN reference page  (renderEntityApiPage)
//   • a consolidated HUMAN index       (renderApiIndex)
//   • a condensed AGENT/LLM form        (renderAgentApi)
//
// ADR-0022 Part 3: one ApiModel, two forms — the human prose page and the
// token-frugal agent form derive from the SAME IR, never re-derived. Rendering
// goes through the SHARED `render()` Mustache engine against canonical templates
// under `templates/api/` (resolved via the framework/project provider chain —
// the same mechanism docs-file.ts uses), so adopters can override a template by
// dropping their own `templates/api/<ref>.mustache` into their project root.
//
// The view-models are pre-rendered here (mirroring docs-data-builder) so the
// Mustache templates stay logic-light: section grouping, symbol counts, and the
// collision-safe index hrefs (docPageHref) are computed in TS.

import { render } from "@metaobjectsdev/render";
import type { Provider } from "@metaobjectsdev/render";
import type { ApiModel, ApiUnitDoc, ApiSymbol, ApiSymbolKind } from "./api-model.js";
import { docPageHref, type DocPageNode } from "../docs-paths.js";
import type { OutputLayout } from "../import-path.js";
import { GENERATED_HEADER } from "../constants.js";

// Template refs (resolved as `templates/api/<ref-tail>.mustache`).
const ENTITY_PAGE_REF = "api/entity-api.md";
const INDEX_REF = "api/index.md";
const AGENT_REF = "api/agent-api.md";

const GENERATED_MARKER = `<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`;

// The human-facing section ORDER + HEADING per ApiSymbolKind. A unit's page
// renders only the kinds it actually carries, always in this canonical order
// (so two runs over the same model are byte-stable regardless of symbol order).
const KIND_ORDER: readonly ApiSymbolKind[] = [
  "model",
  "data-access",
  "rest",
  "validation",
  "extractor",
  "render",
];
const KIND_HEADING: Record<ApiSymbolKind, string> = {
  model: "Model",
  "data-access": "Data access",
  rest: "REST",
  validation: "Validation",
  extractor: "Extractor",
  render: "Render",
};

/** A docs-page name for the index href helper. The API index lives at the docs
 *  ROOT, so its links to per-unit pages are computed via the same docPageHref
 *  used elsewhere (resolves in flat AND package layout). */
const INDEX_NODE: DocPageNode = { name: "index" };

// ---------------------------------------------------------------------------
// Per-unit HUMAN page.
// ---------------------------------------------------------------------------

interface SectionVM {
  heading: string;
  symbols: SymbolVM[];
}
interface SymbolVM {
  signature: string;
  usage: string;
  example?: string;
}

/** Group a unit's symbols into ordered sections (one per present kind), each a
 *  list of {signature, usage, example}. Empty kinds are omitted. */
function entityPageVM(unit: ApiUnitDoc): { generatedMarker: string; node: string; sections: SectionVM[] } {
  const sections: SectionVM[] = [];
  for (const kind of KIND_ORDER) {
    const ofKind = unit.symbols.filter((s) => s.kind === kind);
    if (ofKind.length === 0) continue;
    sections.push({
      heading: KIND_HEADING[kind],
      symbols: ofKind.map(symbolVM),
    });
  }
  return { generatedMarker: GENERATED_MARKER, node: unit.node, sections };
}

function symbolVM(s: ApiSymbol): SymbolVM {
  const vm: SymbolVM = { signature: s.signature, usage: s.usage };
  if (s.example !== undefined) vm.example = s.example;
  return vm;
}

/** Render ONE per-unit human reference page from an ApiUnitDoc, via the shared
 *  render() engine + the canonical `api/entity-api.md` template. */
export function renderEntityApiPage(unit: ApiUnitDoc, provider: Provider): string {
  return render({
    ref: ENTITY_PAGE_REF,
    payload: entityPageVM(unit),
    provider,
    format: "markdown",
  });
}

// ---------------------------------------------------------------------------
// Consolidated HUMAN index.
// ---------------------------------------------------------------------------

interface IndexRowVM {
  node: string;
  href: string;
  summary: string;
  symbolCount: number;
  one: boolean;
}

/** Lowercase summary label per kind (keeps the proper-noun acronym "REST"
 *  intact rather than ".toLowerCase()"-ing it to "rest"). */
const KIND_SUMMARY_LABEL: Record<ApiSymbolKind, string> = {
  model: "model",
  "data-access": "data access",
  rest: "REST",
  validation: "validation",
  extractor: "extractor",
  render: "render",
};

/** A one-line summary for a unit's index row: the count of each present kind,
 *  in canonical order (e.g. "model, 5 data access, 5 REST, 2 validation"). */
function unitSummary(unit: ApiUnitDoc): string {
  const parts: string[] = [];
  for (const kind of KIND_ORDER) {
    const n = unit.symbols.filter((s) => s.kind === kind).length;
    if (n === 0) continue;
    const label = KIND_SUMMARY_LABEL[kind];
    parts.push(n === 1 ? label : `${n} ${label}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no public symbols";
}

function indexRow(layout: OutputLayout, unit: ApiUnitDoc): IndexRowVM {
  // The per-unit page is placed by {name, effective package} (see Task-3
  // emission); link to it via the same docPageHref used for doc pages so it
  // resolves in BOTH layouts — flat (`./Product.md`) and package
  // (`./acme/shop/Product.md`), folding under the package path.
  const href = docPageHref(layout, INDEX_NODE, { name: unit.node, package: unit.package });
  return {
    node: unit.node,
    href,
    summary: unitSummary(unit),
    symbolCount: unit.symbols.length,
    one: unit.symbols.length === 1,
  };
}

/** Render the consolidated human API index (links to each unit page, grouped
 *  entity vs template) via the shared render() engine + `api/index.md`. */
export function renderApiIndex(model: ApiModel, layout: OutputLayout, provider: Provider): string {
  const byName = (a: ApiUnitDoc, b: ApiUnitDoc) => a.node.localeCompare(b.node);
  const entities = model.units.filter((u) => u.nodeKind === "entity").sort(byName);
  const templates = model.units.filter((u) => u.nodeKind === "template").sort(byName);

  const payload = {
    generatedMarker: GENERATED_MARKER,
    title: "API Reference",
    intro: "Generated public API surface, one page per entity and output template.",
    hasEntities: entities.length > 0,
    entities: entities.map((u) => indexRow(layout, u)),
    hasTemplates: templates.length > 0,
    templates: templates.map((u) => indexRow(layout, u)),
  };
  return render({ ref: INDEX_REF, payload, provider, format: "markdown" });
}

// ---------------------------------------------------------------------------
// Condensed AGENT/LLM form.
// ---------------------------------------------------------------------------

interface AgentUnitVM {
  node: string;
  symbols: { signature: string; usage: string }[];
}

/** Render the condensed agent/LLM form: one compact `signature — usage` line per
 *  symbol, grouped by unit, NO prose/examples (token budget). Units keep their
 *  ApiModel order; symbols keep their per-unit order (the canonical generator
 *  emission order). */
export function renderAgentApi(model: ApiModel, provider: Provider): string {
  const units: AgentUnitVM[] = model.units
    .filter((u) => u.symbols.length > 0)
    .map((u) => ({
      node: u.node,
      symbols: u.symbols.map((s) => ({ signature: s.signature, usage: s.usage })),
    }));
  const payload = {
    generatedMarker: GENERATED_MARKER,
    title: "Agent API Reference",
    // The ApiModel carries no package itself, so the model-only entry point uses
    // a generic, self-contained project label. (A richer label off the loaded
    // root's package can be layered in by the Task-3 emission entrypoint, which
    // has the root.)
    project: "this project",
    units,
  };
  return render({ ref: AGENT_REF, payload, provider, format: "markdown" });
}
