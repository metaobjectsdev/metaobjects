// MetaDataLoader — core loader pipeline.
//
// Ported from typescript/packages/metadata/src/loader/meta-data-loader.ts
//
// Owns the load pipeline contract, lifecycle state, and accessor members.
// Load() sequences IMetaDataSource reads into one accumulating tree using the
// parser's IntoRoot param for merge-during-parse.
//
// Lifecycle phases: "uninitialized" → "loading" → "loaded" | "error"
// (mirrors Java MetaDataLoader's UNINITIALIZED → LOADING → LOADED → ERROR).
//
// This is a one-shot pipeline: calling Load() again after completion throws.

using System.IO;
using System.Text.Json.Nodes;
using MetaObjects.Meta;
using MetaObjects.Shared;
using MetaObjects.Source;
using YamlDotNet.RepresentationModel;

namespace MetaObjects.Loader;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// <summary>The result of a load run.</summary>
/// <param name="EnvelopeWarnings">
/// FR5c — envelope-shaped warnings (e.g. <c>WARN_DUPLICATE_DECLARATION</c>)
/// produced during the parse/merge pipeline. Distinct from the legacy
/// <see cref="Warnings"/> string channel: those messages get wrapped in a
/// <c>WARN_LEGACY</c> envelope at the loader boundary, while envelope warnings
/// already carry their own code + source and are surfaced unchanged. Default
/// is an empty list when no envelope warnings were emitted.
/// </param>
public sealed record LoadResult(
    MetaRoot Root,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<MetaError> Errors,
    string State = "loaded",
    IReadOnlyList<LoaderWarning>? EnvelopeWarnings = null);

/// <summary>
/// Core metadata loader pipeline. Consumes a list of
/// <see cref="IMetaDataSource"/> instances, reads and parses each in order,
/// and merges them into one <see cref="MetaRoot"/>.
/// </summary>
public class MetaDataLoader
{
    private readonly TypeRegistry _registry;
    /// <summary>Whether to freeze the tree after loading. Visible to subclasses for synthetic-root paths.</summary>
    protected readonly bool Freeze;
    private readonly bool _strict;

    private string _state = "uninitialized";
    private MetaRoot? _root;

    // -------------------------------------------------------------------------
    // Constructors
    // -------------------------------------------------------------------------

    /// <summary>Construct with the default core-types registry, freeze=true, strict=false.</summary>
    public MetaDataLoader()
        : this(DefaultRegistry()) { }

    /// <summary>Full constructor — registry required; freeze and strict configurable (defaults: freeze=true, strict=false).</summary>
    public MetaDataLoader(TypeRegistry registry, bool freeze = true, bool strict = false)
    {
        _registry = registry;
        Freeze = freeze;
        _strict = strict;
    }

    private static TypeRegistry DefaultRegistry() =>
        Provider.ComposeRegistry([
            CoreTypes.CoreTypesProvider,
            // DB-domain field attrs (@column / @db.indexed / @dbColumnType) — Extend over core
            // field types. Mirrors Java's CoreDBMetaDataProvider and TS's dbProvider.
            MetaObjects.Persistence.Db.DbMetaDataProvider.Instance,
            // FR-033 concern providers — re-home the UI / prompt attrs out of the core type
            // classes (read spec/metamodel/ui.json + prompt.json). The prompt provider absorbs
            // the @xmlText marker the former TemplateTypesProvider registered. Mirrors the TS
            // ui/prompt provider split (and Java/Python).
            MetaObjects.Presentation.Ui.UiMetaDataProvider.Instance,
            MetaObjects.Template.PromptMetaDataProvider.Instance,
        ]);

    // -------------------------------------------------------------------------
    // Static factories (the 99% case, cross-language consistent)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Convenience: build a <see cref="DirectorySource"/> for <paramref name="directory"/>
    /// and load all discovered files in deterministic order. <paramref name="strict"/>
    /// (default false / lax) makes an undeclared own <c>@attr</c> an
    /// <c>ERR_UNKNOWN_ATTR</c> load error (ADR-0023) — <c>verify</c> opts into strict.
    /// </summary>
    public static LoadResult FromDirectory(string directory, DirectorySource.Options? opts = null, bool strict = false)
        => FromDirectory(directory, DefaultRegistry(), opts, strict);

