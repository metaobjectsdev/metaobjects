namespace MetaObjects.Render.Extract;

/// <summary>
/// Thrown by a generated <c>&lt;Name&gt;Extractor.Extract(…)</c> when the tolerant extract lost one
/// or more fields the metadata marked <c>@required</c> (i.e. <see cref="ExtractionReport.HasLostRequired"/>).
///
/// <para>The strict <c>Extract</c> tier is the opt-in over the never-throws <c>ExtractLenient</c>: it
/// maps the extracted all-nullable mirror onto the strict typed payload, but only when nothing required
/// was lost. A lost required field is a hard error here (unlike <c>ExtractLenient</c>, which classifies
/// it in the report and returns a best-effort null). Carries the full <see cref="ExtractionReport"/> for
/// callers that want to inspect the classification; the message lists the lost required paths.</para>
///
/// <para>Also raised by <see cref="ExtractionResult{T}.OrThrow"/>. It carries the report (not just the
/// paths) so callers can read the coercion notes / per-field states alongside the lost-required set.</para>
/// </summary>
public sealed class ExtractException : Exception
{
    /// <summary>The extraction report from the extract pass that lost a required field.</summary>
    public ExtractionReport Report { get; }

    /// <summary>The dotted paths of the required fields that were lost (a snapshot of <see cref="ExtractionReport.LostRequired"/>).</summary>
    public IReadOnlyList<string> LostRequired { get; }

    public ExtractException(ExtractionReport report)
        : this(report, report.LostRequired())
    {
    }

    private ExtractException(ExtractionReport report, IReadOnlyList<string> lostRequired)
        : base("extract lost required field(s): [" + string.Join(", ", lostRequired) + "]")
    {
        Report = report;
        LostRequired = lostRequired;
    }
}
