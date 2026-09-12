// FR-023 §4.3 — sharedModelFile(): the publisher's flattened shared-model artifact.
//
// A publisher project wires this generator to select a subset of its own metadata
// (by the same include/exclude scope-pattern grammar `scope` already uses) and emit
// it as ONE canonical-JSON `metadata.root` document plus a manifest — the artifact a
// consumer's `meta deps sync` copies into its own repo (design §2.2, §3.2, §3.5).
//
// The algorithm (design §4.3), in order:
//   1. Standalone load of `files` (default: the run's own source files, `ctx.sourceFiles`)
//      with `ctx.registry` (the run's composed registry — the SAME vocabulary the
//      project's own metadata loaded with), strict.
//   2. Select top-level nodes: never `requirement.*` / `template.*` (a publisher's
//      ledger and prompts are not a consumer's shapes), and matching the compiled
//      include/exclude scope.
//   3. Closure check: every `extends` target and every REF_BEARING_ATTR_NAMES value
//      of a selected node (and of its own descendants) must resolve to a SELECTED
//      node, else the selection is not self-contained and the build fails naming the
//      (referrer, target) pairs.
//   4. Serialize the selection with `serializeSharedDocument` — raw own-layer form,
//      `extends` preserved, sorted by resolution key.
//   5. Re-load the emitted document standalone with CORE providers only, strict — a
//      consumer loads it with ITS providers, and a Phase 1 export must not need the
//      publisher's non-core vocabulary.
//   6. Emit `<name>.metaobjects.json` + `metaobjects.pkg.json` (design §3.2).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type MetaData,
  type MetaRoot,
  MetaDataLoader,
  InMemoryStringSource,
  compileScope,
  matchesScope,
  REF_BEARING_ATTR_NAMES,
  resolveObjectRef,
  serializeSharedDocument,
  packageOfResolutionKey,
  PACKAGE_SEPARATOR,
  CHILD_REF_SEPARATOR,
  TYPE_REQUIREMENT,
  TYPE_TEMPLATE,
  METAMODEL_VERSION,
} from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { oncePerRun, type Generator, type GenContext, type EmittedFile } from "../generator.js";
import { effectivePackage } from "../docs-paths.js";

// The FR-023 manifest/artifact tool-file conventions (design §3.2, §4.3, "Hash
// format"). Their single canonical source is `sdk/src/dependencies.ts`
// (`MANIFEST_FILE`, `ARTIFACT_SUFFIX`, `INTEGRITY_PREFIX`) — codegen-ts cannot
// import sdk (the dependency runs the other way: `cli` depends on both, design
// §4.3's closing note), so these mirror those values locally. Keep in sync —
// exported (not merely local) so `cli`, which depends on both packages, can
// assert equality against `sdk`'s exports in a test; see
// `cli/test/shared-model-constants-parity.test.ts`.
export const MANIFEST_FILE = "metaobjects.pkg.json";
export const ARTIFACT_SUFFIX = ".metaobjects.json";
export const INTEGRITY_PREFIX = "sha256-";
/** design §3.2 — the manifest schema's own version, distinct from `metamodelVersion`. */
const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Separator for `checkClosure`'s dedupe key. A resolution key never contains a NUL,
 * so this cannot collide with either half it joins — unlike a printable separator
 * (`->`, `→`), which would need a separate argument for why no legal FQN could ever
 * contain it. Written as the `\0` ESCAPE, never a raw control byte: a raw 0x00 in
 * this source file previously made `git` treat it as binary, which (a) makes
 * `git diff`/GitHub show no content for the file at all, and (b) more seriously,
 * makes `.githooks/pre-commit`'s public-repo-hygiene grep skip its added lines
 * entirely (a binary file's diff is never text-enumerated) — silently defeating that
 * guard for any future edit to this file. The escape produces the byte-identical
 * runtime string; only the SOURCE FILE's byte content changes (readable text instead
 * of an embedded control byte).
 */
const DEDUPE_KEY_SEPARATOR = "\0";

export interface SharedModelFileOpts {
  /** The dependency key a consumer will `meta deps sync` under. Also the artifact's
   *  basename: emits `<name>.metaobjects.json`. */
  name: string;
  /** Scope-pattern include list (the same `acme::platform::**` grammar as `scope`). */
  include: readonly string[];
  /** Applied after `include`. */
  exclude?: readonly string[];
  /** Which of the publisher's own source files may contribute. Default: the run's
   *  own source files (`ctx.sourceFiles` — everything `files?` narrows). */
  files?: readonly string[];
  /** The published version. Default: the nearest `package.json` `version` walking
   *  up from `ctx.projectRoot`. */
  version?: string;
  /** Named output target, as on every other generator. */
  target?: string;
}

