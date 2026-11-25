/**
 * Independent packs (ADR-0069): what scripts/ knows about `packs/<name>/`.
 *
 * A pack directory is the monorepo spelling of a separate repository. Its manifest,
 * `pack.json`, is the pack's one statement about itself; every check in this file reads
 * it, and none of core's release tooling does. This module is repo tooling, not product:
 * core packages never import it (scripts/check-pack-boundary.ts holds that line).
 *
 * The vocabulary half answers the two conformance questions a pack's TypeScript port is
 * held to: which manifest rows the pack ADDS when composed onto the default bundle (its
 * pinned vocabulary, packs/<name>/fixtures/expected-vocabulary.json), and whether it
 * leaves every row the bundle already had byte-identical ("leaves core alone").
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildRegistryManifest,
  composeRegistry,
  coreProviders,
  type MetaDataTypeProvider,
} from "../../server/typescript/packages/metadata/src/index.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PACKS_DIR = "packs";
export const PACK_MANIFEST = "pack.json";
export const PACK_VOCABULARY = "fixtures/expected-vocabulary.json";
export const PACK_CORPUS = "fixtures/conformance";

/** The port directories a pack may carry, by the name `pack.json` gives each. */
export const PACK_PORTS = ["typescript", "java", "kotlin", "csharp", "python", "rust"] as const;
export type PackPort = (typeof PACK_PORTS)[number];

/** The stability words docs/features/stability-labels.md defines. */
export const PACK_STABILITIES = ["experimental", "preview", "stable"] as const;

export interface PackPortEntry {
  /** The registry coordinate: npm name, Maven `group:artifact`, PyPI / NuGet / crate name. */
  readonly package: string;
  /** The range of core this port's artifact accepts, in that registry's own syntax. */
  readonly core: string;
  /** False while the pack is consumed only through the private prerelease registry. */
  readonly publish: boolean;
}

export interface PackManifest {
  readonly id: string;
  readonly version: string;
  readonly stability: string;
  readonly description?: string;
  readonly requires: {
    /** The metamodel (`metamodelVersion`) range the pack's vocabulary is written against. */
    readonly metamodel: string;
    /** Other packs this one depends on: pack id -> version range. */
    readonly packs: Readonly<Record<string, string>>;
  };
  readonly ports: Readonly<Partial<Record<PackPort, PackPortEntry>>>;
}

/** `metaobjects-<name>`: the provider id every pack registers under. */
export function packProviderId(name: string): string {
  return `metaobjects-${name}`;
}

/** The npm name of a pack's TypeScript port. */
export function packNpmName(name: string): string {
  return `@metaobjectsdev/pack-${name}`;
}

/** `MetaObjects.Packs.<Name>`, with the kebab-case name in PascalCase. */
export function packNuGetName(name: string): string {
  const pascal = name.split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
  return `MetaObjects.Packs.${pascal}`;
}

/**
 * The registry coordinate each port's artifact must carry (ADR-0069, "Names").
 * Kotlin shares Java's Maven namespace; the suffix that tells its artifact apart is
 * left to the first pack that ships a Kotlin port, so only the prefix is fixed here.
 */
export function packageMatches(port: PackPort, name: string, actual: string): boolean {
  if (port === "kotlin") return actual.startsWith(`com.metaobjects.packs:${name}-`);
  return actual === expectedPackage(port, name);
}

export function expectedPackage(port: PackPort, name: string): string {
  switch (port) {
    case "typescript":
      return packNpmName(name);
    case "java":
      return `com.metaobjects.packs:${name}`;
    case "kotlin":
      return `com.metaobjects.packs:${name}-<suffix>`;
    case "csharp":
      return packNuGetName(name);
    case "python":
    case "rust":
      return `metaobjects-pack-${name}`;
  }
}

/** Every directory under `<root>/packs/`, sorted. A directory without pack.json is still listed. */
export function listPackDirs(root: string = REPO_ROOT): string[] {
  const dir = join(root, PACKS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && statSync(join(dir, n)).isDirectory())
    .sort();
}

export function packDir(name: string, root: string = REPO_ROOT): string {
  return join(root, PACKS_DIR, name);
}

