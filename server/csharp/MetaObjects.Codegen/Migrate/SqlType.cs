// Canonical, dialect-neutral SQL type. Both the expected-schema builder
// (metadata -> snapshot) and introspection (db -> snapshot) produce this shape;
// diff compares canonical to canonical; emit re-renders to dialect-specific SQL.
//
// Ported from typescript/packages/migrate-ts/src/sql-type.ts. C# records give
// structural equality for free, so the TS `sqlTypeEquals` is just record `==`.

namespace MetaObjects.Codegen.Migrate;

/// <summary>A canonical, dialect-neutral SQL column type.</summary>
public abstract record SqlType
{
    public sealed record Text(long? MaxLength = null) : SqlType;
    public sealed record Integer(int Bits) : SqlType;          // 32 | 64
    public sealed record Real : SqlType;
    public sealed record Numeric(long? Precision = null, long? Scale = null) : SqlType;
    public sealed record Boolean : SqlType;
    public sealed record Timestamp(bool WithTimezone) : SqlType;
    public sealed record Date : SqlType;
    public sealed record Json : SqlType;
    public sealed record Blob : SqlType;
    public sealed record Uuid : SqlType;

    /// <summary>
    /// True if changing a column from <paramref name="from"/> to <paramref name="to"/>
    /// is provably non-lossy. Conservative on purpose — a false negative just makes the
    /// user pass <c>allow.typeChange</c>; a false positive could silently corrupt data.
    /// Returns false for identical types (the caller should emit no change-column-type then).
    /// </summary>
    public static bool IsWidening(SqlType from, SqlType to)
    {
        if (from == to) return false;          // record equality; identical → not a change
        return (from, to) switch
        {
            // text: unbounded→bounded lossy; bounded→unbounded widens; bounded→bounded widens iff new ≥ old.
            (Text { MaxLength: null }, Text) => false,
            (Text, Text { MaxLength: null }) => true,
            (Text f, Text t) => t.MaxLength >= f.MaxLength,

            (Integer f, Integer t) => t.Bits >= f.Bits,

            // numeric: widens iff p2 ≥ p1 AND s2 = s1 AND (p2 - s2) ≥ (p1 - s1).
            (Numeric f, Numeric t) => WideningNumeric(f, t),

            // cross-kind, or same-kind parameterless types that compared unequal
            // (impossible — no extra variants): lossy.
            _ => false,
        };
    }

    private static bool WideningNumeric(Numeric f, Numeric t)
    {
        var (fp, fs) = (f.Precision ?? 0, f.Scale ?? 0);
        var (tp, ts) = (t.Precision ?? 0, t.Scale ?? 0);
        return tp >= fp && ts == fs && (tp - ts) >= (fp - fs);
    }
}
