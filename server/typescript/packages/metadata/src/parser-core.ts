// Shared canonical tree-builder — redesigned (post-v0.3) format.
//
// buildTree() turns a canonical-shaped JS object into a typed MetaData tree.
// parser-json.ts and parser-yaml.ts both funnel their parsed/desugared input
// through here so JSON and YAML stay isomorphic ("one structure, two
// renderings").
//
// Node encoding: every node is a single-key map { "<type>.<subType>": <body> }.
// The wrapper key FUSES type and subType into one dotted token (object.entity,
// field.long, metadata.root). The body is a map of reserved structural keys
// (name/package/extends/abstract/overlay/isArray/children), `@`-prefixed
// attributes, and the children list.
//
// Operator vocabulary (canonical, no aliases):
//   - extends:      string ref to a supertype (immediate resolution against
//                   the accumulating root, or deferred for cross-file refs)
//   - overlay:true  re-opens an existing same-(type,name) child; errors if missing
//
// Default (no operator): silently reuse existing same-(type,name) child, or
// create new.
//
// Context package for super resolution:
//   Each node's effective package is its own package if set, or inherited from
//   the nearest ancestor with a package.

import { TypeId, TypeRegistry } from "./registry.js";
import type { MetaData } from "./shared/meta-data.js";
import { MetaRoot } from "./shared/meta-root.js";
import { MetaAttr } from "./core/attr/meta-attr.js";
import { canonicalSerialize, inferAttrSubType } from "./serializer-json.js";
import { ParseError, type ErrorCode } from "./errors.js";
// #337 — see retired-vocabulary.ts. Diagnostic only; no load outcome changes.
import { retiredSubType, retirementHint, retirementSuggestions } from "./retired-vocabulary.js";
import { resolvedSource, type ErrorSource, type LoaderWarning, type Contributor } from "./source.js";
import { semanticDiff } from "./semantic-diff.js";
import {
  resolveSuperRef,
  isChildTargetingRef,
  extendsTargetCompatible,
  EXTENDS_TARGET_MISMATCH_RULE,
} from "./super-resolve.js";
import { JsonPathBuilder } from "./json-path.js";
import { getYamlPosition, type YamlPosition } from "./core/yaml-positions.js";
import {
  TYPE_ATTR,
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_VALIDATOR,
  SUBTYPE_BASE,
} from "./shared/base-types.js";
import {
  RESERVED_KEYS,
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_ABSTRACT,
  RESERVED_KEY_OVERLAY,
  RESERVED_KEY_IS_ARRAY,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_VALUE,
  JSON_KEY_SCHEMA,
  ATTR_PREFIX,
  TYPE_SUBTYPE_SEPARATOR,
  PACKAGE_SEPARATOR,
} from "./shared/structural.js";
import { ATTR_SUBTYPE_PROPERTIES, ATTR_SUBTYPE_STRINGARRAY } from "./core/attr/attr-constants.js";
import { attrClassFor } from "./attr-class-map.js";
import type { AttrValue } from "./shared/meta-data.js";
import { isRelativeRef, REF_BEARING_ATTR_NAMES } from "./naming-refs.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseOptions {
  registry: TypeRegistry; // required — types must be registered
  strict?: boolean; // throw on parsing problems? default false
  sourceName?: string; // for error messages, e.g., "fishstore.json"
  /**
   * Loader's accumulating root. If provided, parse merges nodes into it.
   * If undefined, creates a new root from the JSON's root node.
   *
   * When provided, the returned `root` is this same instance (possibly mutated).
   * When undefined, a fresh root is created from the JSON.
   */
  intoRoot?: MetaRoot;
  /**
   * If true, super refs that don't resolve at parse time are NOT a parse error;
   * the model retains its raw `superRef` and a second pass (via
   * resolveDeferredSupers in super-resolve.ts) is expected after all input
   * files are parsed. Used by Loader.load/loadJsonStrings to support cross-file
   * super resolution where one file may declare a super target that lives in
   * another file parsed later.
   */
  deferSuperResolution?: boolean;
  /**
   * FR5b — discriminant for the source-on-node envelope's `format` field.
   * Defaults to `"json"` (parseJson supplies nothing). parseYaml passes
   * `"yaml"` so populateNodeSource emits `format: "yaml"` and, when the
   * desugar attached one, the optional `yamlPosition`.
   */
  sourceFormat?: "json" | "yaml";
}

export interface ParseResult {
  root: MetaRoot;
  warnings: string[];
  errors: ParseError[];
  /**
   * FR5c — envelope-shaped warnings (e.g. WARN_DUPLICATE_DECLARATION) produced
   * during the parse/merge pipeline. Distinct from the legacy `warnings:
   * string[]` channel: those messages get wrapped in a `WARN_LEGACY` envelope
   * at the loader boundary, while envelope warnings already carry their own
   * `code` + `source` and are surfaced unchanged. Defaults to `[]`.
   */
  envelopeWarnings: LoaderWarning[];
}

// ---------------------------------------------------------------------------
// Internal helper — build a parse-phase ErrorSource envelope.
//
// FR5a / ADR-0009: ParseError carries a `source: ErrorSource` envelope. For
// errors raised mid-parse, the envelope's jsonPath comes from the parser's
// module-level JsonPathBuilder (synced with the walk); files[0] is the parsed
// source id. Falls back to a code-source envelope if invoked outside a buildTree
// run (defensive — every callsite below runs inside buildTree).
// ---------------------------------------------------------------------------

export function errSource(): ErrorSource {
  if (_currentPath !== undefined && _currentSourceId !== undefined) {
    // FR5b (finalized 2026-05-27, all four ports) — buildTree-emitted errors
    // from a YAML input now emit `format: "yaml"` (was `"json"` interim while
    // each port shipped yamlPosition tracking). The optional `yamlPosition`
    // rides along when the desugar's position map covers the current node.
    if (_currentFormat === "yaml") {
      return {
        format: "yaml",
        files: [_currentSourceId],
        jsonPath: _currentPath.toString(),
        ...(_currentYamlPosition !== undefined
          ? { yamlPosition: _currentYamlPosition }
          : {}),
      };
    }
    return {
      format: "json",
      files: [_currentSourceId],
      jsonPath: _currentPath.toString(),
    };
  }
  return { format: "code", caller: "parser-core" };
}

// ---------------------------------------------------------------------------
// Internal helper — report a problem: throw in strict mode, push warning otherwise
// ---------------------------------------------------------------------------

function reportProblem(
  msg: string,
  strict: boolean,
  warnings: string[],
  code: ErrorCode,
): void {
  if (strict) {
    throw new ParseError(msg, { code, source: errSource() });
  }
  warnings.push(msg);
}

// ---------------------------------------------------------------------------
// FR-032 (ADR-0032) — canonical-JSON ref guard.
//
// Canonical JSON is the self-contained interchange form: every ref-bearing attr
// MUST be fully-qualified. A relative authoring form (leading `::` or `..::`)
// surviving into canonical JSON is `ERR_RELATIVE_REF_IN_CANONICAL`. The guard
// fires ONLY for JSON-format input — YAML-format input has already been
// desugar-expanded via expandRef (so any `::`/`..::` there is correct authoring
// that was lowered to FQN before buildTree sees it). Like ERR_RESERVED_ATTR,
// this is a hard error routed through the loader's error sink even in lax mode.
// ---------------------------------------------------------------------------

function guardRelativeRefInCanonical(
  refLabel: string,
  rawValue: unknown,
  strict: boolean,
  warnings: string[],
  path: string,
): void {
  if (_currentFormat !== "json") return;
  if (typeof rawValue !== "string") return;
  if (!isRelativeRef(rawValue)) return;
  const msg =
    `Relative reference '${rawValue}' on ${refLabel} at ${path} is not allowed in ` +
    `canonical JSON — canonical JSON must be fully-qualified. Relative forms ` +
    `(leading '::' or '..::') are YAML-authoring sugar that the desugar expands.`;
  if (strict) {
    throw new ParseError(msg, { code: "ERR_RELATIVE_REF_IN_CANONICAL", source: errSource() });
  }
  if (_currentErrors !== undefined) {
    _currentErrors.push(
      new ParseError(msg, { code: "ERR_RELATIVE_REF_IN_CANONICAL", source: errSource() }),
    );
  } else {
    warnings.push(msg);
  }
}

