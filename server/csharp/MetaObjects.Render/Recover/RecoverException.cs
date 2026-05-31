namespace MetaObjects.Render.Recover;

/// <summary>
/// Thrown by <see cref="RecoveryResult{T}.OrThrow"/> when a tolerant recover lost one or more
/// fields the schema marked <c>required</c> (i.e. <see cref="RecoveryReport.HasLostRequired"/>).
///
/// <para>Recover itself NEVER throws — lost/malformed fields are classified in the
/// <see cref="RecoveryReport"/>. <c>OrThrow()</c> is the opt-in strict gate for callers who want
/// a lost required field to be a hard error rather than a best-effort null.</para>
/// </summary>
public sealed class RecoverException : Exception
{
    /// <summary>The dotted paths of the required fields that were lost.</summary>
    public IReadOnlyList<string> LostRequired { get; }

    public RecoverException(IReadOnlyList<string>? lostRequired)
        : base("recover lost required field(s): [" + string.Join(", ", lostRequired ?? Array.Empty<string>()) + "]")
    {
        LostRequired = lostRequired is null
            ? Array.Empty<string>()
            : new List<string>(lostRequired).AsReadOnly();
    }
}
