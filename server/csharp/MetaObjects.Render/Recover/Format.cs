// C# PascalCase enum members (Json, Xml).
// The conformance corpus schema.json uses "JSON"/"XML" — the conformance runner
// maps those UPPER strings to these members.

namespace MetaObjects.Render.Recover;

/// <summary>Output format that the recover engine will parse.</summary>
public enum Format
{
    Json,
    Xml,
}