/** Everything before the first `CHILD_REF_SEPARATOR` that follows the LAST
 *  `PACKAGE_SEPARATOR` — the object part of a possibly dotted ref (ADR-0029's
 *  addressing model: package segments never fold onto a non-root child, so a
 *  `.` before the final `::`-segment can't occur). Mirrors the private
 *  `splitChildTail` in `naming-refs.ts` (not exported); `extends` and the
 *  origin `@from`/`@of`/`@via` attrs are the only REF_BEARING_ATTR_NAMES that
 *  can carry a dotted child tail — every other ref-bearing attr is already a
 *  bare object ref, and stripping a tail that isn't there is a no-op. */
function refOwner(ref: string): string {
  const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const dotInSeg = ref.indexOf(CHILD_REF_SEPARATOR, segStart);
  return dotInSeg === -1 ? ref : ref.slice(0, dotInSeg);
}

/** Depth-first walk of a node and its OWN descendants, node itself first. ADR-0039
 *  sanctioned own-only case: `serializeSharedDocument` emits each selected node's
 *  OWN layer only (`extends` preserved, not flattened — design §3.5), so the
 *  closure check must walk exactly what will be emitted, never what `extends`
 *  would additionally contribute (that is the base's own layer, checked
 *  separately if the base is itself selected). */
function walkOwn(node: MetaData): MetaData[] {
  const out: MetaData[] = [node];
  for (const child of node.ownChildren()) out.push(...walkOwn(child));
  return out;
}

interface ClosurePair {
  readonly referrer: string;
  readonly target: string;
}

/** design §4.3 step 3. `standaloneRoot` already loaded successfully (step 1), so
 *  every ref found here is guaranteed to RESOLVE to some node in it — the loader's
 *  own validation passes reject a dangling `extends`/object-ref before this ever
 *  runs. What is NOT guaranteed is that the resolved node is in `selectedKeys`. */
