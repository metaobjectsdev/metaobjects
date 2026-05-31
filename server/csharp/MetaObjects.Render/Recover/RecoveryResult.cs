namespace MetaObjects.Render.Recover;

/// <summary>
/// Typed result of a generated <c>Recover(…)</c> call: best-effort typed record
/// (null-component values where fields were lost/malformed) plus the recovery report.
/// </summary>
public sealed record RecoveryResult<T>(T Data, RecoveryReport Report)
{
    /// <summary>
    /// Strict opt-in gate (Phase B). Returns <see cref="Data"/> when the recover lost no
    /// required field; otherwise throws a <see cref="RecoverException"/> naming the lost paths.
    ///
    /// <para>Recover itself never throws — this is the explicit "treat a lost required field as
    /// an error" escape hatch for callers who want it.</para>
    /// </summary>
    /// <returns><see cref="Data"/> (may itself be null/partial for non-required losses).</returns>
    /// <exception cref="RecoverException">iff <see cref="RecoveryReport.HasLostRequired"/>.</exception>
    public T OrThrow()
    {
        if (Report.HasLostRequired())
            throw new RecoverException(Report.LostRequired());
        return Data;
    }
}
