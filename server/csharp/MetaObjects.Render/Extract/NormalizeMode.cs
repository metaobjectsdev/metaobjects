namespace MetaObjects.Render.Extract;

/// <summary>
/// FR-011: the ASCII normalization mode applied to enum variants during tolerant extract.
/// Sourced from the <c>@normalize</c> attr (field -> object.value -> global default "strip").
/// Mirrors the TS <c>NormalizeMode</c> string union (none|collapse|strip).
/// </summary>
public enum NormalizeMode
{
    /// <summary>Exact match only (no normalization).</summary>
    None,

    /// <summary>ASCII-upper + trim + collapse runs of <c>[\s_-]+</c> to a single <c>_</c>.</summary>
    Collapse,

    /// <summary>ASCII-upper + keep only <c>[A-Z0-9]</c> (most forgiving). The FR-011 default.</summary>
    Strip,
}
