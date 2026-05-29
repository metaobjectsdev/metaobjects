namespace MetaObjects.Render.Recover;

/// <summary>
/// Typed result of a generated <c>Recover(…)</c> call: best-effort typed record
/// (null-component values where fields were lost/malformed) plus the recovery report.
/// </summary>
public sealed record RecoveryResult<T>(T Data, RecoveryReport Report);
