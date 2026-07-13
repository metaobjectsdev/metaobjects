namespace MetaObjects.Render.Extract;

/// <summary>
/// Mutable accumulator of per-field extraction classification, the degenerate-response
/// flag, and coercion notes. Populated during a single extract pass; read after the pass.
/// </summary>
public sealed class ExtractionReport
{
    private readonly Dictionary<string, FieldExtraction> _states = new(StringComparer.Ordinal);
    private readonly List<Coercion> _coercions = [];
    private readonly List<string> _defaultedRequired = [];
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

    /// <summary>Called by the engine when an absent <b>required</b> field is filled from its <c>@default</c>.</summary>
    public void MarkDefaultedRequired(string path)
    {
        if (!_defaultedRequired.Contains(path)) _defaultedRequired.Add(path);
    }

    /// <summary>Every field the document did not answer, whose value came from its <c>@default</c>.</summary>
    public IReadOnlyList<string> Defaulted() => ByState(FieldExtraction.DEFAULTED);

    /// <summary>
    /// The dangerous subset: <b><c>@required</c> fields the document did NOT answer</b>, whose
    /// value was silently supplied by their <c>@default</c>.
    ///
    /// <para>These do NOT appear in <see cref="LostRequired"/>, and that is deliberate — a default
    /// IS an answer, so the field is not "lost". But it means a <c>@default</c> <b>switches off
    /// loss detection for that field</b>, including in generated code, whose failure signal keys
    /// on <see cref="HasLostRequired"/> — so a required field carrying a default can never make it
    /// fire.</para>
    ///
    /// <para>That is a sharp edge worth being able to SEE. It propagates through <c>extends</c> —
    /// adding an innocuous <c>@default</c> to a shared abstract field silently disables loss
    /// detection for every field inheriting it — and a missing value then becomes
    /// indistinguishable from a real one. Check this alongside <see cref="HasLostRequired"/> when
    /// an absent answer must not be mistaken for a given one.</para>
    /// </summary>
    public IReadOnlyList<string> DefaultedRequired() => _defaultedRequired.AsReadOnly();

    /// <summary>True if any <c>@required</c> field went unanswered and was filled from its default.</summary>
    public bool HasDefaultedRequired() => _defaultedRequired.Count > 0;

    private IReadOnlyList<string> ByState(FieldExtraction target)
    {
        var result = new List<string>();
        foreach (var (path, state) in _states)
            if (state == target) result.Add(path);
        return result.AsReadOnly();
    }
}
