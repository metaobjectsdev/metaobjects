namespace MetaObjects.Render.Extract;

/// <summary>
/// Mutable accumulator of per-field extraction classification, the degenerate-response
/// flag, and coercion notes. Populated during a single extract pass; read after the pass.
/// </summary>
public sealed class ExtractionReport
{
    private readonly Dictionary<string, FieldExtraction> _states = new(StringComparer.Ordinal);
    private readonly List<Coercion> _coercions = [];
    private bool _empty;

    /// <summary>Record the extraction classification for a field path.</summary>
    public void Set(string path, FieldExtraction state) => _states[path] = state;

    /// <summary>Append a coercion note.</summary>
    public void AddCoercion(Coercion coercion) => _coercions.Add(coercion);

    /// <summary>Flag the response as degenerate (the entire document was empty/absent).</summary>
    public void MarkEmpty() => _empty = true;

    /// <summary>True when the document was empty/absent.</summary>
    public bool IsEmpty => _empty;

    /// <summary>A snapshot of all per-field extraction states (insertion order preserved).</summary>
    public IReadOnlyDictionary<string, FieldExtraction> States() =>
        new Dictionary<string, FieldExtraction>(_states, StringComparer.Ordinal);

    /// <summary>A snapshot of all recorded coercions in recording order.</summary>
    public IReadOnlyList<Coercion> Coercions() => _coercions.ToList().AsReadOnly();

    /// <summary>All field paths classified as <see cref="FieldExtraction.LOST_REQUIRED"/>.</summary>
    public IReadOnlyList<string> LostRequired() => ByState(FieldExtraction.LOST_REQUIRED);

    /// <summary>All field paths classified as <see cref="FieldExtraction.MALFORMED"/>.</summary>
    public IReadOnlyList<string> Malformed() => ByState(FieldExtraction.MALFORMED);

    /// <summary>True if any field was classified as <see cref="FieldExtraction.LOST_REQUIRED"/>.</summary>
    public bool HasLostRequired() => LostRequired().Count > 0;

    private IReadOnlyList<string> ByState(FieldExtraction target)
    {
        var result = new List<string>();
        foreach (var (path, state) in _states)
            if (state == target) result.Add(path);
        return result.AsReadOnly();
    }
}