function checkClosure(
  standaloneRoot: MetaRoot,
  selected: readonly MetaData[],
  selectedKeys: ReadonlySet<string>,
): ClosurePair[] {
  const pairs: ClosurePair[] = [];
  const seen = new Set<string>();
  for (const top of selected) {
    const referrerKey = top.resolutionKey();
    for (const node of walkOwn(top)) {
      const referrerPkg = effectivePackage(node) ?? "";
      const candidates: string[] = [];
      if (node.superRef !== undefined) candidates.push(node.superRef);
      // ADR-0039 sanctioned own-only case (same rationale as walkOwn() above): an
      // INHERITED ref-bearing attr belongs to the base node's own layer, not this
      // one's, and is checked when the base itself is walked — reading it via the
      // resolving `attr()` here would attribute the base's reference to this node.
      for (const attrName of REF_BEARING_ATTR_NAMES) {
        const value = node.ownAttr(attrName);
        if (typeof value === "string") candidates.push(value);
      }
      for (const raw of candidates) {
        const resolved = resolveObjectRef(standaloneRoot, refOwner(raw), referrerPkg).node;
        if (resolved === undefined) continue; // already validated at load — defensive only
        const targetKey = resolved.resolutionKey();
        if (selectedKeys.has(targetKey)) continue;
        const dedupeKey = `${referrerKey}${DEDUPE_KEY_SEPARATOR}${targetKey}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        pairs.push({ referrer: referrerKey, target: targetKey });
      }
    }
  }
  return pairs.sort((a, b) =>
    a.referrer === b.referrer ? a.target.localeCompare(b.target) : a.referrer.localeCompare(b.referrer),
  );
}

/** design §2.2 — "version defaults to the host package's version". Walks up from
 *  `startDir` for the nearest `package.json` carrying a string `version`. */
function nearestPackageVersion(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 64; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
        if (typeof pkg.version === "string") return pkg.version;
      } catch {
        // An unparsable package.json is not a version source — keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function sharedModelFile(opts: SharedModelFileOpts): Generator {
  const generator: Generator = {
    name: "shared-model",
    generate: oncePerRun(async (_entities, ctx: GenContext): Promise<EmittedFile[]> => {
      const files = opts.files ?? ctx.sourceFiles ?? [];
      if (files.length === 0) {
        throw new Error(
          `sharedModelFile("${opts.name}"): no source files to load — pass \`files\`, or run ` +
            `through \`meta gen\`, which supplies the project's own files as \`ctx.sourceFiles\`.`,
        );
      }

      // Step 1 — standalone load, the run's own composed registry (so the publisher's
      // own consumer-supplied providers are honoured here exactly as they were for
      // the project's main load), strict.
      const loader = new MetaDataLoader({
        ...(ctx.registry !== undefined ? { registry: ctx.registry } : {}),
        strict: true,
      });
      const loaded = await loader.load(files.map((p) => new FileSource(p)));
      if (loaded.errors.length > 0) {
        throw loaded.errors[0];
      }
      const standaloneRoot = loaded.root;

      // Step 2 — select top-level nodes. ADR-0039 sanctioned own-only case: `MetaRoot`
      // has no super chain (it never `extends`), so its own children ARE its effective
      // children — the same case `MetaRoot.objects()`/`findObject()` document.
      const compiled = compileScope({ include: opts.include, exclude: opts.exclude ?? [] });
      const selected = standaloneRoot
        .ownChildren()
        .filter((node) => node.type !== TYPE_REQUIREMENT && node.type !== TYPE_TEMPLATE)
        .filter((node) => matchesScope(node.resolutionKey(), compiled));
      if (selected.length === 0) {
        throw new Error(
          `sharedModelFile("${opts.name}"): selected no nodes (include/exclude, always ` +
            `excluding requirement.* and template.*) — nothing to publish. Check \`include\`.`,
        );
      }

      // Step 3 — closure.
      const selectedKeys = new Set(selected.map((n) => n.resolutionKey()));
      const closureFailures = checkClosure(standaloneRoot, selected, selectedKeys);
      if (closureFailures.length > 0) {
        const lines = closureFailures.map((p) => `  ${p.referrer} → ${p.target}`).join("\n");
        throw new Error(
          `sharedModelFile("${opts.name}"): the selection is not closed — these references ` +
            `point outside it; include it or exclude the referrer:\n${lines}`,
        );
      }

      // Step 4 — serialize (already sorted by resolution key; the callee also
      // throws if a selected node has no package, per its own contract).
      const artifactContent = serializeSharedDocument(selected);

      // Step 5 — re-load standalone with CORE providers only (registry omitted ⇒
      // MetaDataLoader's own default registry), strict. A consumer loads this
      // artifact with ITS OWN providers, never the publisher's — so an export
      // needing publisher-only vocabulary must fail HERE, not at the consumer.
      const artifactPath = `${opts.name}${ARTIFACT_SUFFIX}`;
      const coreLoader = new MetaDataLoader({ strict: true });
      const coreLoaded = await coreLoader.load([
        new InMemoryStringSource(artifactContent, { id: artifactPath }),
      ]);
      if (coreLoaded.errors.length > 0) {
        const first = coreLoaded.errors[0]!;
        throw new Error(
          `sharedModelFile("${opts.name}"): the export needs a provider this toolchain does ` +
            `not ship; Phase 1 exports must load with core vocabulary: ${first.message}`,
        );
      }

      // Step 6 — emit the artifact + manifest.
      const integrity = `${INTEGRITY_PREFIX}${createHash("sha256").update(artifactContent, "utf-8").digest("hex")}`;
      const packages = [...new Set(selected.map((n) => packageOfResolutionKey(n.resolutionKey())))].sort();
      const nodes = selected.map((n) => n.resolutionKey()).sort();
      const version = opts.version ?? nearestPackageVersion(ctx.projectRoot ?? process.cwd());
      if (version === undefined) {
        throw new Error(
          `sharedModelFile("${opts.name}"): no version available — pass \`version\` explicitly, ` +
            `or run inside a project with a package.json version at or above the project root.`,
        );
      }
      const manifest = {
        schema_version: MANIFEST_SCHEMA_VERSION,
        name: opts.name,
        version,
        metamodelVersion: METAMODEL_VERSION,
        artifact: artifactPath,
        integrity,
        packages,
        nodes,
      };
      return [
        { path: artifactPath, content: artifactContent },
        { path: MANIFEST_FILE, content: JSON.stringify(manifest, null, 2) + "\n" },
      ];
    }),
  };
  if (opts.target !== undefined) generator.target = opts.target;
  return generator;
}