    /// <summary>
    /// Registry-aware overload: build a <see cref="DirectorySource"/> and load
    /// using the supplied <paramref name="registry"/>. A directory-read failure
    /// is surfaced as a collected <see cref="MetaError"/> on a synthetic empty
    /// root (no throw) — mirrors the TS <c>loadDirectory</c> behavior.
    /// </summary>
    public static LoadResult FromDirectory(string directory, TypeRegistry registry, DirectorySource.Options? opts = null, bool strict = false)
    {
        var src = new DirectorySource(directory, opts);
        List<IMetaDataSource> sources;
        try
        {
            sources = src.Expand().Cast<IMetaDataSource>().ToList();
        }
        catch (Exception ex)
        {
            // Directory-read failure: synthesize an error result directly so
            // state reflects "error" (calling Load([]) would set state to
            // "loaded" because no errors had been collected yet at that point).
            var loader = new MetaDataLoader(registry, strict: strict);
            loader.SetState("error");
            var root = MakeSyntheticRoot();
            if (loader.Freeze)
            {
                root.Freeze();
            }
            var errors = new List<MetaError>
            {
                new($"Failed to read directory \"{directory}\": {ex.Message}", ErrorCode.ERR_UNKNOWN),
            };
            return new LoadResult(root, Array.Empty<string>(), errors.AsReadOnly(), "error");
        }
        return new MetaDataLoader(registry, strict: strict).Load(sources);
    }

    /// <summary>
    /// Convenience: wrap each URI in a <see cref="UriSource"/> and load in order.
    /// </summary>
    public static LoadResult FromUris(IReadOnlyList<Uri> uris)
        => FromUris(uris, DefaultRegistry());

    /// <summary>
    /// Registry-aware overload: wrap each URI in a <see cref="UriSource"/> and
    /// load using the supplied <paramref name="registry"/>.
    /// </summary>
    public static LoadResult FromUris(IReadOnlyList<Uri> uris, TypeRegistry registry)
    {
        var loader = new MetaDataLoader(registry);
        var sources = uris.Select(u => (IMetaDataSource)new UriSource(u)).ToList();
        return loader.Load(sources);
    }

    /// <summary>
    /// Convenience: load a single in-memory string of the given format.
    /// </summary>
    public static LoadResult FromString(string content, MetaDataFormat format)
        => FromString(content, format, DefaultRegistry());

    /// <summary>
    /// Registry-aware overload: load a single in-memory string of the given
    /// format using the supplied <paramref name="registry"/>.
    /// </summary>
    public static LoadResult FromString(string content, MetaDataFormat format, TypeRegistry registry)
    {
        var loader = new MetaDataLoader(registry);
        return loader.Load(new IMetaDataSource[] { new InMemoryStringSource(content, format: format) });
    }

    // -------------------------------------------------------------------------
    // Public properties
    // -------------------------------------------------------------------------

    /// <summary>Current lifecycle state: "uninitialized" | "loading" | "loaded" | "error".</summary>
    public string State => _state;

    /// <summary>The TypeRegistry this loader uses to resolve type definitions.</summary>
    public TypeRegistry Registry => _registry;

    /// <summary>
    /// The loaded root. Accessible once Load() has completed ("loaded" or "error"
    /// state). Throws if called before or during loading.
    /// </summary>
    public MetaRoot Root
    {
        get
        {
            CheckStateForRead();
            return _root!;
        }
    }

    private void CheckStateForRead()
    {
        if (_state == "uninitialized" || _state == "loading")
        {
            throw new InvalidOperationException(
                $"MetaDataLoader.Root accessed before loading has completed (state: \"{_state}\"). " +
                "Call Load() first.");
        }
    }

    // -------------------------------------------------------------------------
    // ParseSource — overridable format-dispatch seam
    // -------------------------------------------------------------------------

    /// <summary>
    /// Parse one source's raw content into a <see cref="ParseResult"/>. Dispatches by
    /// <see cref="IMetaDataSource.Format"/>:
    /// <list type="bullet">
    ///   <item><see cref="MetaDataFormat.Json"/> → <see cref="Parser.ParseJson"/></item>
    ///   <item><see cref="MetaDataFormat.Yaml"/> → <see cref="ParserYaml.ParseYaml"/></item>
    /// </list>
    /// </summary>
    protected virtual ParseResult ParseSource(
        string content,
        IMetaDataSource source,
        ParseOptions parseOpts)
    {
        return source.Format switch
        {
            MetaDataFormat.Json => Parser.ParseJson(content, parseOpts),
            MetaDataFormat.Yaml => ParserYaml.ParseYaml(content, parseOpts),
            _ => throw new InvalidOperationException(
                $"MetaDataLoader: unsupported format \"{source.Format}\" for source \"{source.Id}\""),
        };
    }

