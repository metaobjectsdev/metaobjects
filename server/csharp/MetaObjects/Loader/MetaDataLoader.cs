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

using MetaObjects.Meta;
using MetaObjects.Source;

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
        Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]);

    // -------------------------------------------------------------------------
    // Static factories (the 99% case, cross-language consistent)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Convenience: build a <see cref="DirectorySource"/> for <paramref name="directory"/>
    /// and load all discovered files in deterministic order.
    /// </summary>
    public static LoadResult FromDirectory(string directory, DirectorySource.Options? opts = null)
        => FromDirectory(directory, DefaultRegistry(), opts);

    /// <summary>
    /// Registry-aware overload: build a <see cref="DirectorySource"/> and load
    /// using the supplied <paramref name="registry"/>. A directory-read failure
    /// is surfaced as a collected <see cref="MetaError"/> on a synthetic empty
    /// root (no throw) — mirrors the TS <c>loadDirectory</c> behavior.
    /// </summary>
    public static LoadResult FromDirectory(string directory, TypeRegistry registry, DirectorySource.Options? opts = null)
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
            var loader = new MetaDataLoader(registry);
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
        return new MetaDataLoader(registry).Load(sources);
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
                errors.Add(new MetaError(
                    $"the SuperClass '{failure.Ref}' does not exist (referenced by {failure.NodeFqn})",
                    ErrorCode.ERR_UNRESOLVED_SUPER,
                    Envelope: envelope));
            }

            // Pass 2: subtype rules (value must not have primary identity; entity should have one)
            var subtypeResult = ValidationPasses.ValidateSubtypeRules(root);
            errors.AddRange(subtypeResult.Errors);
            warnings.AddRange(subtypeResult.Warnings);

            // Pass 3: dataGrid @defaultSortField cross-reference
            errors.AddRange(ValidationPasses.ValidateDataGridSortFields(root));

            // Pass 4: filterable-without-index drift warning
            warnings.AddRange(ValidationPasses.ValidateFilterableHasIndex(root));

            // Pass 5: origin path validation
            errors.AddRange(ValidationPasses.ValidateOriginPaths(root));

            // Pass 6: attribute-schema validation
            var attrResult = ValidationPasses.ValidateAttrSchema(root, _registry);
            errors.AddRange(attrResult.Errors);
            warnings.AddRange(attrResult.Warnings);

            // Pass 7: dataGrid @filter value validation (field filterable + op allowed)
            errors.AddRange(ValidationPasses.ValidateDataGridFilterValues(root));

            // Pass 8: @storage cross-attribute validation on field.object
            errors.AddRange(ValidationPasses.ValidateFieldObjectStorage(root));

            // Pass 9: template @payloadRef / @requiredSlots resolution
            errors.AddRange(ValidationPasses.ValidateTemplatePayloadRefs(root));

            // Pass 10: enum @values content rules (non-empty, identifier-safe, no duplicates)
            errors.AddRange(ValidationPasses.ValidateEnumValues(root));

            // Pass 11: source-v2 one-primary rule — an object with ≥1 source must
            // have exactly one with role "primary" (own-only).
            errors.AddRange(ValidationPasses.ValidateOnePrimarySource(root));
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
