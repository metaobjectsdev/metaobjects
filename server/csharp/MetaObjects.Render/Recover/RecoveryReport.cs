namespace MetaObjects.Render.Recover;

/// <summary>
/// Mutable accumulator of per-field recovery classification, the degenerate-response
/// flag, and coercion notes. Populated during a single recover pass; read after the pass.
/// </summary>
public sealed class RecoveryReport
{
    private readonly Dictionary<string, FieldRecovery> _states = new(StringComparer.Ordinal);
    private readonly List<Coercion> _coercions = [];
    private bool _empty;

    /// <summary>Record the recovery classification for a field path.</summary>
    public void Set(string path, FieldRecovery state) => _states[path] = state;

    /// <summary>Append a coercion note.</summary>
    public void AddCoercion(Coercion coercion) => _coercions.Add(coercion);

    /// <summary>Flag the response as degenerate (the entire document was empty/absent).</summary>
    public void MarkEmpty() => _empty = true;

    /// <summary>True when the document was empty/absent.</summary>
    public bool IsEmpty => _empty;

    /// <summary>A snapshot of all per-field recovery states (insertion order preserved).</summary>
    public IReadOnlyDictionary<string, FieldRecovery> States() =>
        new Dictionary<string, FieldRecovery>(_states, StringComparer.Ordinal);

    /// <summary>A snapshot of all recorded coercions in recording order.</summary>
    public IReadOnlyList<Coercion> Coercions() => _coercions.ToList().AsReadOnly();

    /// <summary>All field paths classified as <see cref="FieldRecovery.LOST_REQUIRED"/>.</summary>
    public IReadOnlyList<string> LostRequired() => ByState(FieldRecovery.LOST_REQUIRED);

    /// <summary>All field paths classified as <see cref="FieldRecovery.MALFORMED"/>.</summary>
    public IReadOnlyList<string> Malformed() => ByState(FieldRecovery.MALFORMED);

    /// <summary>True if any field was classified as <see cref="FieldRecovery.LOST_REQUIRED"/>.</summary>
    public bool HasLostRequired() => LostRequired().Count > 0;

    private IReadOnlyList<string> ByState(FieldRecovery target)
    {
        var result = new List<string>();
        foreach (var (path, state) in _states)
            if (state == target) result.Add(path);
        return result.AsReadOnly();
    }
}