// ---------------------------------------------------------------------------
// The one message for an authored `<type>.base`, so both doors say the same thing.
//
// Every registered `base` subtype is an ABSTRACT REGISTRY ANCHOR: the shared root that
// concrete subtypes inherit their attrs and child rules from. It has no runtime semantics
// and no concrete representation — `spec/metamodel/object.json` says so in as many words
// ("Has no runtime semantics of its own; not authored directly"), and every `base` entry's
// description opens with "Abstract".
//
// The JVM enforced this by accident (its impl classes are `public abstract`, so
// instantiation fails); TypeScript, C# and Python accepted it. The same document therefore
// loaded on three ports and failed to load on two — the cross-port conformance gap the
// corpora exist to catch, and it survived because every `*.base` subtype sits in the
// registry corpus's own `untestedSubTypes` list.
/**
 * Is `<type>.base` an ABSTRACT ANCHOR for this type — i.e. does the type register at least one
 * OTHER subtype for it to anchor?
 *
 * Registry-driven, not name-driven, and the distinction is load-bearing. All ten core anchors
 * have concrete siblings (`object.base` beside entity/value/projection, `source.base` beside
 * rdb, …), so the rule catches every one. A third-party provider may register `base` as a
 * type's ONLY member — the SDK's forge `convention`/`glossary`/`failure` do — and there it is
 * not anchoring anything: refusing it would leave the type unauthorable, which is a
 * capability removal the contract never asked for. The manifest describes the CORE registry;
 * this predicate is how that scope is expressed without hardcoding the core's type list.
 */
function isAbstractAnchorFor(type: string, registry: TypeRegistry): boolean {
  return registry.allSubTypesOf(type).some((sub) => sub !== SUBTYPE_BASE);
}

function abstractSubtypeMessage(type: string): string {
  return (
    `"${type}.${SUBTYPE_BASE}" may not be authored — every "${SUBTYPE_BASE}" subtype is an ` +
    `abstract registry anchor that concrete subtypes inherit from, with no runtime ` +
    `semantics of its own. Declare a concrete ${type} subtype instead.`
  );
}

// The same rule reached by the OTHER spelling: a BARE wrapper key (`{"field": …}`, no fused
// subType) whose registry default resolves to the abstract anchor. The author did not type
// `.base`, so this is a MISSING subtype rather than an authored-anchor error — and
// ERR_MISSING_SUBTYPE is the shared code already chartered for it ("a node omits subType and
// the type has no default subType").
//
// Python has always emitted it here; TypeScript, C# and the JVM did not, so a bare key was a
// SECOND way one document got two verdicts: TS and C# resolved it to the anchor and loaded,
// the JVM resolved it identically and then failed to instantiate with a message naming a
// missing constructor. Closing the authored spelling alone would have left the rule half
// true, reachable by dropping four characters.
//
// Scoped to "the default IS the anchor", never to bare keys as such: a type that declares a
// CONCRETE default keeps resolving through it, which is the door a future default-subtype
// decision walks through (ADR-0054's closing section).
function missingSubtypeMessage(type: string): string {
  return (
    `type "${type}" has no default subType; write the full "${type}.<subType>"`
  );
}

// Internal helper — split a fused wrapper key into (type, subType).
//
// Canonical JSON always writes the full `type.subType`. An omitted subType
// (a bare `type` key, no `.`) resolves to the type's registry default — the
// first registered subtype, falling back to SUBTYPE_BASE.
// ---------------------------------------------------------------------------

interface SplitKey {
  type: string;
  subType: string;
  /** true when the subType was fused into the key; false when defaulted. */
  explicit: boolean;
}

/**
 * The subType a BARE wrapper key (`{"object": …}`) resolves to: the type's DECLARED default,
 * or `undefined` when it declares none.
 *
 * `registry.defaultSubTypeOf` is the same accessor the YAML desugar consults, and the shared
 * corpus already pins the contract (`fixtures/yaml-conformance/yaml-bare-default-subtypes`:
 * bare `object:` becomes `object.entity`). This used to guess instead — `allSubTypesOf()[0]`,
 * i.e. registration order, falling back to `base` — so the two layers answered the same
 * question two different ways. Registration order put `base` first, so a bare key in JSON
 * resolved to the abstract anchor: it loaded here and in C#, while the JVM resolved it
 * identically and then failed to INSTANTIATE, because its impl classes are abstract.
 *
 * A name resolved twice by two different functions is a name that can disagree with itself —
 * the defect class this file's own header exists to prevent, reached through the one door
 * nobody had pointed at the registry.
 */
function defaultSubTypeFor(type: string, registry: TypeRegistry): string | undefined {
  return registry.defaultSubTypeOf(type);
}

function splitTypeKey(key: string, registry: TypeRegistry): SplitKey {
  const dotIdx = key.indexOf(TYPE_SUBTYPE_SEPARATOR);
  if (dotIdx < 0) {
    // Bare type, no fused subType — resolve via the registry default.
    return { type: key, subType: defaultSubTypeFor(key, registry) ?? "", explicit: false };
  }
  const type = key.slice(0, dotIdx);
  const subType = key.slice(dotIdx + TYPE_SUBTYPE_SEPARATOR.length);
  // Malformed keys (e.g. "object.entity.extra", ".entity", "object.") are not
  // validated here — they fall through to the downstream registry.has() check
  // which reports them as an unknown type or subtype error.
  return { type, subType, explicit: true };
}

// ---------------------------------------------------------------------------
// Helper: expand relative package paths
// ---------------------------------------------------------------------------

/**
 * Expands a package path relative to a base package.
 * Java semantics:
 *   - Absolute path (::foo::bar) → prepended with base: "acme" + "::foo" → "acme::foo::bar"
 *   - Relative parent (..) → handled in super resolution, not here
 *   - No leading :: → used as-is
 */
function expandPackageForPath(basePkg: string, pkgPath: string): string {
  if (basePkg.trim() === "" || !pkgPath.startsWith(PACKAGE_SEPARATOR)) {
    return pkgPath;
  }
  return basePkg + pkgPath;
}

/**
 * The resolution key a ROOT-LEVEL declaration would carry once parsed:
 * `<pkg>::<name>` where pkg is the node's own `package` (expanded against the
 * file context, same as applyReservedKeys) when declared, else the file's
 * context package. Bare name when neither exists. Matches
 * `MetaData.resolutionKey()` on the already-parsed side, so the root-level
 * merge lookup can compare identity BEFORE the new node is constructed.
 */
