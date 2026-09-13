// `meta gen --list` — the LIBRARY rows (FR-043 §4).
//
// It is the codegen catalog, with `kind: "library"` rows in the same table rather than
// a parallel one: one door, one namespace, one `--probe`, one skill procedure. An agent
// about to model "users and permissions" should meet `iam` in the list it was already
// reading, not in a second command it has to know exists.
//
// THE ROW DESCRIBES THE BOX; THE PROJECT BLOCK DESCRIBES YOUR SHELF. `provides` counts
// what the library ships across ALL its layers — what you would get if you took every
// layer — while `project.tablesAdded` counts what YOUR selection actually put into the
// model. Those are different numbers whenever an adopter takes the core layer alone,
// which Amendment 1 makes the common case: `libraries: ["iam"]` provides nine entities
// and adds zero tables.
//
// Every fact here is COMPUTED — from the manifest, or by loading the library and
// counting. Nothing is a second copy of a sentence written somewhere else, which is the
// rule §4 states as "every manifest fact is resolved, not trusted".
import {
  MetaDataLoader,
  TYPE_OBJECT,
  TYPE_REQUIREMENT,
  OBJECT_SUBTYPE_ENTITY,
  isWritableSource,
  type MetaData,
} from "@metaobjectsdev/metadata";
import {
  libraryManifests,
  librarySources,
  knownLibraryTokens,
  splitLayerToken,
  type LibraryManifest,
} from "@metaobjectsdev/metadata/library";
import { SERVER_LANGS } from "@metaobjectsdev/sdk";

/** One `--list` row for a shipped library. */
export interface LibraryCatalogRow {
  name: string;
  kind: "library";
  /** The manifest's own `kind` — what SORT of library this is (`feature`, `nfr`). A
   *  second axis from the row's `kind`, which is the catalog discriminator. */
  libraryKind: string;
  stability: string;
  /** The language ports this library is reachable from. Every port embeds the whole
   *  `library/` tree from one generator script, so this is all of them — and a test
   *  resolves that against each port's embedded module rather than trusting it. */
  ports: readonly string[];
  description: string;
  useWhen?: string;
  packages: readonly string[];
  /** Selection tokens, core first — `["iam", "iam/db"]`. The bare name IS the core
   *  layer, and a layer token implies it. This is the field an adopter acts on: under
   *  Amendment 1 you do not opt into a library, you opt into its layers. */
  layers: ReadonlyArray<{ token: string; description?: string }>;
  /** What is in the box, across every layer. */
  provides: {
    entities: number;
    abstracts: number;
    requirements: number;
    generators: readonly string[];
  };
  project?: LibraryProjectFacts;
}

export interface LibraryProjectFacts {
  /** Does this project's `libraries` name this library at all? */
  optedIn: boolean;
  /** The tokens this project selected, in config order. Empty when not opted in. */
  selectedLayers: readonly string[];
  /** Project entities whose `extends` chain reaches a node this library owns — the
   *  adoption that opting out would break. `null` unless the model was loaded. */
  extendedBy: readonly string[] | null;
  /** Tables this library's SELECTED layers contribute to the loaded model. Zero for a
   *  core-only selection, which is the inertness promise expressed as a number. */
  tablesAdded: number | null;
  /** Requirement entries the library put into this project's ledger. */
  requirementsAdded: number | null;
  /** Generators the manifest says this library implies, which this project has not
   *  wired. Not an error: the library is metadata, and wiring is the adopter's call. */
  impliedGeneratorsNotWired: readonly string[];
}

/** What a `--list` caller knows about the project, for the library rows. */
export interface LibraryProjectContext {
  /** The project's `libraries` selection, verbatim. */
  libraries: readonly string[];
  /** Stable names wired in `generators: [...]`. */
  wiredNames: ReadonlySet<string>;
  /** The loaded model, when one was loaded (`--probe`). */
  metadata?: MetaData;
}

/** Every selection token belonging to one library, core first. */
function tokensOf(name: string): string[] {
  return knownLibraryTokens().filter((t) => splitLayerToken(t)[0] === name);
}

/** Walk every node, since a requirement nests to any depth and an object does not. */
function walk(node: MetaData, visit: (n: MetaData) => void): void {
  for (const child of node.children()) {
    visit(child);
    walk(child, visit);
  }
}

function effectivePackage(node: MetaData): string {
  return node.package ?? node.fileDefaultPackage ?? "";
}

/**
 * Load one library with ALL of its layers and count what it ships.
 *
 * The FULL selection, not the core: `provides` answers "what is in this library",
 * and an adopter reading it is deciding whether to opt in at all. What their current
 * selection actually added is the project block's job.
 */
async function providesOf(name: string, manifest: LibraryManifest): Promise<LibraryCatalogRow["provides"]> {
  const result = await new MetaDataLoader({ strict: true }).load(librarySources(tokensOf(name)));
  let entities = 0;
  let abstracts = 0;
  let requirements = 0;
  walk(result.root, (n) => {
    if (n.type === TYPE_REQUIREMENT) requirements++;
    else if (n.type === TYPE_OBJECT && n.subType === OBJECT_SUBTYPE_ENTITY) {
      if (n.isAbstract) abstracts++;
      else entities++;
    }
  });
  return {
    entities,
    abstracts,
    requirements,
    generators: (manifest.generators ?? []).map((g) => g.name),
  };
}

