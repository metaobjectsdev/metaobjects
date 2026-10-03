// Source-name helpers — snake_case + pluralize used by the FR-016 four-step
// physical-name resolution rule on MetaSource.PhysicalName.
//
// Kept narrowly scoped (internal-API) here so MetaObjects core has no
// dependency on the codegen layer's CSharpNaming helpers. Mirrors the TS
// reference helpers in metadata/src/naming.ts (toSnakeCase + pluralize).

namespace MetaObjects.Persistence.Source;

internal static class SourceNaming
{
    /// <summary>
    /// camelCase / PascalCase → snake_case. Mirrors the TS <c>toSnakeCase</c>:
    /// inserts <c>_</c> between lower→upper and at the end of an acronym run
    /// (e.g. <c>URLHost</c> → <c>url_host</c>).
    /// </summary>
    public static string ToSnakeCase(string s)
    {
        if (string.IsNullOrEmpty(s)) return s;
        var sb = new System.Text.StringBuilder(s.Length + 4);
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            if (i > 0 && char.IsUpper(c))
            {
                var prev = s[i - 1];
                var next = i + 1 < s.Length ? s[i + 1] : '\0';
                if (char.IsLower(prev) || char.IsDigit(prev) || (char.IsUpper(prev) && char.IsLower(next)))
                    sb.Append('_');
            }
            sb.Append(char.ToLowerInvariant(c));
        }
        return sb.ToString();
    }

    /// <summary>
    /// FROZEN — the DEFAULT PHYSICAL name derivation only (FR-016/ADR-0018 step 4 on
    /// <see cref="MetaSource"/>'s <c>PhysicalName</c>, reached only when metadata
    /// declares no explicit physical name). Cosmetic pluralization (English-only),
    /// suffix rule only, deliberately with NO already-plural detection: <c>-s|-x|-z|-ch|-sh</c>
    /// → <c>+es</c>; consonant + <c>y</c> → <c>-y +ies</c>; otherwise <c>+s</c>. Mirrors
    /// the TS reference <c>pluralizeTableNameLegacy</c> (metadata/src/naming.ts) — NOT
    /// the TS <c>pluralize</c>, which now differs for an already-plural word.
    /// An adopter's live database was created with this rule; adding the already-plural
    /// check here would make <c>meta migrate</c> propose a rename for every
    /// already-plural entity name on the next run. The API-surface analog
    /// (<c>CSharpNaming.Pluralize</c> in <c>MetaObjects.Codegen</c>) has that fix — this
    /// one must not.
    /// </summary>
    public static string Pluralize(string name)
    {
        if (string.IsNullOrEmpty(name)) return name;
        if (name.EndsWith("s", StringComparison.Ordinal) ||
            name.EndsWith("x", StringComparison.Ordinal) ||
            name.EndsWith("z", StringComparison.Ordinal) ||
            name.EndsWith("ch", StringComparison.Ordinal) ||
            name.EndsWith("sh", StringComparison.Ordinal))
            return name + "es";
        if (name.Length > 1 && name.EndsWith("y", StringComparison.Ordinal) && !"aeiou".Contains(name[^2]))
            return name[..^1] + "ies";
        return name + "s";
    }
}
