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
import type { ApiModel, ApiUnitDoc, ApiSymbol, ApiSymbolKind, UnitExample } from "./api-model.js";
import { inlineShape, type FieldShape } from "./api-field-shape.js";
import { docPageHref, type DocPageNode } from "../docs-paths.js";
import type { OutputLayout } from "../import-path.js";
import { GENERATED_HEADER } from "../constants.js";

// Template refs (resolved as `templates/api/<ref-tail>.mustache`).
const ENTITY_PAGE_REF = "api/entity-api.md";
const INDEX_REF = "api/index.md";
const AGENT_REF = "api/agent-api.md";

const GENERATED_MARKER = `<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`;

// ---------------------------------------------------------------------------
// Relative-import RENDER prefix.
//
// An `ApiSymbol.importPath` is the generated module's path RELATIVE TO the
// codegen output dir (flat → `Product.queries`; package → the package-folded
// `acme/shop/Product.queries`). It is the DATA the accuracy gate verifies
// against the emitted file, so it stays a bare module path.
//
// The generated files import each OTHER with `./`-prefixed RELATIVE specifiers
// (`from "./Product"`), so a copy-paste consumer co-located in the generated
// output dir must do the same — a BARE specifier (`from "Product.queries"`)
// only resolves with a non-default `baseUrl` and otherwise fails TS2307. The
// renderers therefore `./`-prefix the importPath in every rendered `from "…"`
// (the human page, the agent group headers, AND the example import blocks),
// without touching the underlying importPath data. A consumer importing from
// elsewhere adjusts the prefix (stated once in the page's import note).
// ---------------------------------------------------------------------------

/** The `./`-prefixed RELATIVE specifier for a documented module path (the form a
 *  co-located consumer copy-pastes). Already-relative paths pass through. */
function relSpecifier(importPath: string): string {
  return importPath.startsWith("./") || importPath.startsWith("../")
    ? importPath
    : `./${importPath}`;
}

/** Rewrite the `from "<module>"` tail of an example `import { … } from "<module>";`
 *  line to the `./`-prefixed relative specifier — the example imports are
 *  pre-composed in the ApiModel (reusing each symbol's bare importPath), so the
 *  `./` prefix is applied at render time alongside the section/header imports. */
function relImportLine(line: string): string {
  return line.replace(/(\bfrom\s+")([^"]+)(")/, (_m, pre, mod, post) => `${pre}${relSpecifier(mod)}${post}`);
}

// The human-facing section ORDER + HEADING per ApiSymbolKind. A unit's page
// renders only the kinds it actually carries, always in this canonical order
// (so two runs over the same model are byte-stable regardless of symbol order).
const KIND_ORDER: readonly ApiSymbolKind[] = [
  "model",
  "relation",
  "data-access",
  "callable",
  "rest",
  "rest-hono",
  "validation",
  "extractor",
  "render",
  "prompt",
];
const KIND_HEADING: Record<ApiSymbolKind, string> = {
  model: "Model",
  relation: "Relations",
  "data-access": "Data access",
  callable: "Callable",
  rest: "REST",
  "rest-hono": "REST (Hono)",
  validation: "Validation",
  extractor: "Extractor",
  render: "Render",
  prompt: "Prompt",
};

/** A docs-page name for the index href helper. The API index lives at the docs
 *  ROOT, so its links to per-unit pages are computed via the same docPageHref
 *  used elsewhere (resolves in flat AND package layout). */
const INDEX_NODE: DocPageNode = { name: "index" };

// ---------------------------------------------------------------------------
// Setup preamble — how to obtain the runtime handles the documented signatures
// need (`db` / `provider` / `root`). This is PROSE (not gate-enforced), so every
// import + type here is grounded in the REAL runtime API:
//   • `db`       — the generated CRUD helpers take `db: Db`, a Drizzle alias
//                  (`NodePgDatabase` / `BaseSQLiteDatabase`, queries-file.ts);
//                  construction is adopter-specific ("pass any compatible
//                  Drizzle instance"), so we show the standard drizzle() call
//                  rather than invent a framework import.
//   • `provider` — render<Name>(payload, provider: Provider); `Provider` +
//                  `InMemoryProvider` are exported from @metaobjectsdev/render.
//   • `root`     — extract<Name>(root: MetaRoot, …); `MetaRoot` is obtained from
//                  the loader shortcuts (`loadDirectory` / `loadString`) on
//                  @metaobjectsdev/metadata, whose LoadResult carries `.root`.
// ---------------------------------------------------------------------------

/** A setup row: the handle name, a one-line description, and a verified snippet.
 *  `snippetInline` is the same snippet flattened to a single line (`; `-joined)
 *  for the token-frugal agent form. */
interface SetupHandleVM {
  handle: string;
  note: string;
  snippet: string;
  snippetInline: string;
}

/** The full set of handles a unit's example may reference. The per-unit page
 *  shows only the handles that unit's example actually uses; the agent + index
 *  forms show the full set once. */
/** Build a setup row, deriving the single-line agent snippet from the block one
 *  (newlines → `; `, collapsing any blank lines / double semicolons). */
function setupHandle(handle: string, note: string, snippet: string): SetupHandleVM {
  const snippetInline = snippet
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.endsWith(";") ? l.slice(0, -1) : l))
    .join("; ");
  return { handle, note, snippet, snippetInline };
}

