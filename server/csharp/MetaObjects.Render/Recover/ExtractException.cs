namespace MetaObjects.Render.Recover;

/// <summary>
/// Thrown by a generated <c>&lt;Name&gt;Extractor.Extract(…)</c> when the tolerant recover lost one
/// or more fields the metadata marked <c>@required</c> (i.e. <see cref="RecoveryReport.HasLostRequired"/>).
///
/// <para>The <c>extract</c> tier is the strict opt-in over the never-throws <c>recover</c>: it maps the
/// recovered all-nullable mirror onto the strict typed payload, but only when nothing required was
/// lost. A lost required field is a hard error here (unlike <c>recover</c>, which classifies it in the
/// report and returns a best-effort null). Carries the full <see cref="RecoveryReport"/> for callers
/// that want to inspect the classification; the message lists the lost required paths.</para>
///
/// <para>This is the sibling of <see cref="RecoverException"/> (raised by
/// <see cref="RecoveryResult{T}.OrThrow"/>) — distinct so the <c>extract</c>-tier failure is
/// nameable on its own. It carries the report (not just the paths) so callers can read the coercion
/// notes / per-field states alongside the lost-required set.</para>
/// </summary>
public sealed class ExtractException : Exception
{
    /// <summary>The recovery report from the recover pass that lost a required field.</summary>
    public RecoveryReport Report { get; }

    /// <summary>The dotted paths of the required fields that were lost (a snapshot of <see cref="RecoveryReport.LostRequired"/>).</summary>
    public IReadOnlyList<string> LostRequired { get; }

    public ExtractException(RecoveryReport report)
        : this(report, report.LostRequired())
    {
    }

    private ExtractException(RecoveryReport report, IReadOnlyList<string> lostRequired)
        : base("extract lost required field(s): [" + string.Join(", ", lostRequired) + "]")
    {
        Report = report;
        LostRequired = lostRequired;
    }
}