    // -------------------------------------------------------------------------
    // #160 — overlay-only source partition (stable, overlay-only sources last)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Stable-partition <paramref name="sources"/> so that "overlay-only" sources —
    /// every top-level object declaration carries <c>overlay: true</c>, i.e. the
    /// source declares no base objects of its own and only re-opens objects declared
    /// elsewhere — are parsed LAST. Preserves original order within each group.
    /// <para>
    /// A source whose content can't be read or structurally scanned stays in the base
    /// group (never overlay-only) — this partition must never crash the loader; any
    /// genuine read/parse failure surfaces later, in the real parse loop.
    /// </para>
    /// </summary>
    private static IReadOnlyList<IMetaDataSource> PartitionOverlayLast(
        IReadOnlyList<IMetaDataSource> sources)
    {
        var baseSources = new List<IMetaDataSource>();
        var overlayOnly = new List<IMetaDataSource>();
        foreach (IMetaDataSource source in sources)
        {
            bool isOverlayOnly = false;
            try
            {
                isOverlayOnly = IsOverlayOnlySource(source.Read(), source.Format);
            }
            catch
            {
                isOverlayOnly = false;
            }
            (isOverlayOnly ? overlayOnly : baseSources).Add(source);
        }
        baseSources.AddRange(overlayOnly);
        return baseSources;
    }

    /// <summary>
    /// Structurally scan a source's raw content (JSON via <see cref="JsonNode"/>;
    /// sigil-free authoring YAML via the raw YAML walker — <c>overlay: true</c> is a
    /// bare key before desugar) and report whether every top-level object declaration
    /// under <c>metadata.root.children</c> carries <c>overlay: true</c> (and there is
    /// at least one).
    /// </summary>
    private static bool IsOverlayOnlySource(string content, MetaDataFormat format)
    {
        // Strip UTF-8 BOM (mirrors Parser.ParseJson / ParserYaml).
        string normalized = content.Length > 0 && content[0] == '﻿' ? content[1..] : content;

        JsonNode? parsed;
        switch (format)
        {
            case MetaDataFormat.Json:
                parsed = JsonNode.Parse(normalized);
                break;
            case MetaDataFormat.Yaml:
                var stream = new YamlStream();
                using (var reader = new StringReader(normalized))
                {
                    stream.Load(reader);
                }
                YamlNode? yamlRoot = stream.Documents.Count > 0
                    ? stream.Documents[0].RootNode
                    : null;
                parsed = YamlPositionWalker.Walk(yamlRoot);
                break;
            default:
                return false;
        }
        return RootIsOverlayOnly(parsed);
    }

    /// <summary>
    /// True when the structurally-parsed root has ≥1 child and every top-level child
    /// node carries <c>overlay: true</c> (declares no base objects).
    /// </summary>
    private static bool RootIsOverlayOnly(JsonNode? parsed)
    {
        if (parsed is not JsonObject rootWrapper) return false;
        const string rootKey = "metadata.root"; // TYPE_METADATA + "." + SUBTYPE_ROOT
        if (rootWrapper[rootKey] is not JsonObject rootBody) return false;
        if (rootBody[Structural.RESERVED_KEY_CHILDREN] is not JsonArray children) return false;
        if (children.Count == 0) return false;
        foreach (JsonNode? child in children)
        {
            if (child is not JsonObject wrapper || wrapper.Count == 0) return false;
            foreach (var kvp in wrapper)
            {
                if (kvp.Value is not JsonObject body) return false;
                JsonNode? overlay = body[Structural.RESERVED_KEY_OVERLAY];
                bool isOverlay = overlay is JsonValue v
                    && v.TryGetValue(out bool b)
                    && b;
                if (!isOverlay) return false;
            }
        }
        return true;
    }

    // -------------------------------------------------------------------------
    // Load — synchronous pipeline over IReadOnlyList<IMetaDataSource>
    // -------------------------------------------------------------------------