function rootChildResolutionKey(
  nodeData: Record<string, unknown>,
  inheritedContextPkg: string,
  name: string,
): string {
  const rawPkg = nodeData[RESERVED_KEY_PACKAGE];
  const pkg =
    typeof rawPkg === "string" && rawPkg !== ""
      ? expandPackageForPath(inheritedContextPkg, rawPkg)
      : inheritedContextPkg;
  return pkg !== "" ? `${pkg}${PACKAGE_SEPARATOR}${name}` : name;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

// Module-level flag consumed by parseNodeFresh during super resolution.
// Safe because buildTree is fully synchronous — no reentrancy risk within
// a single parse call. Set at buildTree entry, read deep in the call tree.
let _deferSuperResolution = false;

// Module-level hard-error sink for inline @-attr checks (used by
// applyInlineAttrsAndUnknownKeys). Set at buildTree entry alongside the
// errors[] aggregator so a reserved-word-as-attr violation lands in the
// loader's errors[] without changing the helper's signature.
// Safe because buildTree is synchronous — same reentrancy argument as
// _deferSuperResolution.
let _currentErrors: ParseError[] | undefined;

// FR5c — envelope-warnings sink for the merge phase. Set at buildTree entry
// so deeply-nested merge sites can emit WARN_DUPLICATE_DECLARATION without
// threading another parameter through every helper signature. Safe under
// the same synchronous-buildTree reentrancy argument as the others.
let _currentEnvelopeWarnings: LoaderWarning[] | undefined;

// FR5a / ADR-0009 — Module-level JSONPath builder + source id, set at
// buildTree entry and updated by recursive descent (push on the way down,
// pop on the way back up). Used by populateNodeSource() to stamp every
// constructed MetaData with `{ format: "json"|"yaml", files: [sourceId],
// jsonPath, [yamlPosition?] }`.
// Safe because buildTree is synchronous — same reentrancy argument as
// _currentErrors above.
let _currentPath: JsonPathBuilder | undefined;
let _currentSourceId: string | undefined;
// FR5b — source format discriminant + current node's YAML position, set
// by the per-child iteration in processChildren (and at root) right before
// the parseNodeFresh call. The position is read from the wrapper object's
// position-by-key map (attached by the YAML walker in core/yaml-positions.ts
// and preserved through core/yaml-desugar.ts).
let _currentFormat: "json" | "yaml" = "json";
let _currentYamlPosition: YamlPosition | undefined;

/** FR5a/FR5b — stamp the source-provenance envelope on a freshly-created
 *  node. No-op when invoked outside buildTree's setup (defensive — the
 *  module-level state will always be populated during a normal parse).
 *
 *  FR5b (finalized 2026-05-27) — YAML-input nodes get `format: "yaml"`
 *  envelopes (was `"json"` interim). The optional `yamlPosition` rides
 *  along when the desugar's position map covers the current node. */
function populateNodeSource(node: MetaData): void {
  if (_currentPath === undefined || _currentSourceId === undefined) return;
  if (_currentFormat === "yaml") {
    node.setSource({
      format: "yaml",
      files: [_currentSourceId],
      jsonPath: _currentPath.toString(),
      ...(_currentYamlPosition !== undefined
        ? { yamlPosition: _currentYamlPosition }
        : {}),
    });
    return;
  }
  node.setSource({
    format: "json",
    files: [_currentSourceId],
    jsonPath: _currentPath.toString(),
  });
}

/**
 * buildTree — the shared registry-driven tree-builder.
 *
 * Turns an already-parsed *canonical-shaped* JS object (from JSON.parse, or
 * from the YAML parser's desugar) into a typed MetaData tree. Both parseJson
 * and parseYaml funnel through here, guaranteeing one structure / two
 * renderings stay isomorphic.
 *
 * Throws ParseError for top-level structural problems (matching the historical
 * parseJson behavior); collects content-level problems into the result.
 */
export function buildTree(parsed: unknown, opts: ParseOptions): ParseResult {
  const warnings: string[] = [];
  const errors: ParseError[] = [];
  const envelopeWarnings: LoaderWarning[] = [];
  const strict = opts.strict ?? false;
  const source = opts.sourceName;
  _deferSuperResolution = opts.deferSuperResolution === true;
  _currentErrors = errors;
  // FR5c — module-level handle so the deeply-nested merge code paths can
  // emit envelope warnings without threading another parameter through the
  // entire walk. Safe because buildTree is fully synchronous.
  _currentEnvelopeWarnings = envelopeWarnings;
  // FR5a — start a fresh JSONPath stack rooted at "$"; sourceId is the
  // source's id (from FileSource / InMemoryStringSource via opts.sourceName).
  // Falls back to "<unknown>" when no name was supplied (e.g. ad-hoc parseJson
  // calls from tests).
  _currentPath = new JsonPathBuilder();
  _currentSourceId = source ?? "<unknown>";
  // FR5b — propagate the per-parse source-format discriminant. parseJson
  // omits the option (defaults to "json"); parseYaml supplies "yaml".
  _currentFormat = opts.sourceFormat ?? "json";
  _currentYamlPosition = undefined;

  try {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ParseError("Top-level metadata must be an object", { code: "ERR_TOP_LEVEL_NOT_OBJECT", source: errSource() });
    }

    const topLevel = parsed as Record<string, unknown>;

    // --- Find the wrapper key (skip $schema) ---
    const wrapperKeys = Object.keys(topLevel).filter((k) => k !== JSON_KEY_SCHEMA);

    if (wrapperKeys.length === 0) {
      throw new ParseError("Top-level metadata object has no type wrapper key", { code: "ERR_TOP_LEVEL_NOT_OBJECT", source: errSource() });
    }
    if (wrapperKeys.length > 1) {
      throw new ParseError(
        `Top-level metadata object must have exactly one wrapper key (found: ${wrapperKeys.join(", ")})`,
        { code: "ERR_TOP_LEVEL_NOT_OBJECT", source: errSource() },
      );
    }

    const rootKey = wrapperKeys[0]!;
    const rootData = topLevel[rootKey];

    if (typeof rootData !== "object" || rootData === null || Array.isArray(rootData)) {
      // The error context references the rootKey wrapper; push it so the
      // envelope's jsonPath includes it (matches the legacy `path` slot).
      _currentPath!.pushKey(rootKey);
      const src = errSource();
      _currentPath!.pop();
      throw new ParseError(
        `Top-level wrapper "${rootKey}" must contain an object`,
        { code: "ERR_TOP_LEVEL_NOT_OBJECT", source: src },
      );
    }

    const rootDataObj = rootData as Record<string, unknown>;
    const { type: rootType, subType: rootSubType, explicit: rootExplicit } =
      splitTypeKey(rootKey, opts.registry);

    // A `<type>.base` node may not be AUTHORED — see abstractSubtypeMessage. This is the
    // ROOT door; the child door is in the child loop below. One rule, both doors: a check
    // on one of two entry points is a rule that is only half true.
    // Registration first: an UNREGISTERED type has no default either, so without this a typo'd
    // root key is diagnosed as a registered type that merely lacks a default. The registration
    // check below owns that case and phrases it correctly.
    if (opts.registry.allSubTypesOf(rootType).length > 0
      && ((rootSubType === SUBTYPE_BASE && isAbstractAnchorFor(rootType, opts.registry))
        || (!rootExplicit && rootSubType === ""))) {
      _currentPath!.pushKey(rootKey);
      const src = errSource();
      _currentPath!.pop();
      throw rootExplicit
        ? new ParseError(abstractSubtypeMessage(rootType), {
            code: "ERR_ABSTRACT_SUBTYPE_AUTHORED",
            source: src,
          })
        : new ParseError(missingSubtypeMessage(rootType), {
            code: "ERR_MISSING_SUBTYPE",
            source: src,
          });
    }

    // Check root type is registered (always throw — can't skip the root)
    if (!opts.registry.has(rootType, rootSubType)) {
      const rootTypeCode = opts.registry.allSubTypesOf(rootType).length > 0
        ? "ERR_UNKNOWN_SUBTYPE" as const
        : "ERR_UNKNOWN_TYPE" as const;
      _currentPath!.pushKey(rootKey);
      const src = errSource();
      _currentPath!.pop();
      // Same hint at the ROOT door. No retired subtype is root-legal today, so this arm
      // is currently unreachable — wired anyway, because "fixed one door, left the
      // other" is how a rule ends up half-true and passing every probe.
      const retiredRoot = retiredSubType(rootType, rootSubType);
      throw new ParseError(
        `Unknown root type "${rootType}.${rootSubType}" — ` +
          (retiredRoot !== undefined ? retirementHint(retiredRoot) : "not registered"),
        {
          code: rootTypeCode,
          source: src,
          ...(retiredRoot !== undefined
            ? { suggestions: retirementSuggestions(retiredRoot) }
            : {}),
        },
      );
    }

    // FR5a — push the wrapper-key segment onto the JSONPath stack so all
    // descendants emit jsonPath strings rooted at "$.<rootKey>". The merge-mode
    // path keeps the existing root's source untouched; only NEW children get
    // populated with the current source's id (correct: the existing root was
    // already stamped from the file that created it).
    _currentPath!.pushKey(rootKey);
    // FR5b — look up the root wrapper's YAML position (when in yaml mode)
    // so parseNodeFresh stamps `source.yamlPosition` on the root node.
    if (_currentFormat === "yaml") {
      _currentYamlPosition = getYamlPosition(topLevel, rootKey);
    }

    if (opts.intoRoot !== undefined) {
      // --- Merge mode: parse root's attrs/children into the existing root ---
      // The JSON root's own package/super/reserved-keys are not re-applied to the
      // existing root. BUT: children from the NEW JSON should inherit from the
      // NEW root's package, not the existing root's.
      const newRootPkg = rootDataObj[RESERVED_KEY_PACKAGE];
      const contextPkg = (typeof newRootPkg === "string" ? newRootPkg : opts.intoRoot.package) ?? "";
      parseNodeInto(
        rootDataObj,
        opts.intoRoot,
        opts.intoRoot, // accumulating root for super resolution
        contextPkg,
        opts.registry,
        warnings,
        errors,
        strict,
        source,
        rootKey,
      );
      _currentPath!.pop();
      return { root: opts.intoRoot, warnings, errors, envelopeWarnings };
    }

    // --- Fresh root mode: create a new root from the JSON ---
    // The cast is safe within the core provider: `metadata.root` is the only
    // registered `metadata` subtype, and its factory unconditionally produces a
    // MetaRoot (see core-types.ts). A registry that registered a second
    // `metadata.*` subtype backed by a non-MetaRoot factory would break this
    // cast — a known limitation of the `TypeDefinition.factory: => MetaData`
    // signature. `parseNodeFresh` is a general node parser, so MetaData is its
    // correct return type; this top-level callsite is where the doc-root invariant holds.
    const root = parseNodeFresh(
      rootType,
      rootSubType,
      rootDataObj,
      undefined, // no accumulating root yet — built as we go
      "",        // no inherited context pkg yet for the root itself
      opts.registry,
      warnings,
      errors,
      strict,
      source,
      rootKey,
    ) as MetaRoot;
    _currentPath!.pop();
    return { root, warnings, errors, envelopeWarnings };
  } finally {
    _deferSuperResolution = false;
    _currentErrors = undefined;
    _currentEnvelopeWarnings = undefined;
    _currentPath = undefined;
    _currentSourceId = undefined;
    _currentFormat = "json";
    _currentYamlPosition = undefined;
  }
}

