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
  /** The exact import an adopter writes to call this symbol (e.g.
   *  `import { findProductById } from "Product.queries"`). For REST it's the
   *  route-registrar import + a one-line mount note. */
  importLine: string;
  /** REST-only: the mount one-liner shown under the registrar import. */
  mountNote?: string;
  /** When/why the symbol throws — surfaced as a "Throws:" line. */
  throws?: string;
  example?: string;
}

/** The exact `import { … } from "<importPath>"` an adopter writes for a symbol.
 *  REST endpoints aren't importable functions — the import is the entity's route
 *  registrar (`<entity>Routes`) from the routes module; the symbol's `name` is a
 *  "METHOD /path", not an identifier, so we import the registrar instead. Import
 *  paths are RELATIVE to the adopter's generated-output dir (a note at the top of
 *  the page states this once). */
function importLineFor(s: ApiSymbol): string {
  const imported = s.kind === "rest" ? s.registrar ?? s.name : s.name;
  return `import { ${imported} } from "${s.importPath}"`;
}

/** Group a unit's symbols into ordered sections (one per present kind), each a
 *  list of {signature, usage, import, throws, example}. Empty kinds are omitted. */
function entityPageVM(unit: ApiUnitDoc): {
  generatedMarker: string;
  node: string;
  sections: SectionVM[];
} {
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
  const vm: SymbolVM = { signature: s.signature, usage: s.usage, importLine: importLineFor(s) };
  // REST: tell the agent how to actually wire the endpoints once imported.
  if (s.kind === "rest" && s.registrar !== undefined) {
    vm.mountNote = `\`await ${s.registrar}(fastify)\``;
  }
  if (s.throws !== undefined) vm.throws = s.throws;
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

interface AgentSymbolVM {
  signature: string;
  usage: string;
  /** Compact `[throws: …]` marker appended after the usage, when the symbol
   *  throws — so an agent knows the failure mode without a prose page. */
  throwsMarker?: string;
}
interface AgentGroupVM {
  /** One `import { a, b, c } from "<module>"` header covering every symbol below
   *  it — the exact import for each, in a single token-frugal line. */
  importHeader: string;
  symbols: AgentSymbolVM[];
}
interface AgentUnitVM {
  node: string;
  groups: AgentGroupVM[];
}

/** Group a unit's symbols by their import MODULE (first-appearance order),
 *  emitting ONE `import { … } from "<module>"` header per module then the
 *  symbols under it. This is the token-frugal form that still tells the agent the
 *  exact import for EVERY symbol (one header amortized over N symbols, vs. an
 *  import line per symbol). REST endpoints aren't importable identifiers — they
 *  collapse under their entity's single route-registrar import (the registrar is
 *  the imported name; the endpoints list the verbs/paths it mounts). */
function agentGroups(unit: ApiUnitDoc): AgentGroupVM[] {
  const order: string[] = [];
  const byModule = new Map<string, { names: string[]; symbols: AgentSymbolVM[] }>();

  for (const s of unit.symbols) {
    let g = byModule.get(s.importPath);
    if (!g) {
      g = { names: [], symbols: [] };
      byModule.set(s.importPath, g);
      order.push(s.importPath);
    }
    // The identifier an adopter imports: the symbol name, or — for REST — the
    // shared route registrar (deduped across the entity's endpoints).
    const imported = s.kind === "rest" ? s.registrar ?? s.name : s.name;
    if (!g.names.includes(imported)) g.names.push(imported);

    const sym: AgentSymbolVM = { signature: s.signature, usage: s.usage };
    if (s.throws !== undefined) sym.throwsMarker = `[throws: ${s.throws}]`;
    g.symbols.push(sym);
  }

  return order.map((mod) => {
    const g = byModule.get(mod)!;
    return {
      importHeader: `import { ${g.names.join(", ")} } from "${mod}"`,
      symbols: g.symbols,
    };
  });
}

/** Render the condensed agent/LLM form: per unit, symbols grouped under a single
 *  `import { … } from "<module>"` header then one compact `signature — usage`
 *  line each (with a `[throws: …]` marker when it throws), NO prose/examples
 *  (token budget). Units keep their ApiModel order; symbols keep their per-unit
 *  order (the canonical generator emission order). */
export function renderAgentApi(model: ApiModel, provider: Provider): string {
  const units: AgentUnitVM[] = model.units
    .filter((u) => u.symbols.length > 0)
    .map((u) => ({ node: u.node, groups: agentGroups(u) }));
  const payload = {
    generatedMarker: GENERATED_MARKER,
    title: "Agent API Reference",
    // The ApiModel carries no package itself, so the model-only entry point uses
    // a generic, self-contained project label. (A richer label off the loaded
    // root's package can be layered in by the Task-3 emission entrypoint, which
    // has the root.)
    project: "this project",
    // Import paths are RELATIVE to the adopter's generated-output dir.
    importNote: "Imports are relative to your generated-output directory.",
    units,
  };
  return render({ ref: AGENT_REF, payload, provider, format: "markdown" });
}