/** Parse `packs/<name>/pack.json` without validating it (scripts/check-pack-manifests.ts does). */
export function readPackManifest(name: string, root: string = REPO_ROOT): PackManifest {
  return JSON.parse(readFileSync(join(packDir(name, root), PACK_MANIFEST), "utf8")) as PackManifest;
}

/** Pack names by provider id, for every pack that has a readable manifest. */
export function packsById(root: string = REPO_ROOT): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of listPackDirs(root)) {
    try {
      out.set(readPackManifest(name, root).id, name);
    } catch {
      // An unreadable manifest is check-pack-manifests' finding, not this lookup's.
    }
  }
  return out;
}

/** The file a pack's TypeScript package resolves to under the `bun` condition. */
export function packEntryFile(name: string, root: string = REPO_ROOT): string {
  const pkgDir = join(packDir(name, root), "typescript");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    exports?: Record<string, { bun?: string; default?: string } | string>;
    main?: string;
  };
  const dot = pkg.exports?.["."];
  const rel = typeof dot === "string" ? dot : (dot?.bun ?? dot?.default ?? pkg.main);
  if (rel === undefined) throw new Error(`${packNpmName(name)}: package.json names no entry point`);
  return join(pkgDir, rel);
}

function isProvider(v: unknown): v is MetaDataTypeProvider {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as { id?: unknown }).id === "string" &&
    typeof (v as { registerTypes?: unknown }).registerTypes === "function"
  );
}

/** Import one pack's TypeScript entry and return its exported `provider`. */
export async function loadPackProvider(name: string, root: string = REPO_ROOT): Promise<MetaDataTypeProvider> {
  const mod = (await import(pathToFileURL(packEntryFile(name, root)).href)) as { provider?: unknown };
  if (!isProvider(mod.provider)) {
    throw new Error(`${packNpmName(name)}: the entry point must export \`provider\`, a MetaDataTypeProvider`);
  }
  const id = readPackManifest(name, root).id;
  if (mod.provider.id !== id) {
    throw new Error(`${packNpmName(name)}: the exported provider's id is "${mod.provider.id}", pack.json says "${id}"`);
  }
  return mod.provider;
}

/**
 * The providers a pack needs, in dependency order: the packs it requires (transitively)
 * and then the pack itself. Throws on a required pack that is not in this repository.
 */
export async function loadPackClosure(name: string, root: string = REPO_ROOT): Promise<MetaDataTypeProvider[]> {
  const byId = packsById(root);
  const out: MetaDataTypeProvider[] = [];
  const seen = new Set<string>();
  async function visit(n: string, chain: readonly string[]): Promise<void> {
    if (chain.includes(n)) throw new Error(`pack dependency cycle: ${[...chain, n].join(" -> ")}`);
    if (seen.has(n)) return;
    for (const dep of Object.keys(readPackManifest(n, root).requires?.packs ?? {})) {
      const depName = byId.get(dep);
      if (depName === undefined) throw new Error(`pack ${n} requires "${dep}", which is not a pack in ${PACKS_DIR}/`);
      await visit(depName, [...chain, n]);
    }
    seen.add(n);
    out.push(await loadPackProvider(n, root));
  }
  await visit(name, []);
  return out;
}

// ── vocabulary: rows, the pin, and "leaves core alone" ───────────────────────

type Manifest = ReturnType<typeof buildRegistryManifest>;
type ManifestType = Manifest["types"][number];
type ManifestAttr = ManifestType["attrs"][number];
type ManifestChild = ManifestType["children"][number];

const childKey = (c: ManifestChild): string =>
  `${c.childType}.${Array.isArray(c.childSubType) ? c.childSubType.join(",") : c.childSubType}:${c.childName}`;

/**
 * A manifest as one string per row, keyed. A row is the smallest unit a pack can add:
 * a type's header (everything but its attrs and children), one attribute, one child
 * rule, one common attribute, one default subtype.
 */
