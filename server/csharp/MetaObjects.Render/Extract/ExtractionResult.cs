namespace MetaObjects.Render.Extract;

/// <summary>
/// Typed result of a generated <c>Extract(…)</c> call: best-effort typed record
/// (null-component values where fields were lost/malformed) plus the extraction report.
/// </summary>
public sealed record ExtractionResult<T>(T Data, ExtractionReport Report)
{
    /// <summary>
    /// Strict opt-in gate (Phase B). Returns <see cref="Data"/> when the extract lost no
    /// required field; otherwise throws a <see cref="ExtractException"/> naming the lost paths.
    ///
    /// <para>Extract itself never throws — this is the explicit "treat a lost required field as
    /// an error" escape hatch for callers who want it.</para>
    /// </summary>
    /// <returns><see cref="Data"/> (may itself be null/partial for non-required losses).</returns>
    /// <exception cref="ExtractException">iff <see cref="ExtractionReport.HasLostRequired"/>.</exception>
    public T OrThrow()
    {
        if (Report.HasLostRequired())
            throw new ExtractException(Report);
        return Data;
    }
}