// ---------------------------------------------------------------------------
// parseNodeFresh — creates a NEW node for this metadata node.
//
// `accumRoot` is the root of the accumulating tree (for super resolution).
// When parsing the root node itself, accumRoot is undefined on first call;
// the newly created root is passed as accumRoot for its children.
//
// `inheritedContextPkg` is the effective package from the nearest ancestor
// that had an explicit package. Used when this node has no own package.
// ---------------------------------------------------------------------------

function parseNodeFresh(
  type: string,
  subType: string,
  nodeData: Record<string, unknown>,
  accumRoot: MetaData | undefined,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
  parentType?: string, // optional: type of the parent node (for inheritance rules)
  parent?: MetaData, // optional: the parent model itself (for checking fqn)
): MetaData {
  // --- Look up type in registry ---
  if (!registry.has(type, subType)) {
    if (registry.has(type, SUBTYPE_BASE)) {
      subType = SUBTYPE_BASE;
    } else {
      const msg = `Unknown type "${type}.${subType}" — not registered`;
      errors.push(new ParseError(msg, { code: "ERR_UNKNOWN_TYPE", source: errSource() }));
      const rawName = nodeData[RESERVED_KEY_NAME];
      const name = typeof rawName === "string" ? rawName : "";
      const stub = new MetaRoot(new TypeId(type, subType), name);
      populateNodeSource(stub);
      return stub;
    }
  }

  // --- Determine name ---
  const rawName = nodeData[RESERVED_KEY_NAME];
  let name = typeof rawName === "string" ? rawName : "";

  // --- Create the model ---
  const def = registry.find(type, subType)!;
  // Config-driven default name for a SINGLETON child type: when the node is
  // declared with no name and its type definition is `maxOccurs: 1` with a
  // `defaultName`, assign it (e.g. identity.primary → "primary"). Safe by
  // construction — maxOccurs===1 guarantees no sibling can collide — and keeps
  // the one-and-only node addressable. Multi-cardinality types carry no
  // defaultName, so they still require an explicit name (FR-024).
  if (name === "" && def.maxOccurs === 1 && def.defaultName !== undefined) {
    name = def.defaultName;
  }
  const model = def.factory(def.typeId, name);
  // FR5a — stamp the source provenance envelope using the parser's current
  // JSONPath stack + source id. setSource happens BEFORE freeze (the parser
  // is the only caller during loading; freeze runs in the loader after).
  populateNodeSource(model);

  // --- Capture the file-default package at PARSE time (resolution-only) ---
  // `inheritedContextPkg` is the package threaded down from the file's root
  // `metadata.package` (the nearest packaged ancestor). Recording it here —
  // when the declaring file's package is known — lets super-resolution match
  // this node by its effective qualified key regardless of post-merge tree
  // shape or load order. This does NOT touch the node's `package` or `fqn()`
  // (objects stay bare per FR5d). Mirrors Java's parse-time getDefaultPackageName().
  if (inheritedContextPkg !== "") {
    model.setFileDefaultPackage(inheritedContextPkg);
  }

  // --- Apply reserved keys (package, extends, abstract, isArray) ---
  applyReservedKeys(model, nodeData, strict, source, path, warnings, inheritedContextPkg);

  // --- Inherit package from context if not explicitly set ---
  // Java rule (BaseMetaDataParser.shouldInheritPackageFromParent):
  // - Fields within objects: no package (simple names)
  // - Fields NOT within objects: inherit parent's package (for abstract fields at root level)
  // - Validators within fields: inherit the field's package ONLY if field's FQN contains "::"
  // - Objects and other types: don't inherit
  if (model.package === undefined && inheritedContextPkg !== "") {
    let shouldInherit = false;

    if (type === TYPE_FIELD && parentType !== TYPE_OBJECT) {
      shouldInherit = true;
    } else if (type === TYPE_VALIDATOR && parentType === TYPE_FIELD && parent !== undefined) {
      shouldInherit = parent.fqn().includes(PACKAGE_SEPARATOR);
    }

    if (shouldInherit) {
      model.setPackage(inheritedContextPkg);
    }
  }

  // --- Determine the effective context package for super resolution ---
  const effectivePkg = model.package ?? inheritedContextPkg;

  // --- Resolve super IMMEDIATELY against the accumulating root ---
  // (Skipped when deferSuperResolution is true — the loader resolves after
  // all input files have been parsed, so cross-file super refs work.)
  if (model.superRef !== undefined && accumRoot !== undefined && !_deferSuperResolution) {
    // FR-024: thread the referrer's type so dotted `Entity.child` refs resolve
    // type-scoped — kept consistent with the deferred path (super-resolve.ts).
    const superModel = resolveSuperRef(model.superRef, effectivePkg, accumRoot, { type: model.type });
    if (superModel !== undefined) {
      // FR-024 — a dotted child-targeting ref must resolve to a node of the
      // SAME type and subtype as the extending node. Dotted-only check; the
      // shipped top-level extends behavior is unchanged.
      //
      // The predicate is IMPORTED, not restated: this eager path and
      // super-resolve's deferred path are two doors onto one rule, and they
      // previously held independent copies of the boolean — so #310's relaxation
      // applied to one would have left the other refusing, on whichever path a
      // given loader configuration happens to take.
      if (
        isChildTargetingRef(model.superRef) &&
        !extendsTargetCompatible(model, superModel)
      ) {
        throw new ParseError(
          `the extends target '${model.superRef}' is ${superModel.type}.${superModel.subType} but the extending node '${model.fqn()}' is ${model.type}.${model.subType} — ${EXTENDS_TARGET_MISMATCH_RULE}`,
          {
            code: "ERR_EXTENDS_TARGET_MISMATCH",
            source: resolvedSource(errSource(), model.fqn(), model.superRef),
          },
        );
      }
      model.setSuperResolved(superModel);
    } else {
      // FR5d — emit format=resolved with referrer + target. referrer is the
      // declaring node's FQN (we just built it above); target is the
      // unresolved supertype ref string.
      throw new ParseError(
        `the SuperClass '${model.superRef}' does not exist in file '${source ?? "<unknown>"}'`,
        {
          code: "ERR_UNRESOLVED_SUPER",
          source: resolvedSource(errSource(), model.fqn(), model.superRef),
        },
      );
    }
  } else if (model.superRef !== undefined && accumRoot === undefined) {
    // Root node has a super ref — not resolvable against itself.
    reportProblem(
      `super on root node ('${model.superRef}') is not supported and will be ignored`,
      strict,
      warnings,
      "ERR_UNRESOLVED_SUPER",
    );
  }

  // --- Process inline attributes and other keys ---
  applyInlineAttrsAndUnknownKeys(model, nodeData, strict, source, path, warnings, registry);

  // --- Process children ---
  // For the root node we use itself as the accumRoot for its children.
  const childAccumRoot = accumRoot ?? model;
  const childInheritedContextPkg = model.package ?? inheritedContextPkg;
  processChildren(model, nodeData, childAccumRoot, childInheritedContextPkg, registry, warnings, errors, strict, source, path);

  return model;
}

