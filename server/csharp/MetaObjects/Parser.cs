// Registry-driven canonical JSON parser.
//
// Ported from:
//   typescript/packages/metadata/src/parser-json.ts  (BOM strip + JSON.parse front-end)
//   typescript/packages/metadata/src/parser-core.ts  (the shared buildTree pipeline)
//
// buildTree() turns a canonical-shaped JSON document into a typed MetaData tree.
//
// Node encoding: every node is a single-key map { "<type>.<subType>": <body> }.
// The wrapper key FUSES type and subType into one dotted token (object.entity,
// field.long, metadata.root). The body is a map of reserved structural keys
// (name/package/extends/abstract/overlay/isArray/children), `@`-prefixed
// attributes, and the children list.
//
// PROVIDER-DRIVEN INVARIANT: the parser never branches on a concrete type name.
// Every type/subtype decision goes through opts.Registry. The only metamodel
// strings referenced are the structural reserved keys/separators in Constants
// plus the four type names parser-core.ts itself special-cases
// (TYPE_ATTR / TYPE_FIELD / TYPE_OBJECT / TYPE_VALIDATOR).

using System.Text.Json;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Source;

namespace MetaObjects;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// <summary>
/// Options controlling a parse run. Mirrors the TS <c>ParseOptions</c> interface.
/// </summary>
public sealed class ParseOptions(TypeRegistry registry)
{
    /// <summary>Registry — types must be registered.</summary>
    public TypeRegistry Registry { get; } = registry;

    /// <summary>Throw on parsing problems? Default false.</summary>
    public bool Strict { get; init; }

    /// <summary>For error messages, e.g. "fishstore.json".</summary>
    public string? SourceName { get; init; }

    /// <summary>
    /// Loader's accumulating root. If provided, parse merges nodes into it.
    /// If null, creates a new root from the JSON's root node.
    /// </summary>
    public MetaRoot? IntoRoot { get; init; }

    /// <summary>
    /// If true, super refs that don't resolve at parse time are NOT a parse error;
    /// the model retains its raw <c>SuperRef</c> and a second pass resolves them
    /// after all input files are parsed.
    /// </summary>
    public bool DeferSuperResolution { get; init; }

    /// <summary>
    /// FR5b — source-format discriminant. Default <see cref="MetaDataFormat.Json"/>;
    /// <see cref="ParserYaml.ParseYaml"/> sets this to <see cref="MetaDataFormat.Yaml"/>
    /// so the parser stamps <c>yamlPosition</c> on <c>source</c> envelopes when
    /// <see cref="YamlPositionsByPath"/> has a position for the current canonical JSONPath.
    /// </summary>
    public MetaDataFormat SourceFormat { get; init; } = MetaDataFormat.Json;

    /// <summary>
    /// FR5b — flat JSONPath-keyed map of YAML positions, populated by ParserYaml
    /// from the desugar's per-node position maps. Null when parsing JSON.
    /// </summary>
    public IReadOnlyDictionary<string, YamlPosition>? YamlPositionsByPath { get; init; }
}

/// <summary>The result of a parse run.</summary>
/// <param name="EnvelopeWarnings">
/// FR5c — envelope-shaped warnings (e.g. <c>WARN_DUPLICATE_DECLARATION</c>)
/// produced during the parse/merge pipeline. Distinct from the legacy
/// <see cref="Warnings"/> string channel: those messages get wrapped in a
/// <c>WARN_LEGACY</c> envelope at the loader boundary, while envelope warnings
/// already carry their own code + source and are surfaced unchanged. Defaults
/// to an empty list when no envelope warnings were emitted.
/// </param>
public sealed record ParseResult(
    MetaRoot Root,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<MetaError> Errors,
    IReadOnlyList<LoaderWarning>? EnvelopeWarnings = null);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/// <summary>
/// The registry-driven canonical JSON parser. Entry point: <see cref="ParseJson"/>.
/// </summary>
public static class Parser
{
    // -----------------------------------------------------------------------
    // parseJson — thin front-end (BOM strip + JSON parse + buildTree)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Parse a canonical JSON metadata document into a typed MetaData tree.
    /// </summary>
    /// <exception cref="ParseException">
    /// On malformed JSON (<see cref="ErrorCode.ERR_MALFORMED_JSON"/>) or a
    /// top-level structural failure the TS parser also throws on.
    /// </exception>
    public static ParseResult ParseJson(string content, ParseOptions opts)
    {
        // Strip UTF-8 BOM if present (Java-authored files often have it).
        string normalized = content.Length > 0 && content[0] == '﻿'
            ? content[1..]
            : content;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(normalized);
        }
        catch (JsonException err)
        {
            // FR5a / ADR-0009: pre-BuildTree errors can't reach the parser's
            // per-run JsonPathBuilder (BuildTree hasn't started yet); build a
            // minimal $-rooted JsonSource envelope so cross-port callers see a
            // consistent shape. Mirrors TS parser-json.ts:25-29.
            var envelope = new JsonSource(
                new[] { opts.SourceName ?? "<unknown>" },
                "$");
            throw new ParseException(
                $"Invalid JSON: {err.Message}",
                ErrorCode.ERR_MALFORMED_JSON,
                opts.SourceName,
                "$",
                envelope);
        }

