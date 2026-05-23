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
using MetaObjects.Meta;

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
}

/// <summary>The result of a parse run.</summary>
public sealed record ParseResult(
    MetaRoot Root,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<MetaError> Errors);

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
            throw new ParseException(
                $"Invalid JSON: {err.Message}",
                ErrorCode.ERR_MALFORMED_JSON,
                opts.SourceName,
                null);
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
        public List<string> Warnings { get; } = new();
        public List<MetaError> Errors { get; } = new();
    }

    // -----------------------------------------------------------------------
    // reportProblem — throw in strict mode, push warning otherwise
    // -----------------------------------------------------------------------

    private static void ReportProblem(
        string msg,
        ParseState st,
        string path,
        ErrorCode? code = null)
    {
        if (st.Strict)
        {
            throw new ParseException(msg, code ?? ErrorCode.ERR_UNKNOWN, st.Source, path);
        }
        st.Warnings.Add(msg);
    }

    // -----------------------------------------------------------------------
    // splitTypeKey — split a fused wrapper key into (type, subType, explicit).
    //
    // Canonical JSON always writes the full type.subType. An omitted subType
    // (bare type key, no ".") resolves to the type's registry default.
    // -----------------------------------------------------------------------

    private readonly record struct SplitKey(string Type, string SubType, bool Explicit);

    private static string DefaultSubTypeFor(string type, TypeRegistry registry)
    {
        IReadOnlyList<string> subs = registry.AllSubTypesOf(type);
        string candidate = subs.Count > 0 ? subs[0] : SUBTYPE_BASE;
        if (!registry.Has(type, candidate) && registry.Has(type, SUBTYPE_BASE))
        {
            return SUBTYPE_BASE;
        }
        return candidate;
    }

    private static SplitKey SplitTypeKey(string key, TypeRegistry registry)
    {
        int dotIdx = key.IndexOf(TYPE_SUBTYPE_SEPARATOR, StringComparison.Ordinal);
        if (dotIdx < 0)
        {
            // Bare type, no fused subType — resolve via the registry default.
            return new SplitKey(key, DefaultSubTypeFor(key, registry), false);
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
        };

        if (parsed.ValueKind != JsonValueKind.Object)
        {
            throw new ParseException(
                "Top-level metadata must be an object",
                ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, st.Source, null);
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
                ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, st.Source, null);
        }
        if (wrapperKeys.Count > 1)
        {
            throw new ParseException(
                $"Top-level metadata object must have exactly one wrapper key (found: {string.Join(", ", wrapperKeys)})",
                ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, st.Source, null);
        }

        string rootKey = wrapperKeys[0];
        JsonElement rootData = parsed.GetProperty(rootKey);

        if (rootData.ValueKind != JsonValueKind.Object)
        {
            throw new ParseException(
                $"Top-level wrapper \"{rootKey}\" must contain an object",
                ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT, st.Source, rootKey);
        }

        SplitKey rootSplit = SplitTypeKey(rootKey, opts.Registry);
        string rootType = rootSplit.Type;
        string rootSubType = rootSplit.SubType;

        // Check root type is registered (always throw — can't skip the root).
        if (!opts.Registry.Has(rootType, rootSubType))
        {
            ErrorCode rootTypeCode = opts.Registry.AllSubTypesOf(rootType).Count > 0
                ? ErrorCode.ERR_UNKNOWN_SUBTYPE
                : ErrorCode.ERR_UNKNOWN_TYPE;
            throw new ParseException(
                $"Unknown root type \"{rootType}.{rootSubType}\" — not registered",
                rootTypeCode, st.Source, rootKey);
        }

        if (opts.IntoRoot is not null)
        {
            // --- Merge mode: parse root's attrs/children into the existing root ---
            // The JSON root's own package/super/reserved-keys are not re-applied
            // to the existing root. BUT: children from the NEW JSON should inherit
            // from the NEW root's package, not the existing root's.
            string contextPkg = TryGetString(rootData, RESERVED_KEY_PACKAGE)
                ?? opts.IntoRoot.Package ?? "";
            ParseNodeInto(rootData, opts.IntoRoot, opts.IntoRoot, contextPkg, st, rootKey);
            return new ParseResult(opts.IntoRoot, st.Warnings, st.Errors);
        }

        // --- Fresh root mode: create a new root from the JSON ---
        // The cast is safe within the core provider: `metadata.root` is the only
        // registered `metadata` subtype, and its factory unconditionally produces
        // a MetaRoot.
        MetaData root = ParseNodeFresh(
            rootType, rootSubType, rootData,
            accumRoot: null,
            inheritedContextPkg: "",
            st, rootKey,
            parentType: null, parent: null);

        return new ParseResult((MetaRoot)root, st.Warnings, st.Errors);
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
        string path,
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
                st.Errors.Add(new MetaError(msg, ErrorCode.ERR_UNKNOWN_TYPE, st.Source, path));
                string fallbackName = TryGetString(nodeData, RESERVED_KEY_NAME) ?? "";
                return new MetaRoot(new TypeId(type, subType), fallbackName);
            }
        }

        // --- Determine name ---
        string name = TryGetString(nodeData, RESERVED_KEY_NAME) ?? "";

        // --- Create the model ---
        TypeDefinition def = st.Registry.Find(type, subType)!;
        MetaData model = def.Factory(def.TypeId, name);

        // --- Apply reserved keys (package, extends, abstract, isArray) ---
        ApplyReservedKeys(model, nodeData, st, path, inheritedContextPkg);

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

        // --- Determine the effective context package for super resolution ---
        string effectivePkg = model.Package ?? inheritedContextPkg;

        // --- Resolve super IMMEDIATELY against the accumulating root ---
        // (Skipped when DeferSuperResolution is true.)
        if (model.SuperRef is not null && accumRoot is not null && !st.DeferSuperResolution)
        {
            MetaData? superModel = SuperResolve.ResolveSuperRef(model.SuperRef, effectivePkg, accumRoot);
            if (superModel is not null)
            {
                model.SetSuperResolved(superModel);
            }
            else
            {
                throw new ParseException(
                    $"the SuperClass '{model.SuperRef}' does not exist in file '{st.Source ?? "<unknown>"}'",
                    ErrorCode.ERR_UNRESOLVED_SUPER, st.Source, path);
            }
        }
        else if (model.SuperRef is not null && accumRoot is null)
        {
            // Root node has a super ref — not resolvable against itself.
            ReportProblem(
                $"super on root node ('{model.SuperRef}') is not supported and will be ignored",
                st, path, ErrorCode.ERR_UNRESOLVED_SUPER);
        }

        // --- Process inline attributes and other keys ---
        ApplyInlineAttrsAndUnknownKeys(model, nodeData, st, path);

        // --- Process children ---
        // For the root node we use itself as the accumRoot for its children.
        MetaData childAccumRoot = accumRoot ?? model;
        string childInheritedContextPkg = model.Package ?? inheritedContextPkg;
        ProcessChildren(model, nodeData, childAccumRoot, childInheritedContextPkg, st, path);

        return model;
    }

    // -----------------------------------------------------------------------
    // parseNodeInto — merge a JSON node's attrs/children into an EXISTING model.
    //
    // Used for intoRoot mode, overlay: true nodes, and the default same-name
    // reuse path. Does NOT re-apply reserved keys.
    // -----------------------------------------------------------------------

    private static void ParseNodeInto(
        JsonElement nodeData,
        MetaData target,
        MetaData accumRoot,
        string inheritedContextPkg,
        ParseState st,
        string path)
    {
        // Apply inline attrs (not reserved keys — those stay on the existing model).
        ApplyInlineAttrsAndUnknownKeys(target, nodeData, st, path);

        // The effective package for children: use inheritedContextPkg (from the
        // new JSON's root) — not target.Package, because target is the existing
        // model being merged into.
        ProcessChildren(target, nodeData, accumRoot, inheritedContextPkg, st, path);
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
        ParseState st,
        string path)
    {
        // Only `overlay: true` re-opens an existing node.
        bool isOverlayNode = TryGetBool(nodeData, RESERVED_KEY_OVERLAY) == true;

        // Determine name (needed for the lookup). Lookup key is (type, name).
        string name = TryGetString(nodeData, RESERVED_KEY_NAME) ?? "";

        // Look up an existing child with (type, name). Skip unnamed nodes —
        // they are always distinct (e.g. inline validators, anonymous attrs).
        MetaData? existing = name != ""
            ? parent.OwnChildByTypeAndName(type, name)
            : null;

        if (isOverlayNode)
        {
            if (existing is null)
            {
                throw new ParseException(
                    $"Overlay operation requested for [{type}:{name}] but no existing metadata found to merge into",
                    ErrorCode.ERR_OVERLAY_NO_TARGET, st.Source, path);
            }
            existing.SetIsMerge(true);
            ParseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, st, path);
            return existing;
        }

        // Default: no operator → silently reuse existing or create new.
        if (existing is not null)
        {
            ParseNodeInto(nodeData, existing, accumRoot, inheritedContextPkg, st, path);
            return existing;
        }

        // Not found (or unnamed) → create new.
        return ParseNodeFresh(
            type, subType, nodeData, accumRoot, inheritedContextPkg, st, path,
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
        string path,
        string contextPkg)
    {
        // package
        if (nodeData.TryGetProperty(RESERVED_KEY_PACKAGE, out JsonElement rawPkg))
        {
            if (rawPkg.ValueKind != JsonValueKind.String)
            {
                ReportProblem(
                    $"\"{RESERVED_KEY_PACKAGE}\" must be a string at {path}",
                    st, path, ErrorCode.ERR_BAD_ATTR_VALUE);
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
                    $"\"{RESERVED_KEY_EXTENDS}\" must be a string at {path}",
                    st, path, ErrorCode.ERR_UNRESOLVED_SUPER);
            }
            else
            {
                model.SetSuper(rawExtends.GetString()!);
            }
        }

        // abstract — structural key (true → abstract node)
        if (nodeData.TryGetProperty(RESERVED_KEY_ABSTRACT, out JsonElement rawAbstract))
        {
            if (rawAbstract.ValueKind != JsonValueKind.True && rawAbstract.ValueKind != JsonValueKind.False)
            {
                ReportProblem(
                    $"\"{RESERVED_KEY_ABSTRACT}\" must be a boolean at {path}",
                    st, path, ErrorCode.ERR_BAD_ATTR_VALUE);
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
                    $"\"{RESERVED_KEY_IS_ARRAY}\" must be a boolean at {path}",
                    st, path, ErrorCode.ERR_BAD_ATTR_VALUE);
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
        AttrSchema? spec = registry.AttrsOf(type, subType).FirstOrDefault(a => a.Name == attrName);
        if (spec is null || spec.ValueType != ATTR_SUBTYPE_STRINGARRAY) return value;
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
        ParseState st,
        string path)
    {
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
                    st, path, ErrorCode.ERR_UNKNOWN_ATTR);
                continue;
            }

            // Inline attribute (@-prefixed).
            string attrName = key[ATTR_PREFIX.Length..];
            JsonElement rawVal = prop.Value;

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
                    st, path, ErrorCode.ERR_BAD_ATTR_VALUE);
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
        ParseState st,
        string path)
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
                $"\"{RESERVED_KEY_CHILDREN}\" must be an array at {path}",
                st, path, ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);
            return;
        }

        int i = 0;
        foreach (JsonElement childEntry in rawChildren.EnumerateArray())
        {
            string childPath = $"{path}.{RESERVED_KEY_CHILDREN}[{i}]";
            i++;

            if (childEntry.ValueKind != JsonValueKind.Object)
            {
                ReportProblem(
                    $"Child at {childPath} must be an object",
                    st, childPath, ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);
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
                ReportProblem(msg, st, childPath, ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);
                continue;
            }

            // keyCount == 1 guarantees childKey was assigned above (null-forgiving is safe).
            string singleChildKey = childKey!;
            JsonElement childData = childEntry.GetProperty(singleChildKey);
            string childNodePath = $"{childPath}.{singleChildKey}";

            if (childData.ValueKind != JsonValueKind.Object)
            {
                ReportProblem(
                    $"Child wrapper \"{singleChildKey}\" at {childNodePath} must contain an object",
                    st, childNodePath, ErrorCode.ERR_TOP_LEVEL_NOT_OBJECT);
                continue;
            }

            SplitKey childSplit = SplitTypeKey(singleChildKey, st.Registry);
            string childType = childSplit.Type;
            string childSubType = childSplit.SubType;
            bool explicitSubType = childSplit.Explicit;

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
                        childTypeCode, st.Source, childNodePath));
                    continue; // skip this child
                }
            }

            // --- Special handling for "attr" child nodes ---
            if (childType == TYPE_ATTR)
            {
                ParseAttrChild(parent, childType, childSubType, childData, st, childNodePath);
            }
            else
            {
                MetaData? childModel = CreateOrFindMetaData(
                    childType, childSubType, childData, parent, accumRoot,
                    inheritedContextPkg, st, childNodePath);

                // Overlay and same-name-reuse paths in CreateOrFindMetaData return an existing
                // child that is already in parent's own children; only AddChild for freshly
                // created nodes to avoid duplicates.
                var owned = parent.OwnChildren();
                if (childModel is not null && !owned.Contains(childModel))
                    parent.AddChild(childModel);
            }
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
        ParseState st,
        string path)
    {
        string? attrName = TryGetString(attrData, RESERVED_KEY_NAME);
        bool hasValue = attrData.TryGetProperty(RESERVED_KEY_VALUE, out JsonElement attrValue);

        if (string.IsNullOrEmpty(attrName))
        {
            ReportProblem(
                $"attr child at {path} requires a non-empty \"{RESERVED_KEY_NAME}\" string",
                st, path, ErrorCode.ERR_MISSING_REQUIRED_ATTR);
            return;
        }

        if (!hasValue)
        {
            ReportProblem(
                $"attr child \"{attrName}\" at {path} is missing \"{RESERVED_KEY_VALUE}\"",
                st, path, ErrorCode.ERR_MISSING_REQUIRED_ATTR);
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
                st, path, ErrorCode.ERR_BAD_ATTR_VALUE);
            return;
        }

        MetaData attrModel = attrDef is not null
            ? attrDef.Factory(attrDef.TypeId, attrName)
            : new MetaRoot(new TypeId(attrType, resolvedSubType), attrName);

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