const SETUP_HANDLES: Record<"db" | "provider" | "root", SetupHandleVM> = {
  db: setupHandle(
    "db",
    "your Drizzle connection — the generated queries take `db: Db` (a `NodePgDatabase` / `BaseSQLiteDatabase` alias). Construct one over your own driver and pass any compatible Drizzle instance:",
    `import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }));`,
  ),
  provider: setupHandle(
    "provider",
    "the render `Provider` (resolves a template ref to text) — import it from `@metaobjectsdev/render`; `InMemoryProvider` is built in (or supply your own filesystem-backed `Provider`):",
    `import { InMemoryProvider } from "@metaobjectsdev/render";
const provider = new InMemoryProvider({ "group/source": "Hello {{name}}" });`,
  ),
  root: setupHandle(
    "root",
    "the loaded `MetaRoot` `extract<Name>` parses against — load your metadata via `@metaobjectsdev/metadata` (the result carries `.root`):",
    `import { loadDirectory } from "@metaobjectsdev/metadata";
const { root } = await loadDirectory("./metadata");`,
  ),
};

/** Which handles a unit's example references (so the page shows only those). */
function setupHandlesFor(unit: ApiUnitDoc): SetupHandleVM[] {
  const text = unit.example ? unit.example.body.join("\n") : "";
  const out: SetupHandleVM[] = [];
  if (/\bdb\b/.test(text)) out.push(SETUP_HANDLES.db);
  if (/\bprovider\b/.test(text)) out.push(SETUP_HANDLES.provider);
  if (/\broot\b/.test(text)) out.push(SETUP_HANDLES.root);
  return out;
}

// ---------------------------------------------------------------------------
// Per-unit HUMAN page.
// ---------------------------------------------------------------------------

interface SectionVM {
  heading: string;
  symbols: SymbolVM[];
}
interface EntityPageVM {
  generatedMarker: string;
  node: string;
  hasSetup: boolean;
  setup: SetupHandleVM[];
  unitExample?: string;
  sections: SectionVM[];
}
interface FieldRowVM {
  field: string;
  type: string;
  required: string;
  notes: string;
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
  /** Present iff the symbol carries a documented field shape — rendered as a
   *  Field / Type / Required / Notes table (mirroring the docs Constraints
   *  table) so a reader sees exactly what fields to pass / expect. */
  hasFields?: boolean;
  /** The field-table rows (one per documented field). */
  fieldRows?: FieldRowVM[];
  /** A short caption above the table naming what the shape is (e.g. "Fields",
   *  "Request body", "Returns"). */
  fieldsCaption?: string;
}

/** A human-page caption for a symbol's field table, by kind + signature shape. */
function fieldsCaptionFor(s: ApiSymbol): string {
  if (s.kind === "model") return "Fields";
  if (s.kind === "validation") return "Accepted fields";
  if (s.kind === "prompt") return "Payload";
  if (s.kind === "extractor") return "Returns";
  if (s.kind === "relation") return "Navigations";
  if (s.kind === "callable") return "Returns";
  if (s.kind === "rest" || s.kind === "rest-hono") {
    return s.name.startsWith("GET ") ? "Response body" : "Request body";
  }
  // data-access: a create/update takes a body; reads return the model.
  return s.name.startsWith("create") || s.name.startsWith("update") ? "Request body (data)" : "Returns";
}