// ---------------------------------------------------------------------------
// parseNodeInto — merges a JSON node's attrs/children into an EXISTING model.
//
// Used for the intoRoot mode (top-level merge), overlay: true nodes, and the
// default same-name reuse path. Does NOT re-apply reserved keys (subType,
// extends, package) — those belong to the original model's identity.
// ---------------------------------------------------------------------------

function parseNodeInto(
  nodeData: Record<string, unknown>,
  target: MetaData,
  accumRoot: MetaData,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
): void {
  // FR5c — capture pre-merge state so we can decide whether this contribution
  // produced any semantic change. The "new contributor" is the file currently
  // being parsed (_currentSourceId). The "base contributor" is whichever
  // file(s) the existing target already records on its source envelope.
  const newContributorFile = _currentSourceId ?? "<unknown>";
  const targetIsRoot = target instanceof MetaRoot;
  // The root is a synthetic accumulator: it is not a metadata-author node —
  // every file declares { "metadata.root": ... } and the loader merges into
  // a single root. We don't run FR5c diagnostics on the root itself; the
  // merge attribution applies to author-meaningful nodes (object/field/etc).
  const fr5cActive = !targetIsRoot && target.name !== "";

  let preMergeShape: string | undefined;
  let preMergeAttrSnapshot: Map<string, AttrValue> | undefined;
  if (fr5cActive) {
    preMergeShape = canonicalSerialize(target);
    // Snapshot of own attrs (name → value) — used to detect ERR_MERGE_CONFLICT
    // when a new contribution sets an attr the target already declared to a
    // different non-empty value.
    // ADR-0039: own — overlay/merge machinery, operating on the AUTHORED
    // declaration layer (pre super-resolution).
    preMergeAttrSnapshot = new Map(target.ownAttrs());
  }

  // FR5c — detect attribute-level merge conflicts: for each @-prefixed inline
  // attr in nodeData, if the target already has an own attr of that name
  // with a non-empty value, AND the new value differs from the existing
  // value (both sides non-empty), emit ERR_MERGE_CONFLICT with a `format:
  // "merged"` envelope. Last-writer-wins is preserved for non-conflicting
  // cases (one side unset, same value, etc.) — those carry through to the
  // existing applyInlineAttrsAndUnknownKeys logic below.
  if (fr5cActive && preMergeAttrSnapshot !== undefined) {
    detectAttrMergeConflicts(
      target,
      nodeData,
      preMergeAttrSnapshot,
      newContributorFile,
      errors,
      path,
    );
  }

  // Apply inline attrs (not reserved keys — those stay on the existing model)
  applyInlineAttrsAndUnknownKeys(target, nodeData, strict, source, path, warnings, registry);

  // The effective package for children: use inheritedContextPkg (from the new
  // JSON's root) — not target.package, because target is the existing model
  // being merged into, and new children inherit from the NEW context.
  const effectivePkg = inheritedContextPkg;

  processChildren(target, nodeData, accumRoot, effectivePkg, registry, warnings, errors, strict, source, path);

  // FR5c — after merge: compare pre/post shape. If no semantic change → emit
  // WARN_DUPLICATE_DECLARATION (the new contribution declared the same thing
  // the target already had). If there was a change → upgrade the target's
  // source envelope to `format: "merged"` with both contributors listed
  // (ADR-0009 §Source-on-node: overlay merge with semantic change updates
  // source; duplicate-with-no-change leaves source unchanged + emits warning).
  if (fr5cActive && preMergeShape !== undefined) {
    const postMergeShape = canonicalSerialize(target);
    const preParsed = JSON.parse(preMergeShape) as Record<string, unknown>;
    const postParsed = JSON.parse(postMergeShape) as Record<string, unknown>;
    const changed = semanticDiff(preParsed, postParsed);

    // Pull the existing contributor file(s) off the target's current source
    // envelope (set at parse-fresh time or by a previous merge).
    const existing = target.source;
    const existingFiles = "files" in existing ? [...existing.files] : [];

    if (changed) {
      // Real overlay — upgrade source to merged with contributors.
      const allFiles = [...new Set([...existingFiles, newContributorFile])];
      // Alphabetical sort — matches DirectorySource ordering and gives a
      // deterministic cross-port file list (ADR-0009 §"Cross-port adoption").
      allFiles.sort();
      const contributors: Contributor[] = allFiles.map((f, i) => ({
        file: f,
        role: i === 0 ? "overlay-base" : "overlay-extension",
      }));
      const mergedSource: ErrorSource = {
        format: "merged",
        files: allFiles,
        jsonPath:
          "jsonPath" in existing && existing.jsonPath !== undefined
            ? existing.jsonPath
            : (_currentPath?.toString() ?? "$"),
        contributors,
      };
      target.setSource(mergedSource);
    } else if (
      existingFiles.length > 0 &&
      !existingFiles.includes(newContributorFile)
    ) {
      // Identical re-declaration from a different file → warn.
      const allFiles = [...new Set([...existingFiles, newContributorFile])];
      allFiles.sort();
      const contributors: Contributor[] = allFiles.map((f, i) => ({
        file: f,
        role: i === 0 ? "overlay-base" : "overlay-extension",
      }));
      const warnSource: ErrorSource = {
        format: "merged",
        files: allFiles,
        jsonPath:
          "jsonPath" in existing && existing.jsonPath !== undefined
            ? existing.jsonPath
            : (_currentPath?.toString() ?? "$"),
        contributors,
      };
      _currentEnvelopeWarnings?.push({
        code: "WARN_DUPLICATE_DECLARATION",
        message: `duplicate declaration of ${target.fqn()} with no semantic change`,
        source: warnSource,
      });
    }
  }
}

/** FR5c — for every @-prefixed inline attr in `nodeData`, check whether the
 *  target already declares the same attr (in `preAttrs`) with a different
 *  non-empty value. If so, emit ERR_MERGE_CONFLICT with a `format: "merged"`
 *  envelope naming both contributors. The merge itself proceeds (existing
 *  last-writer-wins) so the loader sees one canonical tree; the error
 *  surfaces the conflict so a consumer can fix the metadata. */