        // The JsonDocument must stay alive while buildTree walks it.
        using (document)
        {
            return BuildTree(document.RootElement, opts);
        }
    }

    // -----------------------------------------------------------------------
    // Internal parse state — carried through the recursion instead of a long
    // parameter list. Holds the immutable run config + mutable warning/error
    // accumulators. _deferSuperResolution is part of this state (no module-level
    // mutable flag, unlike the TS).
    // -----------------------------------------------------------------------

    private sealed class ParseState
    {
        public required TypeRegistry Registry { get; init; }
        public required bool Strict { get; init; }
        public required string? Source { get; init; }
        public required bool DeferSuperResolution { get; init; }
        /// <summary>FR5b — source-format discriminant (set from <see cref="ParseOptions"/>).</summary>
        public required MetaDataFormat SourceFormat { get; init; }
        /// <summary>FR5b — JSONPath-keyed YAML position lookup (set when parsing YAML input).</summary>
        public required IReadOnlyDictionary<string, YamlPosition>? YamlPositionsByPath { get; init; }
        public List<string> Warnings { get; } = new();
        public List<MetaError> Errors { get; } = new();
        /// <summary>
        /// FR5c — envelope-shaped warnings (e.g. <c>WARN_DUPLICATE_DECLARATION</c>)
        /// emitted during the merge phase. Distinct from the legacy
        /// <see cref="Warnings"/> string channel: these already carry their own
        /// code + source.
        /// </summary>
        public List<LoaderWarning> EnvelopeWarnings { get; } = new();
        /// <summary>FR5a / ADR-0009 — canonical JSONPath of the currently-walked node.</summary>
        public JsonPathBuilder Builder { get; } = new();

        /// <summary>
        /// Build the source envelope for the current location.
        /// When <see cref="Source"/> is null (parser invoked without a source id,
        /// e.g. from a string buffer in tests), fall back to <see cref="CodeSource"/>
        /// — emitting a JsonSource with an empty file list would violate the
        /// FR5a length-1 invariant and produce an envelope shape no other port
        /// emits. Matches the TS reference (parser-core.ts:104-114).
        ///
        /// <para>
        /// FR5b finalized 2026-05-27 — when <see cref="SourceFormat"/> is
        /// <see cref="MetaDataFormat.Yaml"/>, emits a <see cref="YamlSource"/>
        /// (format <c>"yaml"</c>) carrying the optional <see cref="YamlPosition"/>
        /// when the desugar's position map covers the current JSONPath. Otherwise
        /// emits a <see cref="JsonSource"/>.
        /// </para>
        /// </summary>
        public ErrorSource CurrentSource()
        {
            if (Source is null) return CodeSource.Default;
            string path = Builder.ToString();
            if (SourceFormat == MetaDataFormat.Yaml)
            {
                YamlPosition? pos = null;
                if (YamlPositionsByPath is not null &&
                    YamlPositionsByPath.TryGetValue(path, out YamlPosition? found))
                {
                    pos = found;
                }
                return new YamlSource(new[] { Source }, path, pos);
            }
            return new JsonSource(new[] { Source }, path);
        }
    }

    // -----------------------------------------------------------------------
    // reportProblem — throw in strict mode, push warning otherwise
    // -----------------------------------------------------------------------

    private static void ReportProblem(
        string msg,
        ParseState st,
        ErrorCode? code = null)
    {
        if (st.Strict)
        {
            throw new ParseException(
                msg,
                code ?? ErrorCode.ERR_UNKNOWN,
                st.Source,
                st.Builder.ToString(),
                st.CurrentSource());
        }
        st.Warnings.Add(msg);
    }

    // -----------------------------------------------------------------------
    // FR-032 (ADR-0032) — relative-ref guard for canonical JSON.
    //
    // The bare (sigil-free) inline attribute names whose VALUE is a metadata
    // reference. In canonical JSON these are @-prefixed (@objectRef, …). Mirrors
    // YamlDesugar.RefBearingAttrNames + the Java/TS REF_BEARING_ATTR_NAMES. The
    // structural `extends` key is a reference too, but is guarded separately (it
    // is the bare RESERVED_KEY_EXTENDS body key, not an @-prefixed attr).
    // -----------------------------------------------------------------------

    private static readonly HashSet<string> RefBearingAttrNames = new(StringComparer.Ordinal)
    {
        "objectRef", "references", "from", "of", "via",
        "payloadRef", "responseRef", "parameterRef",
        "through", // ADR-0042: the M:N junction ref joins the desugar+resolution set.
    };

    /// <summary>
    /// FR-032 (ADR-0032) — guard a ref-bearing value against relative forms.
    /// Canonical JSON is the self-contained interchange form: every ref-bearing
    /// attribute MUST be fully qualified. A relative authoring form (leading
    /// <c>::</c> or <c>..::</c>) surviving into canonical JSON is
    /// <see cref="ErrorCode.ERR_RELATIVE_REF_IN_CANONICAL"/>. The C# canonical
    /// parser only ever handles canonical JSON (the YAML desugar expands these
    /// forms before the parser sees them), so no format check is needed. Throwing
    /// halts the parse so exactly one error is produced, mirroring the
    /// <see cref="ErrorCode.ERR_RESERVED_ATTR"/> rejection style.
    /// </summary>
    private static void GuardRelativeRefInCanonical(string refLabel, string? rawValue, ParseState st)
    {
        if (rawValue is null) return;
        string parentPrefix = PACKAGE_PARENT + PACKAGE_SEPARATOR; // "..::"
        if (!rawValue.StartsWith(PACKAGE_SEPARATOR, StringComparison.Ordinal)
            && !rawValue.StartsWith(parentPrefix, StringComparison.Ordinal))
        {
            return;
        }
        string path = st.Builder.ToString();
        string msg =
            $"relative reference '{rawValue}' on {refLabel} at {path} is not allowed in " +
            $"canonical JSON — canonical JSON must be fully-qualified. Relative forms " +
            $"(leading '{PACKAGE_SEPARATOR}' or '{parentPrefix}') are YAML-authoring sugar " +
            $"that the desugar expands.";
        throw new ParseException(
            msg, ErrorCode.ERR_RELATIVE_REF_IN_CANONICAL, st.Source, path, st.CurrentSource());
    }

    // -----------------------------------------------------------------------
    // splitTypeKey — split a fused wrapper key into (type, subType, explicit).
    //
    // Canonical JSON always writes the full type.subType. An omitted subType
    // (bare type key, no ".") resolves to the type's registry default.
    // -----------------------------------------------------------------------

    private readonly record struct SplitKey(string Type, string SubType, bool Explicit);

    /// <summary>
    /// The subType a BARE wrapper key (<c>{"object": …}</c>) resolves to: the type's DECLARED
    /// default, or <c>null</c> when it declares none.
    /// <para>
    /// <see cref="TypeRegistry.DefaultSubTypeOf"/> is the same accessor the YAML desugar
    /// consults, and the shared corpus already pins the contract
    /// (<c>fixtures/yaml-conformance/yaml-bare-default-subtypes</c>: bare <c>object:</c>
    /// becomes <c>object.entity</c>). This used to GUESS instead — <c>AllSubTypesOf()[0]</c>,
    /// i.e. registration order, falling back to <c>base</c> — so the two layers answered the
    /// same question two different ways, and registration order put the abstract anchor first.
    /// A name resolved twice by two different functions is a name that can disagree with
    /// itself.
    /// </para>
    /// </summary>
    private static string? DefaultSubTypeFor(string type, TypeRegistry registry) =>
        registry.DefaultSubTypeOf(type);

    // The one message for an authored `<type>.base`, so both doors say the same thing.
    //
    // Every registered `base` subtype is an ABSTRACT REGISTRY ANCHOR: the shared root that
    // concrete subtypes inherit their attrs and child rules from. It has no runtime
    // semantics and no concrete representation — spec/metamodel/object.json says so in as
    // many words ("Has no runtime semantics of its own; not authored directly"), and every
    // `base` entry's description opens with "Abstract".
    //
    // The JVM enforced this by accident (its impl classes are `public abstract`, so
    // instantiation fails); TypeScript, C# and Python accepted it. The same document
    // therefore loaded on three ports and failed to load on two — the cross-port
    // conformance gap the corpora exist to catch, and it survived because every `*.base`
    // subtype sits in the registry corpus's own `untestedSubTypes` list.
    /// <summary>
    /// Is <c>&lt;type&gt;.base</c> an ABSTRACT ANCHOR for this type — i.e. does the type
    /// register at least one OTHER subtype for it to anchor?
    /// <para>
    /// Registry-driven, not name-driven, and the distinction is load-bearing. All ten core
    /// anchors have concrete siblings (<c>object.base</c> beside entity/value/projection,
    /// <c>source.base</c> beside rdb, …), so the rule catches every one. A third-party
    /// provider may register <c>base</c> as a type's ONLY member, and there it anchors
    /// nothing: refusing it would leave the type unauthorable, a capability removal the
    /// contract never asked for. The manifest describes the CORE registry; this is how that
    /// scope is expressed without hardcoding the core's type list.
    /// </para>
    /// </summary>
    private static bool IsAbstractAnchorFor(string type, TypeRegistry registry) =>
        registry.AllSubTypesOf(type).Any(sub => sub != SUBTYPE_BASE);

    private static string AbstractSubtypeMessage(string type) =>
        $"\"{type}.{SUBTYPE_BASE}\" may not be authored — every \"{SUBTYPE_BASE}\" subtype " +
        "is an abstract registry anchor that concrete subtypes inherit from, with no " +
        $"runtime semantics of its own. Declare a concrete {type} subtype instead.";

    // The same rule reached by the OTHER spelling: a BARE wrapper key (`{"field": …}`, no
    // fused subType) whose registry default resolves to the abstract anchor. The author did
    // not type `.base`, so this is a MISSING subtype rather than an authored-anchor error —
    // and ERR_MISSING_SUBTYPE is the shared code already chartered for it ("a node omits
    // subType and the type has no default subType").
    //
    // Python has always emitted it here; C#, TypeScript and the JVM did not, so a bare key
    // was a SECOND way one document got two verdicts: C# and TS resolved it to the anchor and
    // loaded, the JVM resolved it identically and then failed to instantiate. Closing the
    // authored spelling alone would have left the rule half true, reachable by dropping four
    // characters.
    //
    // Scoped to "the default IS the anchor", never to bare keys as such: a type that declares
    // a CONCRETE default keeps resolving through it.
    private static string MissingSubtypeMessage(string type) =>
        $"type \"{type}\" has no default subType; write the full \"{type}.<subType>\"";

    private static SplitKey SplitTypeKey(string key, TypeRegistry registry)
    {
        int dotIdx = key.IndexOf(TYPE_SUBTYPE_SEPARATOR, StringComparison.Ordinal);
        if (dotIdx < 0)
        {
            // Bare type, no fused subType — resolve via the registry default.
            return new SplitKey(key, DefaultSubTypeFor(key, registry) ?? "", false);
        }
        string type = key[..dotIdx];
        string subType = key[(dotIdx + TYPE_SUBTYPE_SEPARATOR.Length)..];
        // Malformed keys are not validated here — they fall through to the
        // downstream registry.Has() check which reports them.
        return new SplitKey(type, subType, true);
    }

    // -----------------------------------------------------------------------
    // expandPackageForPath — expand a relative package path against a base.
    //
    //   Absolute path (::foo::bar) → prepended with base: "acme" + "::foo" →
    //                                "acme::foo::bar"
    //   No leading :: → used as-is
    // -----------------------------------------------------------------------

    private static string ExpandPackageForPath(string basePkg, string pkgPath)
    {
        if (basePkg.Length == 0 ||
            !pkgPath.StartsWith(PACKAGE_SEPARATOR, StringComparison.Ordinal))
        {
            return pkgPath;
        }
        return basePkg + pkgPath;
    }

    /// <summary>
    /// The resolution key a ROOT-LEVEL declaration would carry once parsed:
    /// <c>&lt;pkg&gt;::&lt;name&gt;</c> where pkg is the node's own <c>package</c>
    /// (expanded against the file context, same as ApplyReservedKeys) when
    /// declared, else the file's context package. Bare name when neither exists.
    /// Matches <see cref="MetaData.ResolutionKey"/> on the already-parsed side,
    /// so the root-level merge lookup can compare identity BEFORE the new node
    /// is constructed.
    /// </summary>
    private static string RootChildResolutionKey(
        JsonElement nodeData, string inheritedContextPkg, string name)
    {
        string? rawPkg = TryGetString(nodeData, RESERVED_KEY_PACKAGE);
        string pkg = !string.IsNullOrEmpty(rawPkg)
            ? ExpandPackageForPath(inheritedContextPkg, rawPkg)
            : inheritedContextPkg;
        return pkg.Length != 0 ? $"{pkg}{PACKAGE_SEPARATOR}{name}" : name;
    }

    // -----------------------------------------------------------------------
    // buildTree — the shared registry-driven tree-builder.
    //
    // Throws ParseException for top-level structural problems; collects
    // content-level problems into the result.
    // -----------------------------------------------------------------------

    private static ParseResult BuildTree(JsonElement parsed, ParseOptions opts)
    {
        var st = new ParseState
        {
            Registry = opts.Registry,
            Strict = opts.Strict,
            Source = opts.SourceName,
            DeferSuperResolution = opts.DeferSuperResolution,
            SourceFormat = opts.SourceFormat,
            YamlPositionsByPath = opts.YamlPositionsByPath,
        };

        if (parsed.ValueKind != JsonValueKind.Object)
        {
            throw new ParseException(
                "Top-level metadata must be an object",
                ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, st.Source, st.Builder.ToString(),
                st.CurrentSource());
        }

        // --- Find the wrapper key (skip $schema) ---
        var wrapperKeys = new List<string>();
        foreach (JsonProperty prop in parsed.EnumerateObject())
        {
            if (prop.Name != JSON_KEY_SCHEMA)
            {
                wrapperKeys.Add(prop.Name);
            }
        }

        if (wrapperKeys.Count == 0)
        {
            throw new ParseException(
                "Top-level metadata object has no type wrapper key",
                ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, st.Source, st.Builder.ToString(),
                st.CurrentSource());
        }
        if (wrapperKeys.Count > 1)
        {
            throw new ParseException(
                $"Top-level metadata object must have exactly one wrapper key (found: {string.Join(", ", wrapperKeys)})",
                ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, st.Source, st.Builder.ToString(),
                st.CurrentSource());
        }

        string rootKey = wrapperKeys[0];
        JsonElement rootData = parsed.GetProperty(rootKey);

        // Push the root wrapper key onto the canonical-JSONPath builder. The
        // builder now reflects the location of every error / node-source from
        // here on.
        st.Builder.PushKey(rootKey);

        if (rootData.ValueKind != JsonValueKind.Object)
        {
            throw new ParseException(
                $"Top-level wrapper \"{rootKey}\" must contain an object",
                ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, st.Source, st.Builder.ToString(),
                st.CurrentSource());
        }

        SplitKey rootSplit = SplitTypeKey(rootKey, opts.Registry);
        string rootType = rootSplit.Type;
        string rootSubType = rootSplit.SubType;

        // A `<type>.base` node may not be AUTHORED — see AbstractSubtypeMessage. This is
        // the ROOT door; the child door is in the child loop below. One rule, both doors:
        // a check on one of two entry points is a rule that is only half true.
        // AllSubTypesOf(...).Count > 0 first: an UNREGISTERED type has no default either, so
        // without this guard a typo'd root key is reported as a registered type that merely
        // lacks a default, instead of as the unknown type it is. The registration check below
        // owns that case and phrases it correctly.
        if (opts.Registry.AllSubTypesOf(rootType).Count > 0
            && ((rootSubType == SUBTYPE_BASE && IsAbstractAnchorFor(rootType, opts.Registry))
                || (!rootSplit.Explicit && rootSubType.Length == 0)))
        {
            throw rootSplit.Explicit
                ? new ParseException(
                    AbstractSubtypeMessage(rootType),
                    ErrorCode.ERR_ABSTRACT_SUBTYPE_AUTHORED, st.Source, st.Builder.ToString(),
                    st.CurrentSource())
                : new ParseException(
                    MissingSubtypeMessage(rootType),
                    ErrorCode.ERR_MISSING_SUBTYPE, st.Source, st.Builder.ToString(),
                    st.CurrentSource());
        }

        // Check root type is registered (always throw — can't skip the root).
        if (!opts.Registry.Has(rootType, rootSubType))
        {
            ErrorCode rootTypeCode = opts.Registry.AllSubTypesOf(rootType).Count > 0
                ? ErrorCode.ERR_UNKNOWN_SUBTYPE
                : ErrorCode.ERR_UNKNOWN_TYPE;
            throw new ParseException(
                $"Unknown root type \"{rootType}.{rootSubType}\" — not registered",
                rootTypeCode, st.Source, st.Builder.ToString(),
                st.CurrentSource());
        }

        if (opts.IntoRoot is not null)
        {
            // --- Merge mode: parse root's attrs/children into the existing root ---
            // The JSON root's own package/super/reserved-keys are not re-applied
            // to the existing root. BUT: children from the NEW JSON should inherit
            // from the NEW root's package, not the existing root's.
            string contextPkg = TryGetString(rootData, RESERVED_KEY_PACKAGE)
                ?? opts.IntoRoot.Package ?? "";
            ParseNodeInto(rootData, opts.IntoRoot, opts.IntoRoot, contextPkg, st);
            return new ParseResult(opts.IntoRoot, st.Warnings, st.Errors, st.EnvelopeWarnings);
        }

        // --- Fresh root mode: create a new root from the JSON ---
        // The cast is safe within the core provider: `metadata.root` is the only
        // registered `metadata` subtype, and its factory unconditionally produces
        // a MetaRoot.
        MetaData root = ParseNodeFresh(
            rootType, rootSubType, rootData,
            accumRoot: null,
            inheritedContextPkg: "",
            st,
            parentType: null, parent: null);

        return new ParseResult((MetaRoot)root, st.Warnings, st.Errors, st.EnvelopeWarnings);
    }

    // -----------------------------------------------------------------------
    // parseNodeFresh — create a NEW node for this metadata node.
    //
    // accumRoot is the root of the accumulating tree (for super resolution).
    // When parsing the root node itself, accumRoot is null on first call; the
    // newly created root is passed as accumRoot for its children.
    //
    // inheritedContextPkg is the effective package from the nearest ancestor
    // with an explicit package.
    // -----------------------------------------------------------------------

    private static MetaData ParseNodeFresh(
        string type,
        string subType,
        JsonElement nodeData,
        MetaData? accumRoot,
        string inheritedContextPkg,
        ParseState st,
        string? parentType,
        MetaData? parent)
    {
        // --- Look up type in registry ---
        if (!st.Registry.Has(type, subType))
        {
            if (st.Registry.Has(type, SUBTYPE_BASE))
            {
                subType = SUBTYPE_BASE;
            }
            else
            {
                string msg = $"Unknown type \"{type}.{subType}\" — not registered";
                string path = st.Builder.ToString();
                st.Errors.Add(new MetaError(msg, ErrorCode.ERR_UNKNOWN_TYPE, st.Source, path,
                    st.CurrentSource()));
                string fallbackName = TryGetString(nodeData, RESERVED_KEY_NAME) ?? "";
                var fallback = new MetaRoot(new TypeId(type, subType), fallbackName);
                fallback.SetSource(st.CurrentSource());
                return fallback;
            }
        }

        // --- Determine name ---
        string name = TryGetString(nodeData, RESERVED_KEY_NAME) ?? "";

        // --- Create the model ---
        TypeDefinition def = st.Registry.Find(type, subType)!;

        // Config-driven default name for a singleton type: when the type definition
        // declares MaxOccurs == 1 with a DefaultName, a name-less node is named from
        // config and SERIALIZED with that name (e.g. identity.primary → "primary").
        // Generic registry rule — not a per-type loader special-case. Two such
        // singletons trip the MaxOccurs enforcement pass (ERR_TOO_MANY_OCCURRENCES).
        if (name == "" && def.MaxOccurs == 1 && def.DefaultName is not null)
        {
            name = def.DefaultName;
        }

        MetaData model = def.Factory(def.TypeId, name);
        // FR5a / ADR-0009: attach the JSON-source envelope at construction time.
        model.SetSource(st.CurrentSource());

        // --- Apply reserved keys (package, extends, abstract, isArray) ---
        ApplyReservedKeys(model, nodeData, st, inheritedContextPkg);

        // --- Inherit package from context if not explicitly set ---
        // Java rule (BaseMetaDataParser.shouldInheritPackageFromParent):
        // - Fields within objects: no package (simple names)
        // - Fields NOT within objects: inherit parent's package
        // - Validators within fields: inherit the field's package ONLY if the
        //   field's FQN contains "::"
        // - Objects and other types: don't inherit
        if (model.Package is null && inheritedContextPkg != "")
        {
            bool shouldInherit = false;

            if (type == TYPE_FIELD && parentType != TYPE_OBJECT)
            {
                shouldInherit = true;
            }
            else if (type == TYPE_VALIDATOR &&
                     parentType == TYPE_FIELD && parent is not null)
            {
                shouldInherit = parent.Fqn().Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal);
            }

            if (shouldInherit)
            {
                model.SetPackage(inheritedContextPkg);
            }
        }

        // --- Capture the file-default package for resolution ---
        // The effective package of the DECLARING file (inheritedContextPkg)
        // captured at parse time, so super resolution can match this node by its
        // EFFECTIVE qualified key <fileDefaultPackage>::<name> even after the
        // node merges (with no own package) into an accumulating root carrying a
        // DIFFERENT file's package. Mirrors the TS parser's setFileDefaultPackage.
        if (model.Package is null && inheritedContextPkg != "")
        {
            model.SetFileDefaultPackage(inheritedContextPkg);
        }

        // --- Determine the effective context package for super resolution ---
        string effectivePkg = model.Package ?? inheritedContextPkg;

        // --- Resolve super IMMEDIATELY against the accumulating root ---
        // (Skipped when DeferSuperResolution is true.)
        if (model.SuperRef is not null && accumRoot is not null && !st.DeferSuperResolution)
        {
            // FR-024: thread the referrer's type so dotted `Entity.child` refs resolve
            // type-scoped — kept consistent with the deferred path (SuperResolve.cs).
            MetaData? superModel = SuperResolve.ResolveSuperRef(
                model.SuperRef, effectivePkg, accumRoot, new SuperResolve.ReferrerScope(model.Type));
            if (superModel is not null)
            {
                // FR-024 — a dotted child-targeting ref must resolve to a node of the
                // SAME type and subtype as the extending node. Dotted-only check; the
                // shipped top-level extends behavior is unchanged.
                // The predicate is SHARED with SuperResolve's deferred path, not restated:
                // the two doors previously held independent copies of the boolean, so a
                // change to one left the other enforcing the old rule.
                if (SuperResolve.IsChildTargetingRef(model.SuperRef) &&
                    !SuperResolve.ExtendsTargetCompatible(model, superModel))
                {
                    throw new ParseException(
                        $"the extends target '{model.SuperRef}' is {superModel.Type}.{superModel.SubType} but the extending node '{model.Fqn()}' is {model.Type}.{model.SubType} — {SuperResolve.EXTENDS_TARGET_MISMATCH_RULE}",
                        ErrorCode.ERR_EXTENDS_TARGET_MISMATCH, st.Source, st.Builder.ToString(),
                        ResolvedSource.From(st.CurrentSource(), model.Fqn(), model.SuperRef));
                }
                model.SetSuperResolved(superModel);
            }
            else
            {
                // FR5d — emit format=resolved with referrer + target.
                // referrer = the declaring node's FQN (already built above);
                // target = the unresolved supertype ref string.
                throw new ParseException(
                    $"the SuperClass '{model.SuperRef}' does not exist in file '{st.Source ?? "<unknown>"}'",
                    ErrorCode.ERR_UNRESOLVED_SUPER, st.Source, st.Builder.ToString(),
                    ResolvedSource.From(st.CurrentSource(), model.Fqn(), model.SuperRef));
            }
        }
        else if (model.SuperRef is not null && accumRoot is null)
        {
            // Root node has a super ref — not resolvable against itself.
            ReportProblem(
                $"super on root node ('{model.SuperRef}') is not supported and will be ignored",
                st, ErrorCode.ERR_UNRESOLVED_SUPER);
        }

        // --- Process inline attributes and other keys ---
        ApplyInlineAttrsAndUnknownKeys(model, nodeData, st);

        // --- Process children ---
        // For the root node we use itself as the accumRoot for its children.
        MetaData childAccumRoot = accumRoot ?? model;
        string childInheritedContextPkg = model.Package ?? inheritedContextPkg;
        ProcessChildren(model, nodeData, childAccumRoot, childInheritedContextPkg, st);

        return model;
    }

    // -----------------------------------------------------------------------
    // parseNodeInto — merge a JSON node's attrs/children into an EXISTING model.
    //
    // Used for intoRoot mode, overlay: true nodes, and the default same-name
    // reuse path. Does NOT re-apply reserved keys.
    //
    // FR5c — this is the overlay-merge attribution hub:
    //   1. Snapshot pre-merge state (canonical shape + own attrs).
    //   2. Detect per-attr conflicts (same @attr, different non-empty values)
    //      → emit ERR_MERGE_CONFLICT with a `format: "merged"` envelope.
    //   3. Run the merge (last-writer-wins overlay semantics).
    //   4. Compare pre/post canonical (byte-identical → no semantic change,
    //      since canonicalSerialize sorts attrs / omits source / is deterministic):
    //        - Changed → upgrade target.Source to MergedSource with contributors[].
    //        - Unchanged → emit WARN_DUPLICATE_DECLARATION via the envelope-
    //          warnings channel; target.Source stays unchanged.
    // -----------------------------------------------------------------------

    private static void ParseNodeInto(
        JsonElement nodeData,
        MetaData target,
        MetaData accumRoot,
        string inheritedContextPkg,
        ParseState st)
    {
        // FR5c — capture pre-merge state so we can decide whether this contribution
        // produced any semantic change. The "new contributor" is the file currently
        // being parsed (st.Source). The "base contributor" is whichever file(s) the
        // existing target already records on its source envelope.
        string newContributorFile = st.Source ?? "<unknown>";
        bool targetIsRoot = target is MetaRoot && target.Type == TYPE_METADATA;
        // The root is a synthetic accumulator: it is not a metadata-author node —
        // every file declares { "metadata.root": ... } and the loader merges into
        // a single root. We don't run FR5c diagnostics on the root itself; the
        // merge attribution applies to author-meaningful nodes (object/field/etc).
        bool fr5cActive = !targetIsRoot && target.Name != "";

        string? preMergeShape = null;
        Dictionary<string, object?>? preMergeAttrSnapshot = null;
        if (fr5cActive)
        {
            preMergeShape = SerializerJson.CanonicalSerialize(target);
            // ADR-0039: OwnAttrs — this IS the overlay/merge machinery. The conflict check must
            // compare the target's OWN declared attrs (not extends-resolved) so ERR_MERGE_CONFLICT
            // fires only when a new contribution overwrites an attr THIS node already declared to a
            // different non-empty value.
            preMergeAttrSnapshot = new Dictionary<string, object?>(target.OwnAttrs(), StringComparer.Ordinal);
        }

        // FR5c — detect attribute-level merge conflicts: for each @-prefixed inline
        // attr in nodeData, if the target already has an own attr of that name
        // with a non-empty value, AND the new value differs from the existing
        // value (both sides non-empty), emit ERR_MERGE_CONFLICT with a
        // `format: "merged"` envelope. Last-writer-wins is preserved for
        // non-conflicting cases (one side unset, same value, etc.) — those carry
        // through to the existing ApplyInlineAttrsAndUnknownKeys logic below.
        if (fr5cActive && preMergeAttrSnapshot is not null)
        {
            DetectAttrMergeConflicts(target, nodeData, preMergeAttrSnapshot, newContributorFile, st);
        }

        // Apply inline attrs (not reserved keys — those stay on the existing model).
        ApplyInlineAttrsAndUnknownKeys(target, nodeData, st);

        // The effective package for children: use inheritedContextPkg (from the
        // new JSON's root) — not target.Package, because target is the existing
        // model being merged into.
        ProcessChildren(target, nodeData, accumRoot, inheritedContextPkg, st);

        // FR5c — after merge: compare pre/post shape. If no semantic change → emit
        // WARN_DUPLICATE_DECLARATION (the new contribution declared the same thing
        // the target already had). If there was a change → upgrade the target's
        // source envelope to MergedSource with both contributors listed.
        if (fr5cActive && preMergeShape is not null)
        {
            // Canonical serialization is deterministic: attrs sorted, children
            // in order, source omitted. Byte-identical pre/post → no semantic
            // change (matches TS's semanticDiff which is the equivalent check
            // on the parsed JSON shape).
            string postMergeShape = SerializerJson.CanonicalSerialize(target);
            bool changed = !string.Equals(preMergeShape, postMergeShape, StringComparison.Ordinal);

            // Pull the existing contributor file(s) off the target's current source
            // envelope (set at parse-fresh time or by a previous merge).
            ErrorSource existing = target.Source;
            IReadOnlyList<string> existingFiles = existing switch
            {
                JsonSource js => js.Files,
                YamlSource ys => ys.Files,
                MergedSource ms => ms.Files,
                _ => Array.Empty<string>(),
            };
            string? existingJsonPath = existing switch
            {
                JsonSource js => js.JsonPath,
                YamlSource ys => ys.JsonPath,
                MergedSource ms => ms.JsonPath,
                _ => null,
            };

            if (changed)
            {
                // Real overlay — upgrade source to merged with contributors.
                IReadOnlyList<string> allFiles = SortedUnion(existingFiles, newContributorFile);
                IReadOnlyList<Contributor> contributors = BuildContributors(allFiles);
                target.SetSource(new MergedSource(
                    Files: allFiles,
                    JsonPath: existingJsonPath ?? st.Builder.ToString(),
                    Contributors: contributors));
            }
            else if (existingFiles.Count > 0 && !existingFiles.Contains(newContributorFile, StringComparer.Ordinal))
            {
                // Identical re-declaration from a different file → warn.
                IReadOnlyList<string> allFiles = SortedUnion(existingFiles, newContributorFile);
                IReadOnlyList<Contributor> contributors = BuildContributors(allFiles);
                var warnSource = new MergedSource(
                    Files: allFiles,
                    JsonPath: existingJsonPath ?? st.Builder.ToString(),
                    Contributors: contributors);
                st.EnvelopeWarnings.Add(new LoaderWarning(
                    Code: WarningCodes.WARN_DUPLICATE_DECLARATION,
                    Message: $"duplicate declaration of {target.Name} with no semantic change",
                    Source: warnSource));
            }
        }
    }

    /// <summary>
    /// FR5c — alphabetically sort the union of an existing file list and a new
    /// contributor file (deduplicating). Sort order matches the cross-port
    /// alphabetical load-order contract from <c>DirectorySource</c>, giving
    /// deterministic <c>files[]</c> output across ports.
    /// </summary>
    private static IReadOnlyList<string> SortedUnion(IReadOnlyList<string> existing, string newFile)
    {
        var set = new SortedSet<string>(existing, StringComparer.Ordinal) { newFile };
        return set.ToList();
    }

    /// <summary>
    /// FR5c — build a <see cref="Contributor"/> list from an alphabetically-
    /// sorted file list. The first file is <c>overlay-base</c>; later files
    /// are <c>overlay-extension</c>.
    /// </summary>
    private static IReadOnlyList<Contributor> BuildContributors(IReadOnlyList<string> sortedFiles)
    {
        var list = new List<Contributor>(sortedFiles.Count);
        for (int i = 0; i < sortedFiles.Count; i++)
        {
            list.Add(new Contributor(sortedFiles[i], i == 0 ? "overlay-base" : "overlay-extension"));
        }
        return list;
    }

    /// <summary>
    /// FR5c — for every @-prefixed inline attr in <paramref name="nodeData"/>,
    /// check whether the target already declares the same attr (in
    /// <paramref name="preAttrs"/>) with a different non-empty value. If so,
    /// emit <see cref="ErrorCode.ERR_MERGE_CONFLICT"/> with a
    /// <see cref="MergedSource"/> envelope naming both contributors.
    ///
    /// <para>
    /// The merge itself proceeds (existing last-writer-wins) so the loader sees
    /// one canonical tree; the error surfaces the conflict so a consumer can
    /// fix the metadata.
    /// </para>
    /// </summary>
    private static void DetectAttrMergeConflicts(
        MetaData target,
        JsonElement nodeData,
        IReadOnlyDictionary<string, object?> preAttrs,
        string newContributorFile,
        ParseState st)
    {
        IReadOnlyList<string> existingFiles = target.Source switch
        {
            JsonSource js => js.Files,
            YamlSource ys => ys.Files,
            MergedSource ms => ms.Files,
            _ => Array.Empty<string>(),
        };

        foreach (JsonProperty prop in nodeData.EnumerateObject())
        {
            string key = prop.Name;
            if (!key.StartsWith(ATTR_PREFIX, StringComparison.Ordinal)) continue;
            if (RESERVED_KEYS.Contains(key)) continue;
            string attrName = key[ATTR_PREFIX.Length..];
            if (RESERVED_KEYS.Contains(attrName)) continue;

            if (!preAttrs.TryGetValue(attrName, out object? existingVal)) continue;

            object? newValRaw;
            try
            {
                newValRaw = DataConverter.ToAttrValue(prop.Value);
            }
            catch (FormatException)
            {
                // Conversion failures surface through the regular apply-attrs path;
                // skip conflict-detection here so we don't double-report.
                continue;
            }

            if (IsEmptyAttrValue(newValRaw) || IsEmptyAttrValue(existingVal)) continue;
            // Both sides set a non-empty value — compare. If equal, last-writer-wins
            // is a no-op; if different, that's a conflict.
            if (AttrValuesEqual(existingVal, newValRaw)) continue;

            IReadOnlyList<string> allFiles = SortedUnion(existingFiles, newContributorFile);
            IReadOnlyList<Contributor> contributors = BuildContributors(allFiles);
            string jsonPath = $"{st.Builder}.{ATTR_PREFIX}{attrName}";
            var conflictSource = new MergedSource(
                Files: allFiles,
                JsonPath: jsonPath,
                Contributors: contributors);
            string msg = $"attr '{ATTR_PREFIX}{attrName}' conflicts: existing value " +
                $"{FormatAttrForMsg(existingVal)} differs from new value " +
                $"{FormatAttrForMsg(newValRaw)} on {target.Fqn()}";
            st.Errors.Add(new MetaError(
                msg,
                ErrorCode.ERR_MERGE_CONFLICT,
                st.Source,
                jsonPath,
                conflictSource));
        }
    }

    private static bool IsEmptyAttrValue(object? v)
    {
        if (v is null) return true;
        if (v is string s && s == "") return true;
        if (v is System.Collections.ICollection col && col.Count == 0) return true;
        return false;
    }

    private static bool AttrValuesEqual(object? a, object? b)
    {
        if (ReferenceEquals(a, b)) return true;
        if (a is null || b is null) return false;
        // Scalars (string/long/double/bool/decimal/...): default equality is fine.
        if (a is string sa && b is string sb) return string.Equals(sa, sb, StringComparison.Ordinal);
        if (a is System.Collections.IList la && b is System.Collections.IList lb)
        {
            if (la.Count != lb.Count) return false;
            for (int i = 0; i < la.Count; i++)
            {
                if (!AttrValuesEqual(la[i], lb[i])) return false;
            }
            return true;
        }
        if (a is System.Collections.IDictionary da && b is System.Collections.IDictionary db)
        {
            if (da.Count != db.Count) return false;
            foreach (object? k in da.Keys)
            {
                if (!db.Contains(k)) return false;
                if (!AttrValuesEqual(da[k], db[k])) return false;
            }
            return true;
        }
        return a.Equals(b);
    }

    private static string FormatAttrForMsg(object? v)
    {
        if (v is null) return "null";
        if (v is string s) return $"\"{s}\"";
        return v.ToString() ?? "null";
    }

    // -----------------------------------------------------------------------
    // createOrFindMetaData — per-node merge logic.
    //
    //   overlay: true → find-or-throw
    //   default       → find-or-create (silently reuse if found)
    // -----------------------------------------------------------------------

    private static MetaData? CreateOrFindMetaData(
        string type,
        string subType,
        JsonElement nodeData,
        MetaData parent,
        MetaData accumRoot,
        string inheritedContextPkg,
        ParseState st)
    {
        // Only `overlay: true` re-opens an existing node.
        bool isOverlayNode = TryGetBool(nodeData, RESERVED_KEY_OVERLAY) == true;

        // Determine name (needed for the lookup). Lookup key is (type, name).
        string name = TryGetString(nodeData, RESERVED_KEY_NAME) ?? "";

        // Look up an existing child with (type, name). Skip unnamed nodes —
        // they are always distinct (e.g. inline validators, anonymous attrs).
        //
        // ROOT-LEVEL lookups are PACKAGE-QUALIFIED: two files declaring the same
        // (type, name) under different packages are DISTINCT root nodes, never a
        // merge pair (mirrors the Java parser, which searches root children by
        // "pkg::name"). Nested children stay bare-name matched — they are scoped
        // by their parent, and packages don't disambiguate siblings inside a node.
        MetaData? existing = name != ""
            ? parent.OwnChildByTypeAndName(type, name)
            : null;
        if (existing is not null && parent is MetaRoot)
        {
            string candidateKey = RootChildResolutionKey(nodeData, inheritedContextPkg, name);
            if (existing.ResolutionKey() != candidateKey)
            {
                // The first same-name hit is a different package — scan for an
                // exact package-qualified match (several packages may declare
                // this name).
                existing = parent.OwnChildren().FirstOrDefault(
                    c => c.Type == type && c.Name == name && c.ResolutionKey() == candidateKey);
            }
        }

        if (isOverlayNode)
        {
            if (existing is null)
            {
                throw new ParseException(
                    $"Overlay operation requested for [{type}:{name}] but no existing metadata found to merge into",
                    ErrorCode.ERR_OVERLAY_NO_TARGET, st.Source, st.Builder.ToString(),
                    st.CurrentSource());
            }
            existing.SetIsMerge(true);
            ParseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, st);
            return existing;
        }

        // Default: no operator → silently reuse existing or create new.
        if (existing is not null)
        {
            ParseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, st);
            return existing;
        }

        // Not found (or unnamed) → create new.
        return ParseNodeFresh(
            type, subType, nodeData, accumRoot, inheritedContextPkg, st,
            parent.Type, parent);
    }

    // -----------------------------------------------------------------------
    // applyReservedKeys — apply package, extends, abstract, isArray to a model.
    //
    // Called only when CREATING a new model.
    // -----------------------------------------------------------------------

    private static void ApplyReservedKeys(
        MetaData model,
        JsonElement nodeData,
        ParseState st,
        string contextPkg)
    {
        string Path() => st.Builder.ToString();

        // package
        if (nodeData.TryGetProperty(RESERVED_KEY_PACKAGE, out JsonElement rawPkg))
        {
            if (rawPkg.ValueKind != JsonValueKind.String)
            {
                ReportProblem(
                    $"\"{RESERVED_KEY_PACKAGE}\" must be a string at {Path()}",
                    st, ErrorCode.ERR_BAD_ATTR_VALUE);
            }
            else
            {
                model.SetPackage(ExpandPackageForPath(contextPkg, rawPkg.GetString()!));
            }
        }

        // extends — store the raw supertype ref; resolution happens after this call.
        if (nodeData.TryGetProperty(RESERVED_KEY_EXTENDS, out JsonElement rawExtends))
        {
            if (rawExtends.ValueKind != JsonValueKind.String)
            {
                ReportProblem(
                    $"\"{RESERVED_KEY_EXTENDS}\" must be a string at {Path()}",
                    st, ErrorCode.ERR_UNRESOLVED_SUPER);
            }
            else
            {
                // FR-032 — reject a relative `extends` ref in canonical JSON.
                GuardRelativeRefInCanonical($"\"{RESERVED_KEY_EXTENDS}\"", rawExtends.GetString(), st);
                model.SetSuper(rawExtends.GetString()!);
            }
        }

        // abstract — structural key (true → abstract node)
        if (nodeData.TryGetProperty(RESERVED_KEY_ABSTRACT, out JsonElement rawAbstract))
        {
            if (rawAbstract.ValueKind != JsonValueKind.True && rawAbstract.ValueKind != JsonValueKind.False)
            {
                ReportProblem(
                    $"\"{RESERVED_KEY_ABSTRACT}\" must be a boolean at {Path()}",
                    st, ErrorCode.ERR_BAD_ATTR_VALUE);
            }
            else
            {
                model.SetIsAbstract(rawAbstract.GetBoolean());
            }
        }

        // isArray — structural key (true → array node)
        if (nodeData.TryGetProperty(RESERVED_KEY_IS_ARRAY, out JsonElement rawIsArray))
        {
            if (rawIsArray.ValueKind != JsonValueKind.True && rawIsArray.ValueKind != JsonValueKind.False)
            {
                ReportProblem(
                    $"\"{RESERVED_KEY_IS_ARRAY}\" must be a boolean at {Path()}",
                    st, ErrorCode.ERR_BAD_ATTR_VALUE);
            }
            else
            {
                model.SetIsArray(rawIsArray.GetBoolean());
            }
        }
    }

    // -----------------------------------------------------------------------
    // stringArray desugar — normalize a bare-string value for a declared
    // stringArray-typed @-attr into a one-element array.
    //
    // Only a string value is wrapped. Already-list values are left as-is;
    // non-string scalars are left as-is. Undeclared attrs are left as-is.
    // -----------------------------------------------------------------------

    private static object? NormalizeStringArrayAttr(
        string type,
        string subType,
        string attrName,
        object? value,
        TypeRegistry registry)
    {
        if (value is not string s) return value;
        // Per-type wins, common attrs (e.g. doc attrs) fill the rest.
        AttrSchema? spec = registry.FindAttrSchema(type, subType, attrName);
        // Array-ness is the orthogonal IsArray flag (the retired `stringarray`
        // subtype); also tolerate a legacy stringarray valueType token.
        bool isArray = spec is not null
            && (spec.IsArray || spec.ValueType == ATTR_SUBTYPE_STRINGARRAY);
        if (!isArray) return value;
        return new List<string> { s }.AsReadOnly();
    }

    // -----------------------------------------------------------------------
    // filter desugar — normalize an attr.filter value to canonical
    // { field: { op: value } } form at parse time. Three rules:
    //   scalar v    → { eq: v }
    //   array  [..] → { in: [..] }
    //   null        → { isNull: true }
    // Explicit { op: value } clauses pass through. or/and composition keys
    // recurse into their sub-filter arrays.
    //
    // Mirrors normalizeFilterAttr / desugarFilterObject / desugarClause in
    // typescript/packages/metadata/src/parser-core.ts.
    // -----------------------------------------------------------------------

    private static object? NormalizeFilterAttr(
        string type,
        string subType,
        string attrName,
        object? value,
        TypeRegistry registry)
    {
        AttrSchema? spec = registry.AttrsOf(type, subType).FirstOrDefault(a => a.Name == attrName);
        if (spec is null || spec.ValueType != ATTR_SUBTYPE_FILTER) return value;
        // Only IReadOnlyDictionary (an already-parsed object) gets desugared.
        // A string (legacy form) is returned as-is for attr-schema to reject.
        if (value is not IReadOnlyDictionary<string, object?> filterObj) return value;
        return DesugarFilterObject(filterObj);
    }

    private static IReadOnlyDictionary<string, object?> DesugarFilterObject(
        IReadOnlyDictionary<string, object?> filter)
    {
        var out_ = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (key, raw) in filter)
        {
            if (key == FILTER_COMPOSE_OR || key == FILTER_COMPOSE_AND)
            {
                // Recurse into each sub-filter in the array.
                if (raw is IReadOnlyList<object?> subList)
                {
                    var desugaredList = new List<object?>(subList.Count);
                    foreach (var sub in subList)
                    {
                        if (sub is IReadOnlyDictionary<string, object?> subFilter)
                            desugaredList.Add(DesugarFilterObject(subFilter));
                        else
                            desugaredList.Add(sub);
                    }
                    out_[key] = desugaredList.AsReadOnly();
                }
                else
                {
                    out_[key] = raw;
                }
                continue;
            }
            out_[key] = DesugarClause(raw);
        }
        return out_.AsReadOnly();
    }

    private static IReadOnlyDictionary<string, object?> DesugarClause(object? raw)
    {
        // null → { isNull: true }
        if (raw is null)
            return new Dictionary<string, object?>(StringComparer.Ordinal)
                { [FILTER_OP_IS_NULL] = true }.AsReadOnly();

        // array → { in: [...] }
        if (raw is IReadOnlyList<object?> arr)
            return new Dictionary<string, object?>(StringComparer.Ordinal)
                { [FILTER_OP_IN] = raw }.AsReadOnly();

        // already-object → pass through (explicit op clause)
        if (raw is IReadOnlyDictionary<string, object?> obj)
            return obj;

        // scalar (string/bool/long/double) → { eq: value }
        return new Dictionary<string, object?>(StringComparer.Ordinal)
            { [FILTER_OP_EQ] = raw }.AsReadOnly();
    }

    // -----------------------------------------------------------------------
    // applyInlineAttrsAndUnknownKeys — apply @-prefixed attrs, warn on unknowns.
    //
    // Called for both fresh creates AND merge-into-existing paths. Does NOT
    // process reserved structural keys.
    // -----------------------------------------------------------------------

    private static void ApplyInlineAttrsAndUnknownKeys(
        MetaData model,
        JsonElement nodeData,
        ParseState st)
    {
        // PARENT-PATH SCOPE: errors raised from this loop use the parent node's
        // canonical path (the path of the node that owns these inline attrs), NOT
        // a key-deeper path. Mirrors TS parser-core.ts:626-690, which never pushes
        // the attr key onto _currentPath inside this loop — `path` is the parent's.
        // This is the FR5a contract: ERR_RESERVED_ATTR / ERR_UNKNOWN_ATTR /
        // ERR_BAD_ATTR_VALUE all surface at the parent (the node body that
        // contains the bad key). The previous C# code threaded one level deeper,
        // which produced cross-port envelope drift on error-reserved-word-as-attr.
        string path = st.Builder.ToString();
        foreach (JsonProperty prop in nodeData.EnumerateObject())
        {
            string key = prop.Name;

            // Skip all reserved structural keys.
            if (RESERVED_KEYS.Contains(key)) continue;

            if (!key.StartsWith(ATTR_PREFIX, StringComparison.Ordinal))
            {
                string displayName = model.Name != ""
                    ? $"{model.Type}.{model.SubType} '{model.Name}'"
                    : $"{model.Type}.{model.SubType}";
                ReportProblem(
                    $"Unknown key '{key}' on {displayName} at {path} (must be reserved or {ATTR_PREFIX}-prefixed)",
                    st, ErrorCode.ERR_UNKNOWN_ATTR);
                continue;
            }

            // Inline attribute (@-prefixed).
            string attrName = key[ATTR_PREFIX.Length..];
            JsonElement rawVal = prop.Value;

            // ERR_RESERVED_ATTR: any @-prefixed reserved structural key (e.g. "@isArray",
            // "@name") is always a metadata-author error and is reported as a hard
            // error regardless of strict mode — downstream code must never see a
            // bogus MetaAttr named after a reserved word. Mirrors the TS
            // parser-core.ts (errors-sink-direct in lax mode, throw in strict) and
            // Java CanonicalJsonParser. The YAML desugar layer has its own pre-check
            // that fires first when authoring in YAML; the canonical parser is the
            // last-line cross-language gate.
            if (RESERVED_KEYS.Contains(attrName))
            {
                string displayName = model.Name != ""
                    ? $"{model.Type}.{model.SubType} '{model.Name}'"
                    : $"{model.Type}.{model.SubType}";
                string msg = $"Reserved structural key '{attrName}' must not be " +
                             $"{ATTR_PREFIX}-prefixed on {displayName} at {path} (write it bare)";
                if (st.Strict)
                {
                    throw new ParseException(msg, ErrorCode.ERR_RESERVED_ATTR, st.Source, path,
                        st.CurrentSource());
                }
                st.Errors.Add(new MetaError(msg, ErrorCode.ERR_RESERVED_ATTR, st.Source, path,
                    st.CurrentSource()));
                continue;
            }

            // FR-032 — reject a relative ref value on a ref-bearing inline @-attr
            // (@objectRef/@references/@from/@of/@via/@payloadRef/@responseRef/
            // @parameterRef) in canonical JSON. Only string values can be relative.
            if (RefBearingAttrNames.Contains(attrName)
                && rawVal.ValueKind == JsonValueKind.String)
            {
                GuardRelativeRefInCanonical($"\"{ATTR_PREFIX}{attrName}\"", rawVal.GetString(), st);
            }

            AttrSchema? attrSpec = st.Registry
                .AttrsOf(model.Type, model.SubType)
                .FirstOrDefault(a => a.Name == attrName);

            object? value;
            try
            {
                if (attrSpec is not null && attrSpec.ValueType is not null)
                {
                    // Declared attr with a concrete value-type — convert toward
                    // that DataType.
                    DataType dataType = st.Registry.Find(TYPE_ATTR, attrSpec.ValueType)?.DataType
                        ?? DataType.String;
                    value = DataConverter.ConvertToDataType(dataType, rawVal);
                }
                else
                {
                    // Undeclared @-attr OR declared-but-untyped — store the value
                    // type-preserved, exactly as the JSON author wrote it.
                    value = DataConverter.ToAttrValue(rawVal);
                }
            }
            catch (FormatException err)
            {
                ReportProblem(
                    $"Failed to convert attribute \"{ATTR_PREFIX}{attrName}\" at {path}: {err.Message}",
                    st, ErrorCode.ERR_BAD_ATTR_VALUE);
                continue;
            }

            // A bare string for a declared stringArray attr → one-element array.
            object? normalized = NormalizeStringArrayAttr(
                model.Type, model.SubType, attrName, value, st.Registry);
            // An object-valued filter attr → canonical { field: { op: value } } form.
            normalized = NormalizeFilterAttr(
                model.Type, model.SubType, attrName, normalized, st.Registry);
            model.SetAttr(attrName, normalized);
        }
    }

    // -----------------------------------------------------------------------
    // processChildren — parse the "children" array of a node
    // -----------------------------------------------------------------------

    private static void ProcessChildren(
        MetaData parent,
        JsonElement nodeData,
        MetaData accumRoot,
        string inheritedContextPkg,
        ParseState st)
    {
        if (!nodeData.TryGetProperty(RESERVED_KEY_CHILDREN, out JsonElement rawChildren))
        {
            return;
        }

        if (rawChildren.ValueKind != JsonValueKind.Array)
        {
            // Reuses ERR_TOP_LEVEL_NOT_OBJECT per TS parity — the code is overloaded
            // for "structural shape violation" generally, not just the root level.
            ReportProblem(
                $"\"{RESERVED_KEY_CHILDREN}\" must be an array at {st.Builder}",
                st, ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);
            return;
        }

        // Push "children" onto the canonical-JSONPath builder for the whole array.
        st.Builder.PushKey(RESERVED_KEY_CHILDREN);
        try
        {
            int i = 0;
            foreach (JsonElement childEntry in rawChildren.EnumerateArray())
            {
                int childIndex = i++;
                st.Builder.PushIndex(childIndex);
                try
                {
                    string childPath = st.Builder.ToString();

                    if (childEntry.ValueKind != JsonValueKind.Object)
                    {
                        ReportProblem(
                            $"Child at {childPath} must be an object",
                            st, ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);
                        continue;
                    }

                    string? childKey = null;
                    int keyCount = 0;
                    foreach (JsonProperty p in childEntry.EnumerateObject())
                    {
                        childKey ??= p.Name;
                        keyCount++;
                        if (keyCount > 1) break;
                    }

                    if (keyCount != 1)
                    {
                        string msg;
                        if (keyCount == 0)
                        {
                            msg = $"Child at {childPath} has no type wrapper key";
                        }
                        else
                        {
                            // keyCount > 1: collect all keys only on this rare error path.
                            var allKeys = new List<string>();
                            foreach (JsonProperty p in childEntry.EnumerateObject())
                                allKeys.Add(p.Name);
                            msg = $"Child at {childPath} has multiple keys ({string.Join(", ", allKeys)}) — each child must have exactly one wrapper key";
                        }
                        ReportProblem(msg, st, ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);
                        continue;
                    }

                    // keyCount == 1 guarantees childKey was assigned above (null-forgiving is safe).
                    string singleChildKey = childKey!;
                    JsonElement childData = childEntry.GetProperty(singleChildKey);
                    st.Builder.PushKey(singleChildKey);
                    try
                    {
                        string childNodePath = st.Builder.ToString();

                        if (childData.ValueKind != JsonValueKind.Object)
                        {
                            ReportProblem(
                                $"Child wrapper \"{singleChildKey}\" at {childNodePath} must contain an object",
                                st, ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);
                            continue;
                        }

                        SplitKey childSplit = SplitTypeKey(singleChildKey, st.Registry);
                        string childType = childSplit.Type;
                        string childSubType = childSplit.SubType;
                        bool explicitSubType = childSplit.Explicit;

                        // A `<type>.base` may not be AUTHORED, and a bare key for a type with
                        // no declared default is a MISSING subType. BEFORE the registered-type
                        // check below, matching the root door and the JVM: run it after, and a
                        // bare key for a type registering no `base` at all (identity, index,
                        // requirement) falls into that check's else-arm first and is reported
                        // as an UNKNOWN TYPE — a message asserting the type does not exist,
                        // about a type that does. Order is the whole rule here.
                        if ((childSubType == SUBTYPE_BASE
                                && IsAbstractAnchorFor(childType, st.Registry))
                            || (!explicitSubType && childSubType.Length == 0))
                        {
                            st.Errors.Add(explicitSubType
                                ? new MetaError(
                                    AbstractSubtypeMessage(childType),
                                    ErrorCode.ERR_ABSTRACT_SUBTYPE_AUTHORED, st.Source,
                                    childNodePath, st.CurrentSource())
                                : new MetaError(
                                    MissingSubtypeMessage(childType),
                                    ErrorCode.ERR_MISSING_SUBTYPE, st.Source,
                                    childNodePath, st.CurrentSource()));
                            continue; // skip this child
                        }

                        // --- Check if this child type is registered ---
                        // An EXPLICIT unknown subType (fused into the key) is an error —
                        // never silently downgraded to base. An OMITTED subType that resolves
                        // to an unregistered default falls back to base.
                        if (!st.Registry.Has(childType, childSubType))
                        {
                            if (!explicitSubType && st.Registry.Has(childType, SUBTYPE_BASE))
                            {
                                childSubType = SUBTYPE_BASE;
                            }
                            else
                            {
                                ErrorCode childTypeCode =
                                    explicitSubType && st.Registry.AllSubTypesOf(childType).Count > 0
                                        ? ErrorCode.ERR_UNKNOWN_SUBTYPE
                                        : ErrorCode.ERR_UNKNOWN_TYPE;
                                st.Errors.Add(new MetaError(
                                    $"Unknown type \"{childType}.{childSubType}\" — not registered",
                                    childTypeCode, st.Source, childNodePath,
                                    st.CurrentSource()));
                                continue; // skip this child
                            }
                        }

                        // A `<type>.base` child may not be AUTHORED — the CHILD door (the
                        // root door is above). Gated on Explicit, deliberately: `base` is
                        // also this parser's fallback for an OMITTED subType whose registry
                        // default is unregistered (the branch directly above), and refusing
                        // that would break every node relying on the default. Placed before
                        // the attr branch so `attr.base` is covered by the same rule — an
                        // authored untyped attr is the same mistake as an authored untyped
                        // field.
                        // --- Special handling for "attr" child nodes ---
                        if (childType == TYPE_ATTR)
                        {
                            ParseAttrChild(parent, childType, childSubType, childData, st);
                        }
                        else
                        {
                            MetaData? childModel = CreateOrFindMetaData(
                                childType, childSubType, childData, parent, accumRoot,
                                inheritedContextPkg, st);

                            // ADR-0039: OwnChildren — overlay/merge dedup. Overlay and same-name-reuse
                            // paths in CreateOrFindMetaData return an existing child already in parent's
                            // OWN children; only AddChild for freshly created nodes to avoid duplicates.
                            // (Must be own — a node is never added to an inherited/super child list.)
                            var owned = parent.OwnChildren();
                            if (childModel is not null && !owned.Contains(childModel))
                                parent.AddChild(childModel);
                        }
                    }
                    finally
                    {
                        st.Builder.Pop(); // singleChildKey
                    }
                }
                finally
                {
                    st.Builder.Pop(); // child index
                }
            }
        }
        finally
        {
            st.Builder.Pop(); // "children"
        }
    }

    // -----------------------------------------------------------------------
    // parseAttrChild — dual-storage: structural child + parent.SetAttr.
    //
    // A typed attr is encoded as { "attr.<subType>": { "name": ..., "value": ... } }
    // inside a node's children array. Stores BOTH a structural attr node and the
    // value on the parent via SetAttr.
    // -----------------------------------------------------------------------

    private static void ParseAttrChild(
        MetaData parent,
        string attrType,
        string attrSubType,
        JsonElement attrData,
        ParseState st)
    {
        string path = st.Builder.ToString();
        string? attrName = TryGetString(attrData, RESERVED_KEY_NAME);
        bool hasValue = attrData.TryGetProperty(RESERVED_KEY_VALUE, out JsonElement attrValue);

        if (string.IsNullOrEmpty(attrName))
        {
            ReportProblem(
                $"attr child at {path} requires a non-empty \"{RESERVED_KEY_NAME}\" string",
                st, ErrorCode.ERR_MISSING_REQUIRED_ATTR);
            return;
        }

        if (!hasValue)
        {
            ReportProblem(
                $"attr child \"{attrName}\" at {path} is missing \"{RESERVED_KEY_VALUE}\"",
                st, ErrorCode.ERR_MISSING_REQUIRED_ATTR);
            return;
        }

        // Resolve the attr node's own subtype (fall back to base if unregistered).
        string resolvedSubType =
            st.Registry.Has(attrType, attrSubType) || !st.Registry.Has(attrType, SUBTYPE_BASE)
                ? attrSubType
                : SUBTYPE_BASE;
        TypeDefinition? attrDef = st.Registry.Find(attrType, resolvedSubType);

        object? value;
        try
        {
            // SUBTYPE_BASE is the polymorphic/unconstrained marker — store
            // type-preserved. For all other subtypes, convert toward the
            // DataType of the registered subtype.
            if (resolvedSubType == SUBTYPE_BASE)
            {
                value = DataConverter.ToAttrValue(attrValue);
            }
            else
            {
                DataType dataType = attrDef?.DataType ?? DataType.String;
                value = DataConverter.ConvertToDataType(dataType, attrValue);
            }
        }
        catch (FormatException err)
        {
            ReportProblem(
                $"Failed to convert attr child \"{attrName}\" value at {path}: {err.Message}",
                st, ErrorCode.ERR_BAD_ATTR_VALUE);
            return;
        }

        MetaData attrModel = attrDef is not null
            ? attrDef.Factory(attrDef.TypeId, attrName)
            : new MetaRoot(new TypeId(attrType, resolvedSubType), attrName);
        attrModel.SetSource(st.CurrentSource());

        // A bare string for a declared stringArray attr → one-element array.
        // An object-valued filter attr → canonical { field: { op: value } } form.
        object? normalized = NormalizeStringArrayAttr(
            parent.Type, parent.SubType, attrName, value, st.Registry);
        normalized = NormalizeFilterAttr(
            parent.Type, parent.SubType, attrName, normalized, st.Registry);

        attrModel.SetAttr(RESERVED_KEY_VALUE, normalized);
        parent.AddChild(attrModel);
        parent.SetAttr(attrName, normalized);
    }

    // -----------------------------------------------------------------------
    // JsonElement helpers — mirror the TS `typeof x === "string"` / boolean
    // narrowing on a Record<string, unknown>.
    // -----------------------------------------------------------------------

    /// <summary>The string value of property <paramref name="name"/>, or null
    /// if absent or not a JSON string. Mirrors TS <c>typeof v === "string" ? v : ""</c>
    /// (callers apply the <c>?? ""</c> fallback).</summary>
    private static string? TryGetString(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    /// <summary>The boolean value of property <paramref name="name"/>, or null
    /// if absent or not a JSON boolean.</summary>
    private static bool? TryGetBool(JsonElement obj, string name)
    {
        if (!obj.TryGetProperty(name, out JsonElement v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }
}