/** Markdown-escape a cell whose text may contain a `|` (TS union types do). */
function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Build the Field / Type / Required / Notes rows from a field shape. */
function fieldRows(fields: FieldShape[]): FieldRowVM[] {
  return fields.map((f) => ({
    field: f.name,
    type: mdCell(f.type),
    required: f.optional ? "" : "yes",
    notes: f.note ?? "",
  }));
}

/** The exact `import { … } from "<importPath>"` an adopter writes for a symbol.
 *  REST endpoints aren't importable functions — the import is the entity's route
 *  registrar (`<entity>Routes`) from the routes module; the symbol's `name` is a
 *  "METHOD /path", not an identifier, so we import the registrar instead. Import
 *  paths are RELATIVE to the adopter's generated-output dir (a note at the top of
 *  the page states this once). */
function importLineFor(s: ApiSymbol): string {
  // REST + Hono endpoints aren't importable functions — import the route
  // registrar named on the symbol instead of the "METHOD /path" name.
  const isRouteKind = s.kind === "rest" || s.kind === "rest-hono";
  const imported = isRouteKind ? s.registrar ?? s.name : s.name;
  return `import { ${imported} } from "${relSpecifier(s.importPath)}"`;
}

/** Group a unit's symbols into ordered sections (one per present kind), each a
 *  list of {signature, usage, import, throws, example}. Empty kinds are omitted. */
function entityPageVM(unit: ApiUnitDoc): EntityPageVM {
  const sections: SectionVM[] = [];
  for (const kind of KIND_ORDER) {
    const ofKind = unit.symbols.filter((s) => s.kind === kind);
    if (ofKind.length === 0) continue;
    sections.push({
      heading: KIND_HEADING[kind],
      symbols: ofKind.map(symbolVM),
    });
  }
  const setup = setupHandlesFor(unit);
  const vm: EntityPageVM = {
    generatedMarker: GENERATED_MARKER,
    node: unit.node,
    hasSetup: setup.length > 0,
    setup,
    sections,
  };
  const ex = unitExampleBlock(unit.example);
  if (ex !== undefined) vm.unitExample = ex;
  return vm;
}

/** The full worked-example block for a unit (imports + body), as one ```ts body
 *  string. Undefined when the unit has no runnable example. */
function unitExampleBlock(example: UnitExample | undefined): string | undefined {
  if (example === undefined) return undefined;
  // The example imports are pre-composed in the ApiModel from the symbols' bare
  // importPaths; `./`-prefix each at render time so the copy-paste block resolves.
  const lines = example.imports.map(relImportLine);
  if (example.imports.length > 0 && example.body.length > 0) lines.push("");
  lines.push(...example.body);
  return lines.join("\n");
}

function symbolVM(s: ApiSymbol): SymbolVM {
  const vm: SymbolVM = { signature: s.signature, usage: s.usage, importLine: importLineFor(s) };
  // REST: tell the agent how to actually wire the endpoints once imported.
  if (s.kind === "rest" && s.registrar !== undefined) {
    vm.mountNote = `\`await ${s.registrar}(fastify)\``;
  }
  // Hono: the registrar mounts onto the Hono app with a per-request deps object.
  if (s.kind === "rest-hono" && s.registrar !== undefined) {
    vm.mountNote = `\`${s.registrar}(app, { db })\``;
  }
  if (s.throws !== undefined) vm.throws = s.throws;
  if (s.example !== undefined) vm.example = s.example;
  // Field shape → a Field / Type / Required / Notes table (only when there is at
  // least one field; a shape with no fields is omitted to keep the page clean).
  if (s.fields !== undefined && s.fields.length > 0) {
    vm.hasFields = true;
    vm.fieldsCaption = fieldsCaptionFor(s);
    vm.fieldRows = fieldRows(s.fields);
  }
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
  relation: "relations",
  "data-access": "data access",
  callable: "callable",
  rest: "REST",
  "rest-hono": "REST (Hono)",
  validation: "validation",
  extractor: "extractor",
  render: "render",
  prompt: "prompt",
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
  /** ONE compact worked example for the unit — the concrete call site an agent
   *  benefits most from. The body statements only (imports are already in the
   *  group headers above). Undefined when the unit has no runnable example. */
  example?: string;
}