/**
 * The project facts for one library.
 *
 * `extendedBy` and the two counts read the LOADED model rather than the library,
 * because that is the question being answered: not "what does iam contain" but "what
 * is iam doing in this repo". Without `--probe` there is no model and they are null —
 * never zero, which would read as "nothing", the opposite of "not measured".
 */
function projectFactsFor(
  manifest: LibraryManifest,
  ctx: LibraryProjectContext,
): LibraryProjectFacts {
  const name = manifest.name;
  const selectedLayers = ctx.libraries.filter((t) => splitLayerToken(t)[0] === name);
  const impliedGeneratorsNotWired = (manifest.generators ?? [])
    .map((g) => g.name)
    .filter((g) => !ctx.wiredNames.has(g));

  const facts: LibraryProjectFacts = {
    optedIn: selectedLayers.length > 0,
    selectedLayers,
    extendedBy: null,
    tablesAdded: null,
    requirementsAdded: null,
    impliedGeneratorsNotWired,
  };
  if (ctx.metadata === undefined) return facts;

  const owned = new Set(manifest.packages ?? []);
  const extendedBy: string[] = [];
  let tablesAdded = 0;
  let requirementsAdded = 0;
  walk(ctx.metadata, (n) => {
    const mine = owned.has(effectivePackage(n));
    if (n.type === TYPE_REQUIREMENT && mine) requirementsAdded++;
    if (n.type !== TYPE_OBJECT) return;
    if (mine) {
      // A writable source is what migrate keys a CREATE TABLE off (#248 —
      // persistability derives from source presence, never from the subtype), so
      // counting them here and counting tables there cannot drift apart.
      if (n.children().some(isWritableSource)) tablesAdded++;
      return;
    }
    // A project entity reaching this library through `extends`, at any depth: the
    // adoption an adopter would break by removing the library from `libraries`.
    for (let sup = n.superData; sup !== undefined; sup = sup.superData) {
      if (owned.has(effectivePackage(sup))) {
        extendedBy.push(`${effectivePackage(n)}::${n.name}`);
        return;
      }
    }
  });

  facts.extendedBy = extendedBy.sort();
  facts.tablesAdded = tablesAdded;
  facts.requirementsAdded = requirementsAdded;
  return facts;
}

/** Every shipped library, as `--list` rows, in name order. */
export async function buildLibraryRows(
  ctx?: LibraryProjectContext,
): Promise<LibraryCatalogRow[]> {
  const rows: LibraryCatalogRow[] = [];
  for (const [name, manifest] of Object.entries(libraryManifests()).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const layers = tokensOf(name).map((token) => {
      const layer = (manifest.layers ?? {})[splitLayerToken(token)[1]];
      return layer?.description === undefined
        ? { token }
        : { token, description: layer.description };
    });
    rows.push({
      name,
      kind: "library",
      libraryKind: manifest.kind ?? "feature",
      stability: manifest.stability ?? "preview",
      ports: SERVER_LANGS,
      description: manifest.description ?? "",
      ...(manifest.useWhen !== undefined ? { useWhen: manifest.useWhen } : {}),
      packages: manifest.packages ?? [],
      layers,
      provides: await providesOf(name, manifest),
      ...(ctx === undefined ? {} : { project: projectFactsFor(manifest, ctx) }),
    });
  }
  return rows;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The human rendering — one section, after the generator layers. */
export function renderLibraryText(rows: readonly LibraryCatalogRow[]): string[] {
  if (rows.length === 0) return [];
  const lines: string[] = [];
  lines.push("");
  lines.push("libraries  —  declared design you opt into, a LAYER at a time; the core layer adds no tables");
  for (const r of rows) {
    const marks: string[] = [r.stability];
    if (r.project?.optedIn) marks.push(`opted in: ${r.project.selectedLayers.join(", ")}`);
    if (r.project?.tablesAdded) marks.push(`${plural(r.project.tablesAdded, "table", "tables")} added`);
    lines.push(`  ${r.name}  —  ${r.description}  [${marks.join(", ")}]`);
    if (r.useWhen !== undefined) lines.push(`      use when: ${r.useWhen}`);
    lines.push(
      `      provides: ${plural(r.provides.entities, "entity", "entities")}, ` +
        `${r.provides.abstracts} abstract, ` +
        `${plural(r.provides.requirements, "requirement", "requirements")}`,
    );
    lines.push(`      layers:   ${r.layers.map((l) => l.token).join(", ")}`);
    if (r.project !== null && r.project?.impliedGeneratorsNotWired.length) {
      lines.push(
        `      implies:  ${r.project.impliedGeneratorsNotWired.join(", ")} (not wired)`,
      );
    }
  }
  lines.push("");
  lines.push('Opt in with `"libraries": ["iam", "iam/db"]` in .metaobjects/config.json —');
  lines.push("the bare name is the core layer, and a layer token implies it.");
  return lines;
}
