// `migrate.foreignKeyIndexes`: the index `meta migrate` gives each enforced foreign key that
// nothing already leads with, under migrate's name, so the generated EF model declares the index
// the database has. Ported from migrate-ts's expected-schema.ts (uncoveredForeignKeyColumns,
// foreignKeyIndexName); the shared corpus fixtures/foreign-key-index-conformance/ pins this port,
// TypeScript and Kotlin to the same answer.

using System.Text;
using MetaObjects.Meta;
using MetaObjects.Persistence.Db;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>One foreign-key index: its name, the class that declares the foreign key, its fields
/// and their columns.</summary>
public sealed record ForeignKeyIndex(string Name, MetaObject Owner, IReadOnlyList<MetaField> Fields, IReadOnlyList<string> Columns);

/// <summary>The foreign-key indexes of an entity's table, as <c>meta migrate</c> adds them.</summary>
public static class ForeignKeyIndexes
{
    /// <summary>Postgres's identifier limit in bytes; a longer name is stored cut to it.</summary>
    private const int PgIdentifierMaxBytes = 63;

    /// <summary>
    /// The rule is migrate's own: the primary key, a field's <c>@unique</c>, an
    /// <c>identity.secondary</c> and an <c>index.lookup</c> without <c>@expr</c> cover a foreign
    /// key whose columns they lead with, in any order; two foreign keys over one column set get
    /// one index; and a foreign key that leads a longer one shares the longer one's index. Empty
    /// unless <see cref="GenConfig.ForeignKeyIndexes"/> is set, under the <c>efcore</c>
    /// conventions (which already index every foreign key with EF Core's own names) and on MySQL
    /// (InnoDB indexes each foreign key itself). A TPH table is read whole: the base and every
    /// concrete subtype.
    /// </summary>
    public static IReadOnlyList<ForeignKeyIndex> For(MetaObject entity, TphPlan? tph, GenConfig config)
    {
        if (!config.ForeignKeyIndexes
            || string.Equals(config.SchemaConventions, "efcore", StringComparison.Ordinal)
            || string.Equals(config.Dialect, "mysql", StringComparison.OrdinalIgnoreCase))
            return [];
        var strategy = config.ColumnNamingStrategy;
        var members = new List<MetaObject> { entity };
        if (tph is not null) members.AddRange(tph.Subtypes.Select(st => st.Entity));

        List<string>? Columns(MetaObject owner, IEnumerable<string> fieldNames)
        {
            var cols = new List<string>();
            foreach (var name in fieldNames)
            {
                if (owner.FindField(name) is not { } f) return null;
                cols.Add(CSharpNaming.Column(f, strategy));
            }
            return cols;
        }

        var existing = new List<List<string>>();
        if (entity.PrimaryIdentity()?.Fields is { Count: > 0 } pk && Columns(entity, pk) is { } pkCols) existing.Add(pkCols);
        foreach (var m in members)
        {
            // ADR-0039: resolving — @unique and index nodes may be inherited via extends.
            foreach (var f in m.Fields().Where(f => f.Attr(FIELD_ATTR_UNIQUE) is true))
                existing.Add([CSharpNaming.Column(f, strategy)]);
            foreach (var (node, fields) in m.SecondaryIdentities().Select(i => ((MetaData)i, i.Fields))
                         .Concat(m.LookupIndexes().Select(i => ((MetaData)i, i.Fields))))
            {
                if (node.Attr(DbConstants.IDENTITY_ATTR_EXPR) is string { Length: > 0 } || fields.Count == 0) continue;
                if (Columns(m, fields) is { } cols) existing.Add(cols);
            }
        }

        // Each physical foreign key once, on the first class of the table that declares it.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var candidates = new List<(MetaObject Owner, List<MetaField> Fields, List<string> Columns)>();
        foreach (var m in members)
        {
            foreach (var reference in m.ReferenceIdentities().Where(r => r.Enforce))
            {
                var fieldNames = ReferentialActions.ReadIdentityFields(reference);
                if (!seen.Add(string.Join(",", fieldNames))) continue;
                var fields = new List<MetaField>();
                foreach (var name in fieldNames)
                {
                    if (m.FindField(name) is not { } f) { fields.Clear(); break; }
                    fields.Add(f);
                }
                if (fields.Count == 0) continue;
                var cols = fields.Select(f => CSharpNaming.Column(f, strategy)).ToList();
                if (existing.Any(e => LeadsWith(e, cols))) continue;
                if (candidates.Any(c => c.Columns.Count == cols.Count && LeadsWith(c.Columns, cols))) continue;
                candidates.Add((m, fields, cols));
            }
        }

        var table = CSharpNaming.Table(entity);
        return candidates
            .Where(c => !candidates.Any(o => o.Columns.Count > c.Columns.Count && LeadsWith(o.Columns, c.Columns)))
            .Select(c => new ForeignKeyIndex(Name(table, c.Columns, config.Dialect), c.Owner, c.Fields, c.Columns))
            .ToList();
    }

    /// <summary>
    /// <c>&lt;table&gt;_&lt;column&gt;[_&lt;column&gt;…]_idx</c>, cut by <see cref="StoredName"/>: the
    /// name <c>meta migrate</c> expects.
    /// </summary>
    public static string Name(string table, IReadOnlyList<string> columns, string? dialect) =>
        StoredName($"{table}_{string.Join("_", columns)}_idx", dialect);

    /// <summary>
    /// The name the database stores for <paramref name="name"/>, which is the name <c>meta
    /// migrate</c> creates and compares (migrate-ts <c>storedIdentifier</c>): on Postgres a name
    /// over 63 bytes is cut to its first 63 bytes on a character boundary. SQLite and D1 keep the
    /// whole name, and so does MySQL, where migrate writes no DDL and an over-long name is refused
    /// rather than cut.
    /// </summary>
    public static string StoredName(string name, string? dialect)
    {
        if (dialect is "sqlite" or "d1" or "mysql" || Encoding.UTF8.GetByteCount(name) <= PgIdentifierMaxBytes) return name;
        var sb = new StringBuilder();
        var bytes = 0;
        foreach (var rune in name.EnumerateRunes())
        {
            var n = rune.Utf8SequenceLength;
            if (bytes + n > PgIdentifierMaxBytes) break;
            sb.Append(rune.ToString());
            bytes += n;
        }
        return sb.ToString();
    }

    /// <summary>
    /// The database name of an <c>identity.secondary</c> or <c>index.lookup</c>: its declared name
    /// (<see cref="IndexNaming.ResolveIndexName"/>), cut by <see cref="StoredName"/>. The shared
    /// corpus fixtures/foreign-key-index-conformance/ (<c>declared.&lt;dialect&gt;.json</c>) pins it.
    /// </summary>
    public static string DeclaredIndexName(MetaData node, string? dialect) =>
        StoredName(IndexNaming.ResolveIndexName(node), dialect);

    /// <summary>True when <paramref name="prefix"/> leads with exactly <paramref name="columns"/>,
    /// in any order (migrate's <c>leadsWith</c>).</summary>
    internal static bool LeadsWith(IReadOnlyList<string> prefix, IReadOnlyList<string> columns)
    {
        if (columns.Count == 0 || prefix.Count < columns.Count) return false;
        var want = new HashSet<string>(columns, StringComparer.Ordinal);
        return prefix.Take(columns.Count).All(want.Contains);
    }
}