export function manifestRows(m: Manifest): Map<string, string> {
  const rows = new Map<string, string>();
  for (const t of m.types) {
    const { attrs, children, ...header } = t;
    rows.set(`type ${t.type}.${t.subType}`, JSON.stringify(header));
    for (const a of attrs) rows.set(`attr ${t.type}.${t.subType} @${a.name}`, JSON.stringify(a));
    for (const c of children) rows.set(`child ${t.type}.${t.subType} > ${childKey(c)}`, JSON.stringify(c));
  }
  for (const a of m.commonAttrs) rows.set(`common @${a.name}`, JSON.stringify(a));
  for (const [type, sub] of Object.entries(m.defaultSubTypes)) rows.set(`default ${type}`, JSON.stringify(sub));
  return rows;
}

export interface PackVocabulary {
  readonly pack: string;
  /** Types the pack registers, in full. */
  readonly types: ManifestType[];
  /** Types the pack does not own and adds attributes or child rules to. */
  readonly extends: { type: string; subType: string; attrs: ManifestAttr[]; children: ManifestChild[] }[];
  readonly commonAttrs: ManifestAttr[];
  readonly defaultSubTypes: Record<string, string>;
}

export interface PackVocabularyResult {
  readonly vocabulary: PackVocabulary;
  /** Rows the base already had that the pack changed or removed; empty when it leaves core alone. */
  readonly coreChanges: string[];
}

/**
 * Compose the default bundle, then the bundle plus `packProviders`, and split the
 * difference. The base is the bundle plus the packs this one requires, so a pack is
 * pinned only for what IT adds, and "leaves core alone" is asked of the bundle's rows.
 */
export function derivePackVocabulary(
  packId: string,
  requiredPacks: readonly MetaDataTypeProvider[],
  pack: MetaDataTypeProvider,
): PackVocabularyResult {
  const bundle = manifestRows(buildRegistryManifest(composeRegistry(coreProviders)));
  const baseManifest = buildRegistryManifest(composeRegistry([...coreProviders, ...requiredPacks]));
  const base = manifestRows(baseManifest);
  const composed = buildRegistryManifest(composeRegistry([...coreProviders, ...requiredPacks, pack], { validate: true }));
  const rows = manifestRows(composed);

  const coreChanges: string[] = [];
  for (const [key, value] of bundle) {
    const now = rows.get(key);
    if (now === undefined) coreChanges.push(`removed: ${key}`);
    else if (now !== value) coreChanges.push(`changed: ${key}\n      was ${value}\n      now ${now}`);
  }

  const baseTypes = new Set(baseManifest.types.map((t) => `${t.type}.${t.subType}`));
  const types: ManifestType[] = [];
  const ext: PackVocabulary["extends"] = [];
  for (const t of composed.types) {
    const key = `${t.type}.${t.subType}`;
    if (!baseTypes.has(key)) {
      types.push(t);
      continue;
    }
    const attrs = t.attrs.filter((a) => !base.has(`attr ${key} @${a.name}`));
    const children = t.children.filter((c) => !base.has(`child ${key} > ${childKey(c)}`));
    if (attrs.length > 0 || children.length > 0) ext.push({ type: t.type, subType: t.subType, attrs, children });
    // ADR-0050: what a pack projects onto a type it does not own must be optional, or every
    // model that loaded before the pack was composed stops loading once it is. The registry
    // refuses a required projected attribute itself (ERR_EXTEND_REQUIRED_ATTR); a child rule
    // with a lower bound it does not check, so this does.
    for (const c of children) if ((c.min ?? 0) > 0) coreChanges.push(`required: child ${key} > ${childKey(c)} (min ${c.min}) — a child rule added to a type the pack does not own must allow zero`);
  }
  const commonAttrs = composed.commonAttrs.filter((a) => !base.has(`common @${a.name}`));
  const defaultSubTypes: Record<string, string> = {};
  for (const [type, sub] of Object.entries(composed.defaultSubTypes)) {
    if (!base.has(`default ${type}`)) defaultSubTypes[type] = sub;
  }
  return { vocabulary: { pack: packId, types, extends: ext, commonAttrs, defaultSubTypes }, coreChanges };
}

/** The committed form of a pack's pinned vocabulary: 2-space JSON, one trailing newline. */
export function emitPackVocabulary(v: PackVocabulary): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}