    /// <summary>
    /// Load metadata from one or more <see cref="IMetaDataSource"/> instances.
    /// Sources are read in order; each source is parsed and merged into the
    /// accumulating root. Source read failures are collected as errors — no throw.
    /// <para>
    /// This is a one-shot pipeline. Calling Load() again after completion throws.
    /// </para>
    /// </summary>
    public LoadResult Load(IReadOnlyList<IMetaDataSource> sources)
    {
        if (_state == "loaded" || _state == "error")
        {
            throw new InvalidOperationException(
                "MetaDataLoader cannot be reused after Load() completes. " +
                "Construct a new MetaDataLoader for additional loads.");
        }

        _state = "loading";
        var warnings = new List<string>();
        var errors = new List<MetaError>();
        // FR5c — envelope-shaped warnings (WARN_DUPLICATE_DECLARATION et al.)
        // surface here untouched. Distinct from the legacy `warnings: string[]`
        // channel: those are wrapped in a WARN_LEGACY envelope at the boundary,
        // while these already carry their own code + source.
        var envelopeWarnings = new List<LoaderWarning>();

        MetaRoot? root = null;

        // #160 — this loader merges DURING parse (each source is streamed into the
        // accumulating `root` via ParseOptions.IntoRoot). A source that ONLY re-opens
        // objects declared elsewhere (every top-level object carries `overlay: true`)
        // must therefore be parsed AFTER the sources that declare those base objects,
        // or the overlaid node lands ahead of its base entities — leaving a projection
        // before its base so order-dependent super-resolution can't resolve its
        // `extends`/`@via`, and the streaming merge errors ERR_OVERLAY_NO_TARGET.
        // Directory discovery order is not guaranteed to present base files first
        // (basename sort can put an overlay-only file first), so stable-partition
        // overlay-only sources to the END here, making the merge order-independent.
        // Stable within each group preserves last-writer-wins overlay semantics.
        sources = PartitionOverlayLast(sources);

        // Parse all sources with super resolution DEFERRED so cross-file super
        // refs work — one source may declare a super target defined in a later
        // source. A second pass (Task 5.1) resolves everything against the
        // fully-merged root.
        foreach (IMetaDataSource source in sources)
        {
            string content;
            try
            {
                content = source.Read();
            }
            catch (Exception ex)
            {
                // FR5a / ADR-0009: a read failure has a file but no JSONPath yet.
                var envelope = new JsonSource(new[] { source.Id }, "$");
                errors.Add(new MetaError(
                    $"Failed to read source \"{source.Id}\": {ex.Message}",
                    ErrorCode.ERR_UNKNOWN,
                    source.Id,
                    Envelope: envelope));
                continue;
            }

            var parseOpts = new ParseOptions(_registry)
            {
                Strict = _strict,
                SourceName = source.Id,
                DeferSuperResolution = true,
                IntoRoot = root,  // null on first source; accumulating root thereafter
            };

            try
            {
                ParseResult parseResult = ParseSource(content, source, parseOpts);
                warnings.AddRange(parseResult.Warnings);
                errors.AddRange(parseResult.Errors);
                // FR5c — collect envelope-shaped warnings (already carry code +
                // source). Also surface their messages on the legacy string
                // channel so existing consumers (e.g. the conformance runner's
                // expected-warnings.json check) see the same messages.
                if (parseResult.EnvelopeWarnings is { Count: > 0 } parseEnvelopeWarnings)
                {
                    envelopeWarnings.AddRange(parseEnvelopeWarnings);
                    foreach (LoaderWarning w in parseEnvelopeWarnings)
                    {
                        warnings.Add(w.Message);
                    }
                }
                root = parseResult.Root;
            }
            catch (ParseException ex)
            {
                errors.Add(new MetaError(ex.Message, ex.Code, ex.SourceFile, ex.NodePath, ex.Envelope));
            }
        }

        // After the merge loop, BEFORE freeze — validation passes.
        if (root is not null)
        {
            // Pass 1: resolveDeferredSupers — resolve cross-file extends refs against the full merged root.
            var failures = SuperResolve.ResolveDeferredSupers(root);
            foreach (var failure in failures)
            {
                // FR5d — emit format=resolved with referrer + target. The
                // referrer's parse-time source supplies files + jsonPath (the
                // location of the broken `extends:` on disk); referrer = the
                // declaring node's FQN; target = the unresolved supertype ref.
                ErrorSource envelope = failure.Node is not null
                    ? ResolvedSource.From(failure.Node.Source, failure.NodeFqn, failure.Ref)
                    : new ResolvedSource(
                        Files: Array.Empty<string>(),
                        Referrer: failure.NodeFqn,
                        Target: failure.Ref);
                if (failure.Kind == SuperResolve.SuperFailureKind.TargetMismatch)
                {
                    // FR-024 — a dotted child-targeting ref resolved, but the target's
                    // type/subtype differs from the extending node's. Dotted-only check.
                    SuperResolve.TypeIdentity? r = failure.Referrer;
                    SuperResolve.TypeIdentity? t = failure.Target;
                    errors.Add(new MetaError(
                        $"the extends target '{failure.Ref}' is {t?.Type}.{t?.SubType} but the extending node '{failure.NodeFqn}' is {r?.Type}.{r?.SubType} — a dotted extends must target a node of the same type and subtype",
                        ErrorCode.ERR_EXTENDS_TARGET_MISMATCH,
                        Envelope: envelope));
                    continue;
                }
                errors.Add(new MetaError(
                    $"the SuperClass '{failure.Ref}' does not exist (referenced by {failure.NodeFqn})",
                    ErrorCode.ERR_UNRESOLVED_SUPER,
                    Envelope: envelope));
            }

            // Pass 2: subtype rules (FR-024 value-purity / projection-licensing /
            // identity-name-required; entity should have a primary identity)
            var subtypeResult = ValidationPasses.ValidateSubtypeRules(root);
            errors.AddRange(subtypeResult.Errors);
            warnings.AddRange(subtypeResult.Warnings);

            // Pass 2b: FR-024 B3 — projection identity pass-through + key correspondence
            errors.AddRange(ValidationPasses.ValidateIdentityPassthrough(root));

            // Pass 3: dataGrid @defaultSortField cross-reference
            errors.AddRange(ValidationPasses.ValidateDataGridSortFields(root));

            // Pass 4: filterable-without-index drift warning
            warnings.AddRange(ValidationPasses.ValidateFilterableHasIndex(root));

            // Pass 4b: @filterable on a subtype with no operator band → error (SP-H Unit9)
            errors.AddRange(ValidationPasses.ValidateFilterableHasSupportedOps(root));

            // Pass 5: origin path validation (FR-024 B5/B6 — @via inference,
            // cardinality, extends/origin agreement)
            errors.AddRange(ValidationPasses.ValidateOriginPaths(root));

            // ADR-0042 — the cross-package ambiguity pass (ERR_AMBIGUOUS_REF) is RETIRED. A bare
            // ref now resolves package-locally at every ref site via NamingRefs.ResolveObjectRef,
            // so ambiguity is unreachable; an unresolved ref fails closed with its per-attr code.

            // Pass 5b: FR-024 B6 — derived-field providability on entities
            errors.AddRange(ValidationPasses.ValidateDerivedFieldProvidability(root));

            // Pass 6: attribute-schema validation. Under strict load (ADR-0023) an
            // own @-attr declared by no provider -> ERR_UNKNOWN_ATTR (Check 0).
            var attrResult = ValidationPasses.ValidateAttrSchema(root, _registry, _strict);
            errors.AddRange(attrResult.Errors);
            warnings.AddRange(attrResult.Warnings);

            // Pass 6b: generic singleton-cardinality (MaxOccurs) enforcement —
            // ERR_TOO_MANY_OCCURRENCES (e.g. two identity.primary on one object).
            errors.AddRange(ValidationPasses.ValidateMaxOccurs(root, _registry));

            // Pass 7: dataGrid @filter value validation (field filterable + op allowed)
            errors.AddRange(ValidationPasses.ValidateDataGridFilterValues(root));

            // Pass 7b (#207): projection view-level @filter — a dangling or
            // aggregate-derived field-ref fails closed with ERR_BAD_ATTR_FILTER.
            errors.AddRange(ValidationPasses.ValidateProjectionFilter(root));

            // Pass 8: @storage cross-attribute validation on field.object
            errors.AddRange(ValidationPasses.ValidateFieldObjectStorage(root));

            // Pass 8b: field.map — exactly one of @valueType (scalar) or @objectRef (VO),
            // and @valueType (when set) must name a known scalar subtype.
            errors.AddRange(ValidationPasses.ValidateFieldMap(root));

            // Pass 9: template @payloadRef / @requiredSlots resolution
            errors.AddRange(ValidationPasses.ValidateTemplatePayloadRefs(root));

            // Pass 10: enum @values content rules (non-empty, identifier-safe, no duplicates)
            errors.AddRange(ValidationPasses.ValidateEnumValues(root));

            // Pass 10b: generalized @default per-type coercibility (Phase B) — non-enum fields'
            // @default must coerce to the field's type (ASCII-only numeric gate, Java parity).
            errors.AddRange(ValidationPasses.ValidateFieldDefaults(root));

            // Pass 11: source-v2 one-primary rule — an object with ≥1 source must
            // have exactly one with role "primary" (own-only).
            errors.AddRange(ValidationPasses.ValidateOnePrimarySource(root));

            // Pass 12: @dbColumnType physical column-type validation (R6 Plan 2b) —
            // own-only closed-value + (subtype × value) pairing check.
            errors.AddRange(ValidationPasses.ValidateDbColumnType(root));

            // Pass 13 (FR-016 / ADR-0018): per-kind physical-name aliases on source.rdb.
            // Validates empty-string, multi-alias, kind-mismatch; emits
            // WARN_LEGACY_PHYSICAL_NAME_ALIAS on the @table-for-non-table-kind
            // legacy spelling. The canonical serializer rewrites legacy on round-trip.
            var physResult = ValidationPasses.ValidateSourcePhysicalNames(root);
            errors.AddRange(physResult.Errors);
            if (physResult.Warnings.Count > 0)
            {
                envelopeWarnings.AddRange(physResult.Warnings);
                foreach (var w in physResult.Warnings)
                {
                    warnings.Add(w.Message);
                }
            }

            // FR-013: field-level @readOnly cross-attribute rules.
            var roResult = ValidationPasses.ValidateFieldReadOnly(root);
            errors.AddRange(roResult.Errors);
            if (roResult.Warnings.Count > 0)
            {
                envelopeWarnings.AddRange(roResult.Warnings);
                foreach (var w in roResult.Warnings)
                {
                    warnings.Add(w.Message);
                }
            }

            // FR-014: TPH discriminator cross-attribute rules.
            errors.AddRange(ValidationPasses.ValidateDiscriminator(root));

            // FR-015: source.rdb @parameterRef typed-input rules.
            errors.AddRange(ValidationPasses.ValidateSourceParameterRef(root));

            // Pass 14 (FR-017): M:N relationship slim-vocabulary validation —
            // symmetric-self-join-only / symmetric⊕sourceRefField (ERR_BAD_ATTR_VALUE);
            // junction-two-references / sourceRefField-match / M:N-attr-on-1:N
            // (ERR_INVALID_RELATIONSHIP). Deferred-resolution (own-relationships only).
            errors.AddRange(ValidationPasses.ValidateRelationships(root));

            // index.lookup @fields resolution — every index.lookup must name ≥1 field,
            // and each must exist in the entity's effective field set (ERR_INVALID_INDEX).
            errors.AddRange(ValidationPasses.ValidateIndexLookupFields(root));

            // Phase 2 — validation DERIVED FROM THE TYPE REGISTRY: each node's TypeDefinition
            // carries its reference descriptors (relationship @objectRef, identity.reference
            // @references for core; a downstream provider's type carries its own) + validator,
            // run as one recursive walk over a built-once symbol table.
            errors.AddRange(MetaObjects.Validation.RegisteredValidation.Run(root, _registry));
        }

        // If nothing parsed successfully, synthesize an empty root so callers
        // always get a valid MetaData tree.
        if (root is null)
        {
            root = MakeSyntheticRoot();
            _state = errors.Count > 0 ? "error" : "loaded";
        }
        else
        {
            _state = "loaded";
        }

        // Freeze applies to both paths.
        if (Freeze)
        {
            root.Freeze();
        }

        _root = root;
        return new LoadResult(
            root,
            warnings.AsReadOnly(),
            errors.AsReadOnly(),
            _state,
            envelopeWarnings.AsReadOnly());
    }

    /// <summary>
    /// Internal state setter — used by static factories (e.g. FromDirectory)
    /// that need to short-circuit the pipeline on pre-Load failures and still
    /// report state == "error".
    /// </summary>
    internal void SetState(string state) => _state = state;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static MetaRoot MakeSyntheticRoot() =>
        new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
}
