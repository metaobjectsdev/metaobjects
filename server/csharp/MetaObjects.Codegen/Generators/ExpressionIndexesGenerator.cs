// expression-indexes — the indexes the EF model cannot carry: every identity.secondary or
// index.lookup whose key is an expression (core @expr), with its @using and @where. EF Core's
// HasIndex takes properties only, so DbContextGenerator skips these nodes and this generator
// writes them as one SQL file (`expression-indexes.g.sql`) to apply after the schema EF builds.
//
// It is the database-built-from-the-model half of what `meta migrate` creates from the same
// metadata (migrate-ts emits each as a CREATE INDEX on the table, in its @schema, under the
// resolved index name), so the two databases agree. EF migrations never see these indexes: a
// changed one needs its own migration statement beside the metadata change. IF NOT EXISTS, so
// the file re-applies.

using System.Text;
using MetaObjects.Codegen.Writer;
using MetaObjects.Meta;
using static MetaObjects.Persistence.Db.DbConstants;
using static MetaObjects.Persistence.Source.SourceConstants;

namespace MetaObjects.Codegen.Generators;

public class ExpressionIndexesGenerator : IGenerator
{
    public string Name => "expression-indexes";

    /// <summary>The file the statements are written to, under the run's output directory.</summary>
    public string FileName { get; init; } = "expression-indexes.g.sql";

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var statements = CollectStatements(ctx);
        if (statements.Count == 0) yield break;

        var w = NewWriter();
        WriteFileHeader(w);
        w.Blank();
        WriteStatements(w, statements.Values);
        yield return new EmittedFile(FileName, w.ToString());
    }

    // The pieces of the file, one overridable method each (ADR-0063 item 7): a subclass changes the
    // piece it wants and keeps the rest. Not a stability contract.

    /// <summary>The writer the file is written on.</summary>
    protected virtual CsWriter NewWriter() => new();

    /// <summary>
    /// Every expression index of the model, keyed <c>schema/name</c> so the file lists them in a
    /// stable order, each as one <c>CREATE INDEX</c> statement (<see cref="BuildStatement"/>).
    /// </summary>
    protected virtual SortedDictionary<string, string> CollectStatements(GenContext ctx)
    {
        var statements = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var o in ctx.Entities.Where(o => o.IsEntity() && InstanceArtifacts.EmitsInstanceArtifacts(o)))
        {
            // ADR-0039: resolving — an index an abstract base declares is each concrete child's, on
            // its own table (the layered enterprise → core shape). A TPH subtype's lands on its
            // root's table, and only what it adds beyond the nearest ancestor in the model.
            var owner = TphPlanBuilder.IsTphSubtype(o, ctx.Root) ? TphPlanBuilder.DiscriminatorRoot(o) ?? o : o;
            var inModel = ReferenceEquals(owner, o) ? null : NearestConcreteAncestor(o);
            var inherited = inModel is null ? new HashSet<string>(StringComparer.Ordinal)
                : new HashSet<string>(IndexNodes(inModel).Select(n => n.Name), StringComparer.Ordinal);
            foreach (var node in IndexNodes(o).Where(n => !inherited.Contains(n.Name)))
            {
                bool? unique = node switch
                {
                    MetaSecondaryIdentity => true,
                    MetaIndex mi when mi.IsLookup() => false,
                    _ => null,
                };
                if (unique is null || node.Attr(IDENTITY_ATTR_EXPR) is not string { Length: > 0 } expr) continue;
                var schema = owner.Sources().FirstOrDefault(s => s.SubType == SOURCE_SUBTYPE_RDB)?.Schema;
                var name = IndexNaming.ResolveIndexName(node);
                // An index name is unique per schema, tables included (migrate's ERR_DUPLICATE_SQL_NAME):
                // two tables claiming one would leave the second unbuilt under IF NOT EXISTS.
                ctx.Claim($"the indexes of schema \"{(string.IsNullOrEmpty(schema) ? "(default)" : schema)}\"", name, owner.ResolutionKey(),
                    "an index's name is used verbatim, so give each table its own (declare it on each concrete entity)");
                statements[$"{schema}/{name}"] = BuildStatement(node, owner, schema, name, unique.Value, expr);
            }
        }
        return statements;
    }

    /// <summary>
    /// One <c>CREATE [UNIQUE] INDEX IF NOT EXISTS</c> statement for <paramref name="node"/> on
    /// <paramref name="owner"/>'s table, with its <c>@using</c> (when not btree) and <c>@where</c>.
    /// </summary>
    protected virtual string BuildStatement(MetaData node, MetaObject owner, string? schema, string name, bool unique, string expr)
    {
        var table = CSharpNaming.Table(owner);
        var relation = string.IsNullOrEmpty(schema) ? Quote(table) : Quote(schema) + "." + Quote(table);
        var sql = new StringBuilder()
            .Append(unique ? "CREATE UNIQUE INDEX IF NOT EXISTS " : "CREATE INDEX IF NOT EXISTS ")
            .Append(Quote(name)).Append(" ON ").Append(relation);
        if (node.Attr(IDENTITY_ATTR_USING) is string method && method.Trim().Length > 0 && method.Trim() != "btree")
            sql.Append(" USING ").Append(method.Trim());
        sql.Append(" (").Append(expr.Trim()).Append(')');
        if (node.Attr(IDENTITY_ATTR_WHERE) is string where && where.Trim().Length > 0)
            sql.Append(" WHERE ").Append(where.Trim());
        return sql.Append(';').ToString();
    }

    /// <summary>The two header comments. A SQL file, so the comments are <c>--</c>.</summary>
    protected virtual void WriteFileHeader(CsWriter w)
    {
        w.Line("-- <auto-generated/> MetaObjects expression-indexes. Do not edit by hand.");
        w.Line("-- The expression indexes (@expr) the EF model cannot carry; apply after the schema EF builds.");
    }

    /// <summary>
    /// The statements, in order. The writer still owns the line breaks: an expression written over
    /// several lines stays on several lines, each handed to the writer on its own.
    /// </summary>
    protected virtual void WriteStatements(CsWriter w, IEnumerable<string> statements)
    {
        foreach (var statement in statements)
        {
            using var lines = new StringReader(statement);
            while (lines.ReadLine() is { } line) w.Line(line);
        }
    }

    protected static IEnumerable<MetaData> IndexNodes(MetaObject o) =>
        o.SecondaryIdentities().Cast<MetaData>().Concat(o.LookupIndexes());

    /// <summary>The nearest ancestor that is in the EF model itself (a concrete TPH level or the root).</summary>
    protected static MetaObject? NearestConcreteAncestor(MetaObject o)
    {
        for (var s = o.SuperData as MetaObject; s is not null; s = s.SuperData as MetaObject)
            if (InstanceArtifacts.EmitsInstanceArtifacts(s)) return s;
        return null;
    }

    protected static string Quote(string name) => "\"" + name.Replace("\"", "\"\"") + "\"";
}