function detectAttrMergeConflicts(
  target: MetaData,
  nodeData: Record<string, unknown>,
  preAttrs: Map<string, AttrValue>,
  newContributorFile: string,
  errors: ParseError[],
  path: string,
): void {
  const existingFiles =
    "files" in target.source ? [...target.source.files] : [];

  function isEmptyValue(v: unknown): boolean {
    if (v === undefined || v === null) return true;
    if (typeof v === "string" && v === "") return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  }

  function attrValuesEqual(a: AttrValue, b: AttrValue): boolean {
    // String/number/boolean — direct compare.
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }
    if (
      typeof a === "object" && a !== null && !Array.isArray(a) &&
      typeof b === "object" && b !== null && !Array.isArray(b)
    ) {
      // Object attrs — structural compare via JSON (key order independent
      // through Object.keys().sort()).
      try {
        const ak = Object.keys(a).sort();
        const bk = Object.keys(b).sort();
        if (ak.length !== bk.length) return false;
        for (let i = 0; i < ak.length; i++) {
          if (ak[i] !== bk[i]) return false;
          if (JSON.stringify((a as Record<string, unknown>)[ak[i]!]) !==
              JSON.stringify((b as Record<string, unknown>)[bk[i]!])) {
            return false;
          }
        }
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  for (const key of Object.keys(nodeData)) {
    if (!key.startsWith(ATTR_PREFIX)) continue;
    if (RESERVED_KEYS.has(key)) continue;
    const attrName = key.slice(ATTR_PREFIX.length);
    if (RESERVED_KEYS.has(attrName)) continue;

    const newValRaw = nodeData[key];
    const existingVal = preAttrs.get(attrName);

    if (existingVal === undefined) continue;
    if (isEmptyValue(newValRaw) || isEmptyValue(existingVal)) continue;
    // Both sides set a non-empty value — compare. If equal, last-writer-wins
    // is a no-op; if different, that's a conflict.
    if (attrValuesEqual(existingVal, newValRaw as AttrValue)) continue;

    const allFiles = [...new Set([...existingFiles, newContributorFile])];
    allFiles.sort();
    const contributors: Contributor[] = allFiles.map((f, i) => ({
      file: f,
      role: i === 0 ? "overlay-base" : "overlay-extension",
    }));
    const conflictSource: ErrorSource = {
      format: "merged",
      files: allFiles,
      jsonPath: `${_currentPath?.toString() ?? path}.${ATTR_PREFIX}${attrName}`,
      contributors,
    };
    errors.push(
      new ParseError(
        `attr '${ATTR_PREFIX}${attrName}' conflicts: existing value ` +
          `${JSON.stringify(existingVal)} differs from new value ` +
          `${JSON.stringify(newValRaw)} on ${target.fqn()}`,
        { code: "ERR_MERGE_CONFLICT", source: conflictSource },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// createOrFindMetaData — per-node merge logic.
//
//   overlay: true → find-or-throw (throw if no existing same-(type,name) child)
//   default       → find-or-create (silently reuse if found)
// ---------------------------------------------------------------------------

function createOrFindMetaData(
  type: string,
  subType: string,
  nodeData: Record<string, unknown>,
  parent: MetaData,
  accumRoot: MetaData,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
): MetaData | undefined {
  // Only `overlay: true` re-opens an existing node. Anything else falls through
  // to the default reuse-or-create path.
  const isOverlayNode = nodeData[RESERVED_KEY_OVERLAY] === true;

  // Determine name (needed for the lookup). Lookup key is (type, name).
  const rawName = nodeData[RESERVED_KEY_NAME];
  const name = typeof rawName === "string" ? rawName : "";

  // Look up an existing child with (type, name). Skip unnamed nodes — they
  // are always distinct (e.g. inline validators, anonymous attrs).
  // ADR-0039: own — overlay/merge lookup on the AUTHORED declaration layer
  // (an overlay targets a same-file/same-node own child, pre super-resolution).
  //
  // ROOT-LEVEL lookups are PACKAGE-QUALIFIED: two files declaring the same
  // (type, name) under different packages are DISTINCT root nodes, never a
  // merge pair (mirrors the Java parser, which searches root children by
  // "pkg::name"). Nested children stay bare-name matched — they are scoped
  // by their parent, and packages don't disambiguate siblings inside a node.
  let existing = name !== "" ? parent.ownChildByTypeAndName(type, name) : undefined;
  if (existing !== undefined && parent instanceof MetaRoot) {
    const candidateKey = rootChildResolutionKey(nodeData, inheritedContextPkg, name);
    if (existing.resolutionKey() !== candidateKey) {
      // The first same-name hit is a different package — scan for an exact
      // package-qualified match (several packages may declare this name).
      existing = parent
        .ownChildren()
        .find((c) => c.type === type && c.name === name && c.resolutionKey() === candidateKey);
    }
  }

  if (isOverlayNode) {
    if (existing === undefined) {
      throw new ParseError(
        `Overlay operation requested for [${type}:${name}] but no existing metadata found to merge into`,
        { code: "ERR_OVERLAY_NO_TARGET", source: errSource() },
      );
    }
    existing.setIsMerge(true);
    parseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, registry, warnings, errors, strict, source, path);
    return existing;
  }

  // Default: no operator → silently reuse existing or create new.
  if (existing !== undefined) {
    parseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, registry, warnings, errors, strict, source, path);
    return existing;
  }

  // Not found (or unnamed) → create new
  return parseNodeFresh(type, subType, nodeData, accumRoot, inheritedContextPkg, registry, warnings, errors, strict, source, path, parent.type, parent);
}

// ---------------------------------------------------------------------------
// applyReservedKeys — apply package, extends, abstract, isArray to a model.
//
// Called only when CREATING a new model (not when merging into existing).
// ---------------------------------------------------------------------------

function applyReservedKeys(
  model: MetaData,
  nodeData: Record<string, unknown>,
  strict: boolean,
  source: string | undefined,
  path: string,
  warnings: string[],
  contextPkg?: string,
): void {
  // package
  const rawPkg = nodeData[RESERVED_KEY_PACKAGE];
  if (rawPkg !== undefined) {
    if (typeof rawPkg !== "string") {
      reportProblem(`"${RESERVED_KEY_PACKAGE}" must be a string at ${path}`, strict, warnings, "ERR_BAD_ATTR_VALUE");
    } else {
      const expandedPkg = contextPkg !== undefined ? expandPackageForPath(contextPkg, rawPkg) : rawPkg;
      model.setPackage(expandedPkg);
    }
  }

  // extends — store the raw supertype ref; resolution happens after this call.
  const rawExtends = nodeData[RESERVED_KEY_EXTENDS];
  if (rawExtends !== undefined) {
    if (typeof rawExtends !== "string") {
      reportProblem(`"${RESERVED_KEY_EXTENDS}" must be a string at ${path}`, strict, warnings, "ERR_UNRESOLVED_SUPER");
    } else {
      // FR-032: canonical JSON `extends` must be FQN; reject a surviving
      // relative form (no-op for YAML-format input, which was desugar-expanded).
      guardRelativeRefInCanonical(`"${RESERVED_KEY_EXTENDS}"`, rawExtends, strict, warnings, path);
      model.setSuper(rawExtends);
    }
  }

  // abstract — structural key (true → abstract node)
  const rawAbstract = nodeData[RESERVED_KEY_ABSTRACT];
  if (rawAbstract !== undefined) {
    if (typeof rawAbstract !== "boolean") {
      reportProblem(`"${RESERVED_KEY_ABSTRACT}" must be a boolean at ${path}`, strict, warnings, "ERR_BAD_ATTR_VALUE");
    } else {
      model.setIsAbstract(rawAbstract);
    }
  }

  // isArray — structural key (true → array node)
  const rawIsArray = nodeData[RESERVED_KEY_IS_ARRAY];
  if (rawIsArray !== undefined) {
    if (typeof rawIsArray !== "boolean") {
      reportProblem(`"${RESERVED_KEY_IS_ARRAY}" must be a boolean at ${path}`, strict, warnings, "ERR_BAD_ATTR_VALUE");
    } else {
      model.setIsArray(rawIsArray);
    }
  }
}

// ---------------------------------------------------------------------------
// applyInlineAttrsAndUnknownKeys — apply @-prefixed attrs and warn about unknowns
//
// Called for both fresh creates AND merge-into-existing paths.
// Does NOT process reserved structural keys.
// ---------------------------------------------------------------------------

function applyInlineAttrsAndUnknownKeys(
  model: MetaData,
  nodeData: Record<string, unknown>,
  strict: boolean,
  source: string | undefined,
  path: string,
  warnings: string[],
  registry: TypeRegistry,
): void {
  for (const key of Object.keys(nodeData)) {
    // Skip all reserved structural keys (already handled or intentionally ignored)
    if (RESERVED_KEYS.has(key)) continue;

    if (!key.startsWith(ATTR_PREFIX)) {
      const displayName =
        model.name !== "" ? `${model.type}.${model.subType} '${model.name}'` : `${model.type}.${model.subType}`;
      reportProblem(
        `Unknown key '${key}' on ${displayName} at ${path} (must be reserved or ${ATTR_PREFIX}-prefixed)`,
        strict, warnings, "ERR_UNKNOWN_ATTR",
      );
      continue;
    }

    // Inline attribute (@-prefixed) — materialize into a MetaAttr instance.
    const attrName = key.slice(ATTR_PREFIX.length);

    // Reserved structural keys (name/package/extends/abstract/overlay/isArray
    // /children/value) must NOT be @-prefixed — they're written bare. An
    // @-prefixed reserved word is always a metadata-author error (e.g.
    // "@isArray" instead of bare "isArray") and is reported as a hard error
    // regardless of strict mode so downstream code never sees a bogus
    // MetaAttr named after a reserved word.
    if (RESERVED_KEYS.has(attrName)) {
      const displayName =
        model.name !== "" ? `${model.type}.${model.subType} '${model.name}'` : `${model.type}.${model.subType}`;
      const msg =
        `Reserved structural key '${attrName}' must not be ${ATTR_PREFIX}-prefixed ` +
        `on ${displayName} at ${path} (write it bare)`;
      if (strict) {
        throw new ParseError(msg, { code: "ERR_RESERVED_ATTR", source: errSource() });
      }
      // Lax mode: route through the module-level errors sink so the loader
      // sees this as a hard error (parity with attr-schema-validate's
      // ERR_BAD_ATTR_VALUE direct pushes). Falls back to warnings only if
      // _currentErrors isn't bound (unreachable when called from buildTree).
      if (_currentErrors !== undefined) {
        _currentErrors.push(new ParseError(msg, { code: "ERR_RESERVED_ATTR", source: errSource() }));
      } else {
        warnings.push(msg);
      }
      continue;
    }

    const rawVal = nodeData[key];

    // FR-032: a ref-bearing inline attr (@objectRef/@references/@from/@of/@via/
    // @parameterRef/@payloadRef/@responseRef) in canonical JSON must be FQN —
    // reject a surviving relative form. No-op for YAML-format input.
    if (REF_BEARING_ATTR_NAMES.has(attrName)) {
      guardRelativeRefInCanonical(`${ATTR_PREFIX}${attrName}`, rawVal, strict, warnings, path);
    }

    try {
      const attr = materializeAttr(model, attrName, rawVal, registry);
      model.setMetaAttr(attr);
    } catch (err) {
      reportProblem(
        `Failed to convert attribute "${ATTR_PREFIX}${attrName}" at ${path}: ${(err as Error).message}`,
        strict, warnings, "ERR_BAD_ATTR_VALUE",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// materializeAttr — build a single attr into the right MetaAttr subclass:
// declared subtype from the owner's AttrSchema (if any), else inferred from the
// value shape. The instance coerces + desugars its own value.
// ---------------------------------------------------------------------------

function materializeAttr(
  owner: MetaData,
  attrName: string,
  rawVal: unknown,
  registry: TypeRegistry,
): MetaAttr {
  // Resolve attr spec: per-type attrs take precedence over common attrs.
  // Common attrs are consulted as a fallback so they get the correct MetaAttr
  // subclass (and thus the right coerce/validateValue) at parse time.
  const perTypeSpec = registry.attrsOf(owner.type, owner.subType).find((s) => s.name === attrName);
  const attrSpec = perTypeSpec ?? registry.getCommonAttrs().find((s) => s.name === attrName);
  let subType: string;
  if (attrSpec !== undefined && attrSpec.isArray === true) {
    // An array-flagged attr (`string` + `isArray`): array-ness is the orthogonal
    // axis the `stringarray` subtype was retired in favor of. Coerce through the
    // array string-attr class (bare-string → one-element array) keyed off the
    // retired-as-a-subtype-but-kept-as-a-coercion `stringarray` class-map entry.
    subType = ATTR_SUBTYPE_STRINGARRAY;
  } else if (attrSpec !== undefined && attrSpec.valueType !== undefined) {
    subType = attrSpec.valueType;
  } else {
    // Undeclared or declared-but-untyped (@default): preserve the author's shape.
    subType = inferUndeclaredAttrSubType(rawVal);
  }
  // The array-coercion class is no longer a registered (attr, subType); resolve
  // it through the dependency-free attr-class-map (which still carries it).
  const def = subType === ATTR_SUBTYPE_STRINGARRAY ? undefined : registry.find(TYPE_ATTR, subType);
  const Ctor = subType === ATTR_SUBTYPE_STRINGARRAY ? attrClassFor(subType) : undefined;
  const node = (Ctor !== undefined
    ? new Ctor(new TypeId(TYPE_ATTR, subType), attrName)
    : def !== undefined
      ? def.factory(def.typeId, attrName)
      : new MetaAttr(new TypeId(TYPE_ATTR, subType), attrName)) as MetaAttr;
  const coerced = node.coerce(rawVal);
  const desugared = node.desugar(coerced);
  node.setAttr(RESERVED_KEY_VALUE, desugared);
  return node;
}

// Undeclared attr → pick the subtype from the value's runtime shape, preserving
// type (a numeric string stays string). Wraps inferAttrSubType (scalar/array
// rule, incl. the int/long/double range split) with the object + null-reject
// branches that predate object attrs: a plain object → properties; null /
// undefined are not valid undeclared attr values.
function inferUndeclaredAttrSubType(raw: unknown): string {
  if (raw === null || raw === undefined) {
    throw new Error(`${raw === null ? "null" : "undefined"} is not a valid attr value`);
  }
  if (typeof raw === "object" && !Array.isArray(raw)) return ATTR_SUBTYPE_PROPERTIES;
  return inferAttrSubType(raw as AttrValue);
}

// ---------------------------------------------------------------------------
// processChildren — parse the "children" array of a node
// ---------------------------------------------------------------------------

function processChildren(
  parent: MetaData,
  nodeData: Record<string, unknown>,
  accumRoot: MetaData,
  inheritedContextPkg: string,
  registry: TypeRegistry,
  warnings: string[],
  errors: ParseError[],
  strict: boolean,
  source: string | undefined,
  path: string,
): void {
  const rawChildren = nodeData[RESERVED_KEY_CHILDREN];
  if (rawChildren === undefined) return;

  if (!Array.isArray(rawChildren)) {
    reportProblem(`"${RESERVED_KEY_CHILDREN}" must be an array at ${path}`, strict, warnings, "ERR_TOP_LEVEL_NOT_OBJECT");
    return;
  }

  // FR5a — push the "children" segment once; each iteration pushes/pops a
  // numeric index + the wrapper-key segment so nested nodes see the correct
  // jsonPath when populateNodeSource() is called during their construction.
  _currentPath?.pushKey(RESERVED_KEY_CHILDREN);

  for (let i = 0; i < rawChildren.length; i++) {
    const childEntry = rawChildren[i];
    const childPath = `${path}.${RESERVED_KEY_CHILDREN}[${i}]`;
    _currentPath?.pushIndex(i);

    if (typeof childEntry !== "object" || childEntry === null || Array.isArray(childEntry)) {
      reportProblem(`Child at ${childPath} must be an object`, strict, warnings, "ERR_TOP_LEVEL_NOT_OBJECT");
      _currentPath?.pop();
      continue;
    }

    const childRecord = childEntry as Record<string, unknown>;
    const childKeys = Object.keys(childRecord);

    if (childKeys.length !== 1) {
      const msg =
        childKeys.length === 0
          ? `Child at ${childPath} has no type wrapper key`
          : `Child at ${childPath} has multiple keys (${childKeys.join(", ")}) — each child must have exactly one wrapper key`;
      reportProblem(msg, strict, warnings, "ERR_TOP_LEVEL_NOT_OBJECT");
      _currentPath?.pop();
      continue;
    }

    const childKey = childKeys[0]!;
    const childData = childRecord[childKey];
    const childNodePath = `${childPath}.${childKey}`;
    _currentPath?.pushKey(childKey);
    // FR5b — set the current node's YAML position (if any) before the
    // create/merge call. Save the parent's position to restore after the
    // recursion returns (children may push deeper positions during their
    // own processChildren walk).
    const savedYamlPosition = _currentYamlPosition;
    if (_currentFormat === "yaml") {
      _currentYamlPosition = getYamlPosition(childRecord, childKey);
    }

    if (typeof childData !== "object" || childData === null || Array.isArray(childData)) {
      reportProblem(
        `Child wrapper "${childKey}" at ${childNodePath} must contain an object`,
        strict, warnings, "ERR_TOP_LEVEL_NOT_OBJECT",
      );
      _currentPath?.pop(); // pop child wrapper key
      _currentPath?.pop(); // pop array index
      _currentYamlPosition = savedYamlPosition; // FR5b — restore parent's pos
      continue;
    }

    const childDataObj = childData as Record<string, unknown>;
    const { type: childType, subType: childSubTypeRaw, explicit } = splitTypeKey(childKey, registry);

    let childSubType = childSubTypeRaw;
    // A `<type>.base` may not be AUTHORED, and a bare key for a type with no declared default
    // is a MISSING subType. BEFORE the registered-type check below, matching the root door and
    // the JVM: run it after, and a bare key for a type that registers no `base` at all
    // (identity, index, requirement) falls into that check's else-arm first and is reported as
    // an UNKNOWN TYPE — a message asserting the type does not exist, about a type that does,
    // with its name mangled to `"identity."`. Order is the whole rule here.
    if ((childSubType === SUBTYPE_BASE && isAbstractAnchorFor(childType, registry))
      || (!explicit && childSubType === "")) {
      errors.push(
        explicit
          ? new ParseError(abstractSubtypeMessage(childType), {
              code: "ERR_ABSTRACT_SUBTYPE_AUTHORED",
              source: errSource(),
            })
          : new ParseError(missingSubtypeMessage(childType), {
              code: "ERR_MISSING_SUBTYPE",
              source: errSource(),
            }),
      );
      _currentPath?.pop(); // pop child wrapper key
      _currentPath?.pop(); // pop array index
      _currentYamlPosition = savedYamlPosition; // FR5b — restore parent's pos
      continue; // skip this child
    }

    // --- Check if this child type is registered ---
    // An EXPLICIT unknown subType (fused into the key) is an error — never
    // silently downgraded to base. An OMITTED subType that resolves to an
    // unregistered default falls back to base.
    if (!registry.has(childType, childSubType)) {
      if (!explicit && registry.has(childType, SUBTYPE_BASE)) {
        childSubType = SUBTYPE_BASE;
      } else {
        const childTypeCode = explicit && registry.allSubTypesOf(childType).length > 0
          ? "ERR_UNKNOWN_SUBTYPE" as const
          : "ERR_UNKNOWN_TYPE" as const;
        // #337: a subtype we RETIRED (origin.collection) gets its retirement and its
        // migration, not a bare "not registered" that reads like a broken install.
        const retiredChild = retiredSubType(childType, childSubType);
        errors.push(
          new ParseError(
            `Unknown type "${childType}.${childSubType}" — ` +
              (retiredChild !== undefined ? retirementHint(retiredChild) : "not registered"),
            { code: childTypeCode, source: errSource() },
          ),
        );
        _currentPath?.pop(); // pop child wrapper key
        _currentPath?.pop(); // pop array index
        _currentYamlPosition = savedYamlPosition; // FR5b — restore parent's pos
        continue; // skip this child
      }
    }

    // A `<type>.base` child may not be AUTHORED — the CHILD door (the root door is above).
    // Gated on `explicit`, deliberately: `base` is also this parser's fallback for an
    // OMITTED subtype whose registry default is unregistered (the branch directly above),
    // and refusing that would break every node relying on the default. Placed before the
    // attr branch so `attr.base` is covered by the same rule — an authored untyped attr is
    // the same mistake as an authored untyped field.
    // --- Special handling for "attr" child nodes ---
    if (childType === TYPE_ATTR) {
      parseAttrChild(parent, childType, childSubType, childDataObj, registry, warnings, strict, source, childNodePath);
    } else {
      // Use createOrFindMetaData to handle overlay/default per-node logic
      const childModel = createOrFindMetaData(
        childType,
        childSubType,
        childDataObj,
        parent,
        accumRoot,
        inheritedContextPkg,
        registry,
        warnings,
        errors,
        strict,
        source,
        childNodePath,
      );

      // ADR-0039: own — tree-building dedup on the AUTHORED declaration layer.
      if (childModel !== undefined && !parent.ownChildren().includes(childModel)) {
        parent.addChild(childModel);
      }
    }
    _currentPath?.pop(); // pop child wrapper key
    _currentPath?.pop(); // pop array index
    _currentYamlPosition = savedYamlPosition; // FR5b — restore parent's pos
  }
  _currentPath?.pop(); // pop the "children" key
}

// ---------------------------------------------------------------------------
// Attr child node — materialize into a MetaAttr instance (NOT a child).
// ---------------------------------------------------------------------------
//
// A typed attr is encoded as { "attr.<subType>": { "name": ..., "value": ... } }
// inside a node's children array. The subType is fused into the wrapper key.
//
// The instance coerces + desugars toward its OWN subtype (the wrapper key's
// subType, e.g. attr.stringarray) — StringArrayAttr.coerce wraps the bare
// string, FilterAttr.desugar normalizes. The attr is attached via setMetaAttr,
// never addChild: attrs are no longer structural children (D2/D5).

function parseAttrChild(
  parent: MetaData,
  attrType: string,
  attrSubType: string,
  attrData: Record<string, unknown>,
  registry: TypeRegistry,
  warnings: string[],
  strict: boolean,
  source: string | undefined,
  path: string,
): void {
  const attrName = attrData[RESERVED_KEY_NAME];
  const attrValue = attrData[RESERVED_KEY_VALUE];

  if (typeof attrName !== "string" || attrName === "") {
    reportProblem(
      `attr child at ${path} requires a non-empty "${RESERVED_KEY_NAME}" string`,
      strict, warnings, "ERR_MISSING_REQUIRED_ATTR",
    );
    return;
  }

  if (attrValue === undefined) {
    reportProblem(
      `attr child "${attrName}" at ${path} is missing "${RESERVED_KEY_VALUE}"`,
      strict, warnings, "ERR_MISSING_REQUIRED_ATTR",
    );
    return;
  }

  // Resolve the attr node's own subtype (fall back to base if unregistered).
  const resolvedSubType =
    registry.has(attrType, attrSubType) || !registry.has(attrType, SUBTYPE_BASE)
      ? attrSubType
      : SUBTYPE_BASE;
  const attrDef = registry.find(attrType, resolvedSubType);

  const node = (attrDef !== undefined
    ? attrDef.factory(attrDef.typeId, attrName)
    : new MetaAttr(new TypeId(attrType, resolvedSubType), attrName)) as MetaAttr;

  try {
    const coerced = node.coerce(attrValue);
    const desugared = node.desugar(coerced);
    node.setAttr(RESERVED_KEY_VALUE, desugared);
  } catch (err) {
    reportProblem(
      `Failed to convert attr child "${attrName}" value at ${path}: ${(err as Error).message}`,
      strict, warnings, "ERR_BAD_ATTR_VALUE",
    );
    return;
  }

  parent.setMetaAttr(node);
}
