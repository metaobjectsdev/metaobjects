namespace MetaObjects.Render.Extract;

/// <summary>
/// FROZEN cross-port per-field extraction classification. Names match the conformance corpus
/// expected.json exactly — the runner uses <c>.ToString()</c> comparison.
/// Do not reorder or rename without an ADR.
/// </summary>
public enum FieldExtraction
{
    EXTRACTED,
    // DEFAULTED is reserved (a future @default-backed value); the current engine does not emit it.
    DEFAULTED,
    LOST_OPTIONAL,
    LOST_REQUIRED,
    MALFORMED,
}
