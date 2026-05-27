// FR5a / ADR-0009 — Loader error envelope + source-on-node.
//
// Discriminated union over the provenance variants a metadata node or error
// can carry. Cross-port-aligned: every metaobjects port emits the same envelope
// shape so a tool consuming errors from multiple language ports can compare them
// byte-identically.
//
// The C# realization uses a closed `abstract record` hierarchy. Pattern-match on
// the concrete subtype (`is JsonSource js`, `is CodeSource cs`, ...) to access
// variant-specific fields.

namespace MetaObjects.Source;

/// <summary>
/// Provenance envelope for a metadata node or loader error.
/// Closed discriminated union — see the concrete records below.
/// </summary>
public abstract record ErrorSource
{
    /// <summary>The discriminant tag — one of "json"/"yaml"/"merged"/"resolved"/"database"/"code".</summary>
    public abstract string Format { get; }
}

/// <summary>
/// Authoring-time: single JSON file (FR5a).
///
/// <para>
/// FR5b finalized 2026-05-27 — buildTree-emitted errors from a YAML input now
/// emit <see cref="YamlSource"/> (format <c>"yaml"</c>) carrying the optional
/// <see cref="YamlPosition"/>. The <see cref="YamlPosition"/> field stays
/// declared on this variant for backward shape-compat with any FR5b-interim
/// envelopes still serialized to disk; new YAML errors no longer use it.
/// </para>
/// </summary>
/// <param name="Files">Length-1 file list (FR5a invariant: exactly one file for JSON-source errors).</param>
/// <param name="JsonPath">Canonical JSONPath string for the node within <paramref name="Files"/>[0].</param>
/// <param name="YamlPosition">FR5b — optional YAML position when the canonical JSON was lowered from a YAML input.</param>
public sealed record JsonSource(
    IReadOnlyList<string> Files,
    string JsonPath,
    YamlPosition? YamlPosition = null) : ErrorSource
{
    /// <summary>
    /// FR5a invariant: exactly one file. Multi-file provenance lives on
    /// <see cref="MergedSource"/> (FR5c). Enforced at construction so the
    /// type can be trusted by cross-port comparison.
    /// </summary>
    public IReadOnlyList<string> Files { get; init; } = Files.Count == 1
        ? Files
        : throw new ArgumentException(
            $"JsonSource requires exactly one file path; got {Files.Count}. " +
            "Use MergedSource for multi-file provenance.", nameof(Files));

    /// <inheritdoc/>
    public override string Format => "json";
}

/// <summary>
/// Authoring-time: single YAML file with optional source-map positions (FR5b).
/// </summary>
public sealed record YamlSource(
    IReadOnlyList<string> Files,
    string JsonPath,
    YamlPosition? YamlPosition = null) : ErrorSource
{
    /// <inheritdoc/>
    public override string Format => "yaml";
}

/// <summary>Optional YAML line/col source position (FR5b). Lines and columns are 1-based.</summary>
public sealed record YamlPosition(int Line, int Col);

/// <summary>
/// Post-load: overlay merge that produced semantic change (FR5c).
/// </summary>
public sealed record MergedSource(
    IReadOnlyList<string> Files,
    string JsonPath,
    IReadOnlyList<Contributor> Contributors) : ErrorSource
{
    /// <inheritdoc/>
    public override string Format => "merged";
}

/// <summary>
/// Post-load: extends / @via / @objectRef / @payloadRef resolution failure (FR5d).
/// </summary>
public sealed record ResolvedSource(
    IReadOnlyList<string> Files,
    string? JsonPath = null,
    string? Referrer = null,
    string? Target = null) : ErrorSource
{
    /// <inheritdoc/>
    public override string Format => "resolved";
}

/// <summary>
/// Future: database-sourced metadata (FR5e, gated on FR-003).
/// </summary>
public sealed record DatabaseSource(
    DbLocation DbLocation,
    string? JsonPath = null) : ErrorSource
{
    /// <inheritdoc/>
    public override string Format => "database";
}

/// <summary>Database location for a node sourced from a row.</summary>
public sealed record DbLocation(string Table, string Id);

/// <summary>
/// Programmatic / test construction. The default for any node not built by a
/// loader phase. Mirrors TS <c>codeSource(caller?)</c>.
/// </summary>
/// <param name="Caller">Optional human label (e.g. "QueriesTest.makePost").</param>
public sealed record CodeSource(string? Caller = null) : ErrorSource
{
    /// <inheritdoc/>
    public override string Format => "code";

    /// <summary>Canonical singleton for the no-caller case.</summary>
    public static readonly CodeSource Default = new(Caller: null);
}

/// <summary>
/// One contributor in a <see cref="MergedSource"/>.
/// </summary>
/// <param name="File">Path to the contributing file (project-root relative; forward slashes).</param>
/// <param name="Role">"overlay-base" | "overlay-extension" | "extends-base" | "extends-extension".</param>
public sealed record Contributor(string File, string Role);

/// <summary>
/// Optional structural context attached to a loader error (RECOMMENDED per
/// ADR-0009; conformance does not enforce population).
/// </summary>
public sealed record NodeContext(
    string? Type = null,
    string? SubType = null,
    string? Name = null,
    string? Fqn = null);

/// <summary>
/// Envelope shape every loader error conforms to. ADR-0009 §Decision.
/// <para>
/// <see cref="Code"/>, <see cref="Message"/> and <see cref="Source"/> are
/// REQUIRED (conformance-enforced). The remaining fields are RECOMMENDED;
/// FR5a does not populate them, FR5b–FR5e may.
/// </para>
/// </summary>
public sealed record LoaderError(
    ErrorCode Code,
    string Message,
    ErrorSource Source,
    IReadOnlyList<string>? Suggestions = null,
    string? Fixture = null,
    NodeContext? Node = null);

/// <summary>
/// Warning envelope — same shape as <see cref="LoaderError"/> but a WARN_*
/// code (today stored as a string until the cross-port WARN_* taxonomy lands;
/// initial code per ADR-0009: <c>WARN_DUPLICATE_DECLARATION</c>).
/// </summary>
public sealed record LoaderWarning(
    string Code,
    string Message,
    ErrorSource Source,
    IReadOnlyList<string>? Suggestions = null,
    string? Fixture = null,
    NodeContext? Node = null);
