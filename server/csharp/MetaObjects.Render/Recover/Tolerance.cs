namespace MetaObjects.Render.Recover;

/// <summary>
/// STRICT: case-sensitive, minimal repair.
/// NORMAL: case-insensitive keys/tags (default).
/// LOOSE: reserved for future maximal-repair behavior (currently behaves identically to NORMAL).
/// </summary>
public enum Tolerance
{
    Strict,
    Normal,
    Loose,
}