/**
 * The agent-form signature WITH the field shape inlined — so an LLM sees exactly
 * what to pass / what it gets, not an opaque `unknown` / `ZodType` / type NAME.
 * Token-frugal but complete. Shaping is per kind:
 *   • model            → `interface <Name> <inlineShape>`;
 *   • data-access      → swap the `data: unknown` param for `data: <inlineShape>`
 *                        (create/update only; reads have no body shape);
 *   • validation       → `<Name>InsertSchema: ZodType<<inlineShape>>`;
 *   • REST             → append ` body: <inlineShape>` (write) / ` -> <inlineShape>`
 *                        (GET response);
 *   • extractor        → append ` // <Payload>: <inlineShape>`.
 * Falls back to the bare signature when the symbol carries no field shape.
 */
function agentSignature(s: ApiSymbol): string {
  if (s.fields === undefined || s.fields.length === 0) return s.signature;
  const shape = inlineShape(s.fields);
  switch (s.kind) {
    case "model":
      return `interface ${s.name} ${shape}`;
    case "data-access":
      // create/update carry a `data: unknown` body param to specialize.
      return s.signature.includes("data: unknown")
        ? s.signature.replace("data: unknown", `data: ${shape}`)
        : s.signature;
    case "validation":
      return s.signature.replace("ZodType", `ZodType<${shape}>`);
    case "rest":
    case "rest-hono":
      return s.name.startsWith("GET ") ? `${s.signature} -> ${shape}` : `${s.signature} body: ${shape}`;
    case "extractor":
    case "prompt":
      return `${s.signature} // ${s.returns ?? "payload"}: ${shape}`;
    case "relation":
      // The navigations ride in the shape; show them inline after the const decl.
      return `const ${s.name} ${shape}`;
    case "callable":
      // Callable returns a typed row array; the model shape isn't its param, so
      // keep the bare signature (its `args` shape is the @parameterRef VO, shown
      // on that VO's own unit).
      return s.signature;
    default:
      return s.signature;
  }
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
    // The identifier an adopter imports: the symbol name, or — for REST / Hono —
    // the shared route registrar (deduped across the entity's endpoints).
    const isRouteKind = s.kind === "rest" || s.kind === "rest-hono";
    const imported = isRouteKind ? s.registrar ?? s.name : s.name;
    if (!g.names.includes(imported)) g.names.push(imported);

    const sym: AgentSymbolVM = { signature: agentSignature(s), usage: s.usage };
    if (s.throws !== undefined) sym.throwsMarker = `[throws: ${s.throws}]`;
    g.symbols.push(sym);
  }

  return order.map((mod) => {
    const g = byModule.get(mod)!;
    return {
      importHeader: `import { ${g.names.join(", ")} } from "${relSpecifier(mod)}"`,
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
    .map((u) => {
      const vm: AgentUnitVM = { node: u.node, groups: agentGroups(u) };
      // The compact agent example: body statements only (the imports are already
      // amortized into the group headers above the example).
      if (u.example !== undefined && u.example.body.length > 0) {
        vm.example = u.example.body.join("\n");
      }
      return vm;
    });
  // The handles ANY unit's example references — shown once at the top so an agent
  // knows where db / provider / root come from before the call sites below.
  const setup = setupHandlesForModel(model);
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
    hasSetup: setup.length > 0,
    setup,
    units,
  };
  return render({ ref: AGENT_REF, payload, provider, format: "markdown" });
}

/** The union of setup handles referenced by ANY unit's example, in canonical
 *  db→provider→root order (shown once at the top of the agent form). */
function setupHandlesForModel(model: ApiModel): SetupHandleVM[] {
  const used = new Set<string>();
  for (const u of model.units) {
    for (const h of setupHandlesFor(u)) used.add(h.handle);
  }
  return (["db", "provider", "root"] as const)
    .filter((h) => used.has(h))
    .map((h) => SETUP_HANDLES[h]);
}
