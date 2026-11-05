// DurationIntervalEfCoreTests — the generated Npgsql duration mapping costs EF Core nothing.
//
// On Npgsql the generated AppDbContext maps every field.duration column through its DurationInterval
// type mapping: an interval is read as NpgsqlInterval, so a month or year part, or a day count past
// what a TimeSpan holds, is refused rather than read wrong (Npgsql's own TimeSpan read turns
// '-1 mons' into zero). That mapping replaces Npgsql's own interval mapping for the column, so this
// gate proves, against a live Postgres, that what EF Core does with Npgsql's own mapping still works:
//   - LINQ member access on a TimeSpan (Days, Hours, TotalSeconds, ...) translates and runs;
//   - interval arithmetic translates: a timestamp plus or minus a duration column, a duration
//     compared with a parameter, a duration plus a constant, ordering, Min / Max, EF.Functions.Sum /
//     Average, a set-based update;
//   - an interval[] column queries as a primitive collection (Contains, Count, Any);
//   - writes round-trip, and change tracking sees an edited array;
//   - a compiled model (what `dotnet ef dbcontext optimize` generates, run here programmatically)
//     keeps the mapping, and with it the refusal. (Before this gate it could not be generated at all:
//     EF Core needs a public, top-level mapping type with a public static Default.)
// Each query runs on a CONTROL context that maps the same table with Npgsql's own TimeSpan mapping
// and on a GUARDED one that maps it exactly as the generated context does, through the generated
// mapping objects. The guarded context must translate everything the control does, to the same rows.
// (Two shapes neither translates, so neither is here: DateTime.Add(TimeSpan) and an array element by
// index. And Npgsql translates Days / Hours as date_part of the interval, so '26:00:00' has 0 days
// and 26 hours in SQL where a TimeSpan has 1 and 2: Npgsql's semantics, the same on both contexts.)

using System.Reflection;
using MetaObjects.IntegrationTests.Generated;
using MetaObjects.IntegrationTests.Runner;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Scaffolding;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

// The compiled model is generated into the context's own project in real use, so it sees that
// project's internal types; the in-memory compilation here gets the same access.
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo(MetaObjects.IntegrationTests.DurationIntervalEfCoreTests.CompiledModelAssembly)]

namespace MetaObjects.IntegrationTests;

public sealed class Span
{
    public long Id { get; set; }
    public string Label { get; set; } = "";
    public TimeSpan Wait { get; set; }
    public TimeSpan? Grace { get; set; }
    public IList<TimeSpan> Steps { get; set; } = new List<TimeSpan>();
    public DateTime At { get; set; }
    public DateTimeOffset AtTz { get; set; }
}

/// <summary>Npgsql's own TimeSpan / interval mapping: what EF Core does without the generated one.</summary>
public class ControlSpanContext(DbContextOptions<ControlSpanContext> options) : DbContext(options)
{
    public DbSet<Span> Spans => Set<Span>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        SpanTable.Map(modelBuilder);
        modelBuilder.Entity<Span>().Property(x => x.Wait).HasColumnType("interval");
        modelBuilder.Entity<Span>().Property(x => x.Grace).HasColumnType("interval");
        modelBuilder.Entity<Span>().PrimitiveCollection(x => x.Steps).HasColumnType("interval[]");
    }
}

/// <summary>The same table, its durations mapped as the generated AppDbContext maps them on Npgsql.</summary>
public class GuardedSpanContext(DbContextOptions<GuardedSpanContext> options) : DbContext(options)
{
    public DbSet<Span> Spans => Set<Span>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        SpanTable.Map(modelBuilder);
        // DbContextGenerator.DurationColumnLines, verbatim but for the entity; the mapping objects
        // are the generated AppDbContext's own.
        if (Database.ProviderName == "Npgsql.EntityFrameworkCore.PostgreSQL")
        {
            modelBuilder.Entity<Span>().Property(x => x.Wait).HasColumnType("interval").Metadata.SetTypeMapping(DurationInterval.Mapping);
            modelBuilder.Entity<Span>().Property(x => x.Grace).HasColumnType("interval").Metadata.SetTypeMapping(DurationInterval.Mapping);
            modelBuilder.Entity<Span>().PrimitiveCollection(x => x.Steps).Metadata.SetTypeMapping(DurationInterval.ArrayMapping);
        }
    }
}

internal static class SpanTable
{
    public const string Ddl = """
        CREATE TABLE "spans" ("id" BIGSERIAL PRIMARY KEY, "label" TEXT NOT NULL, "wait" INTERVAL NOT NULL, "grace" INTERVAL,
          "steps" INTERVAL[] NOT NULL, "at" TIMESTAMP NOT NULL, "at_tz" TIMESTAMPTZ NOT NULL);
        """;

    public const string Rows = """
        INSERT INTO "spans" ("label","wait","grace","steps","at","at_tz") VALUES
          ('a', '26:00:00', '-00:01:30', '{01:30:00,00:00:00.5}', '2026-01-01 00:00:00', '2026-01-01 00:00:00+00'),
          ('b', '00:30:00', NULL, '{}', '2026-01-02 12:00:00', '2026-01-02 12:00:00+00'),
          ('c', '2 days 03:04:05.678901', '00:00:01', '{1 day}', '2026-01-03 06:00:00', '2026-01-03 06:00:00+00');
        """;

    public static void Map(ModelBuilder modelBuilder)
    {
        var e = modelBuilder.Entity<Span>();
        e.ToTable("spans");
        e.Property(x => x.Id).HasColumnName("id");
        e.Property(x => x.Label).HasColumnName("label");
        e.Property(x => x.Wait).HasColumnName("wait");
        e.Property(x => x.Grace).HasColumnName("grace");
        e.PrimitiveCollection(x => x.Steps).HasColumnName("steps");
        e.Property(x => x.At).HasColumnName("at").HasColumnType("timestamp without time zone");
        e.Property(x => x.AtTz).HasColumnName("at_tz").HasColumnType("timestamp with time zone");
    }
}

public sealed class DurationIntervalEfCoreTests
{
    public const string CompiledModelAssembly = "MetaObjects.IntegrationTests.CompiledDurationModel";

    private static readonly TimeSpan Hour = TimeSpan.FromHours(1);

    // Read client-side, so a projected duration has gone through the column's mapping first.
    private static string Label(TimeSpan t) => DurationWire.Format(t);
    private static string Labels(IList<TimeSpan> steps) => string.Join("|", steps.Select(Label));

    private static readonly (string Name, Func<IQueryable<Span>, IQueryable<string>> Query)[] Queries =
    [
        // (a) member access
        ("Days", q => q.Where(x => x.Wait.Days >= 1).OrderBy(x => x.Id).Select(x => x.Label)),
        ("Hours", q => q.Where(x => x.Wait.Hours == 2 || x.Wait.Hours == 3).OrderBy(x => x.Id).Select(x => x.Label)),
        ("Minutes", q => q.Where(x => x.Wait.Minutes == 30).OrderBy(x => x.Id).Select(x => x.Label)),
        ("Seconds", q => q.Where(x => x.Wait.Seconds == 5).OrderBy(x => x.Id).Select(x => x.Label)),
        ("Milliseconds", q => q.Where(x => x.Wait.Milliseconds == 678).OrderBy(x => x.Id).Select(x => x.Label)),
        ("TotalDays", q => q.Where(x => x.Wait.TotalDays > 1).OrderBy(x => x.Id).Select(x => x.Label)),
        ("TotalHours", q => q.Where(x => x.Wait.TotalHours > 25).OrderBy(x => x.Id).Select(x => x.Label)),
        ("TotalMinutes", q => q.Where(x => x.Wait.TotalMinutes < 60).OrderBy(x => x.Id).Select(x => x.Label)),
        ("TotalSeconds", q => q.Where(x => x.Wait.TotalSeconds > 93_600).OrderBy(x => x.Id).Select(x => x.Label)),
        ("TotalMilliseconds", q => q.Where(x => x.Wait.TotalMilliseconds == 1_800_000).OrderBy(x => x.Id).Select(x => x.Label)),
        ("a nullable duration's member", q => q.Where(x => x.Grace!.Value.TotalSeconds < 0).Select(x => x.Label)),
        // (b) arithmetic, comparison, ordering, aggregates
        ("compared with a parameter", q => q.Where(x => x.Wait > Hour).OrderBy(x => x.Id).Select(x => x.Label)),
        ("equal to a parameter", q => q.Where(x => x.Wait == TimeSpan.FromMinutes(30)).Select(x => x.Label)),
        ("plus a constant", q => q.Where(x => x.Wait + TimeSpan.FromMinutes(31) > Hour).OrderBy(x => x.Id).Select(x => x.Label)),
        ("minus another duration column", q => q.Where(x => x.Wait - x.Grace!.Value > TimeSpan.FromHours(26)).OrderBy(x => x.Id).Select(x => x.Label)),
        ("a timestamp plus it", q => q.Where(x => x.At + x.Wait > new DateTime(2026, 1, 2, 3, 0, 0)).OrderBy(x => x.Id).Select(x => x.Label)),
        ("a timestamptz plus it", q => q.Where(x => x.AtTz + x.Wait > new DateTimeOffset(2026, 1, 5, 0, 0, 0, TimeSpan.Zero)).Select(x => x.Label)),
        ("a timestamp minus it", q => q.Where(x => x.At - x.Wait < new DateTime(2026, 1, 1)).OrderBy(x => x.Id).Select(x => x.Label)),
        ("order by", q => q.OrderBy(x => x.Wait).Select(x => x.Label)),
        ("order by a nullable one, descending", q => q.Where(x => x.Grace != null).OrderByDescending(x => x.Grace).Select(x => x.Label)),
        ("project it", q => q.OrderBy(x => x.Id).Select(x => Label(x.Wait))),
        ("project a computed one", q => q.OrderBy(x => x.Id).Select(x => Label(x.Wait + Hour))),
        ("Max", q => q.GroupBy(x => 1).Select(g => Label(g.Max(x => x.Wait)))),
        ("Min", q => q.GroupBy(x => 1).Select(g => Label(g.Min(x => x.Wait)))),
        ("EF.Functions.Sum", q => q.GroupBy(x => 1).Select(g => Label(EF.Functions.Sum(g.Select(x => x.Wait))!.Value))),
        ("EF.Functions.Average", q => q.GroupBy(x => 1).Select(g => Label(EF.Functions.Average(g.Select(x => x.Wait))!.Value))),
        // (c) an interval[] as a primitive collection
        ("an array Contains", q => q.Where(x => x.Steps.Contains(TimeSpan.FromHours(24))).Select(x => x.Label)),
        ("an array Count", q => q.Where(x => x.Steps.Count > 1).Select(x => x.Label)),
        ("an array Any", q => q.Where(x => x.Steps.Any(s => s < TimeSpan.FromSeconds(1))).Select(x => x.Label)),
        ("project an array", q => q.OrderBy(x => x.Id).Select(x => Labels(x.Steps))),
    ];

    private static string Run(DbContext db, Func<IQueryable<Span>, IQueryable<string>> query) =>
        string.Join(",", query(db.Set<Span>()).ToList());

    private static async Task<PostgresContainer> Database(params string[] scripts)
    {
        var pg = await PostgresContainer.StartAsync();
        foreach (var sql in scripts) await ScenarioEngine.Postgres.ExecuteScriptAsync(pg.ConnectionString, sql);
        return pg;
    }

    private static DbContextOptions<T> Options<T>(string conn, IModel? model = null) where T : DbContext
    {
        var b = new DbContextOptionsBuilder<T>().UseNpgsql(conn);
        if (model is not null) b.UseModel(model);
        return b.Options;
    }

    private static bool QueriesTheArray(string name) => name.StartsWith("an array", StringComparison.Ordinal);

    // Every query runs on `guarded` to the rows it gives on the control context.
    private static void AssertSameAsControl(string conn, GuardedSpanContext guarded, bool arrayQueries = true)
    {
        using var control = new ControlSpanContext(Options<ControlSpanContext>(conn));
        var differences = new List<string>();
        foreach (var (name, query) in Queries.Where(q => arrayQueries || !QueriesTheArray(q.Name)))
        {
            var expected = Run(control, query);
            string actual;
            try { actual = Run(guarded, query); }
            catch (Exception ex) { actual = ex.GetType().Name + ": " + ex.Message; }
            if (actual != expected) differences.Add($"{name}: Npgsql's own mapping gives [{expected}], the generated one [{actual}]");
        }
        Assert.True(differences.Count == 0, string.Join("\n", differences));
    }

    [Fact]
    public async Task Every_query_translates_and_runs_as_it_does_with_npgsqls_own_mapping()
    {
        await using var pg = await Database(SpanTable.Ddl, SpanTable.Rows);
        await using var guarded = new GuardedSpanContext(Options<GuardedSpanContext>(pg.ConnectionString));
        // The guarded context really is on the generated mapping, not Npgsql's.
        Assert.Same(typeof(DurationIntervalMapping),
            guarded.Model.FindEntityType(typeof(Span))!.FindProperty(nameof(Span.Wait))!.GetTypeMapping().GetType());
        AssertSameAsControl(pg.ConnectionString, guarded);

        // Spot checks, so the comparison cannot pass on two wrong answers.
        Assert.Equal("a,c", Run(guarded, Queries.Single(q => q.Name == "compared with a parameter").Query));
        Assert.Equal("PT77H34M5.678901S", Run(guarded, Queries.Single(q => q.Name == "EF.Functions.Sum").Query));
        Assert.Equal("c", Run(guarded, Queries.Single(q => q.Name == "an array Contains").Query));

        // A set-based update computes with the column.
        await guarded.Spans.Where(x => x.Label == "b").ExecuteUpdateAsync(s => s.SetProperty(x => x.Wait, x => x.Wait + Hour));
        Assert.Equal(TimeSpan.FromMinutes(90), await guarded.Spans.Where(x => x.Label == "b").Select(x => x.Wait).SingleAsync());
    }

    [Fact]
    public async Task Writes_round_trip_and_an_edited_array_is_tracked()
    {
        await using var pg = await Database(SpanTable.Ddl);
        var at = new DateTime(2026, 3, 1, 8, 0, 0);
        await using (var db = new GuardedSpanContext(Options<GuardedSpanContext>(pg.ConnectionString)))
        {
            db.Spans.Add(new Span
            {
                Label = "w", Wait = TimeSpan.FromTicks(123_456_789), Grace = TimeSpan.FromSeconds(-90),
                Steps = [Hour, TimeSpan.FromMilliseconds(-1500)], At = at, AtTz = new DateTimeOffset(at, TimeSpan.Zero),
            });
            await db.SaveChangesAsync();
        }
        await using (var db = new GuardedSpanContext(Options<GuardedSpanContext>(pg.ConnectionString)))
        {
            var row = await db.Spans.SingleAsync();
            Assert.Equal(TimeSpan.FromTicks(123_456_780), row.Wait); // an interval holds microseconds
            Assert.Equal(TimeSpan.FromSeconds(-90), row.Grace);
            Assert.Equal([Hour, TimeSpan.FromMilliseconds(-1500)], row.Steps);
            row.Steps.Add(TimeSpan.FromDays(2)); // an in-place edit: the list comparer must see it
            row.Grace = null;
            await db.SaveChangesAsync();
        }
        await using (var db = new GuardedSpanContext(Options<GuardedSpanContext>(pg.ConnectionString)))
        {
            var row = await db.Spans.SingleAsync();
            Assert.Equal([Hour, TimeSpan.FromMilliseconds(-1500), TimeSpan.FromDays(2)], row.Steps);
            Assert.Null(row.Grace);
        }
    }

    private const string Calendar = """
        INSERT INTO "spans" ("label","wait","grace","steps","at","at_tz") VALUES
          ('month', '-1 mons', NULL, '{}', '2026-01-01', '2026-01-01+00'),
          ('array', '00:00:00', NULL, '{01:00:00,1 mon}', '2026-01-01', '2026-01-01+00');
        """;

    // Why the mapping exists: Npgsql's own read turns '-1 mons' into zero; the generated one refuses it.
    private static async Task AssertCalendarRefused(GuardedSpanContext guarded, string conn)
    {
        await using (var control = new ControlSpanContext(Options<ControlSpanContext>(conn)))
            Assert.Equal(TimeSpan.Zero, await control.Spans.Where(x => x.Label == "month").Select(x => x.Wait).SingleAsync());
        var scalar = await Assert.ThrowsAsync<InvalidCastException>(() => guarded.Spans.Where(x => x.Label == "month").Select(x => x.Wait).SingleAsync());
        Assert.Contains("month or year part", scalar.Message);
        var array = await Assert.ThrowsAsync<InvalidCastException>(() => guarded.Spans.Where(x => x.Label == "array").SingleAsync());
        Assert.Contains("month or year part", array.Message);
    }

    [Fact]
    public async Task A_month_part_is_still_refused_through_linq()
    {
        await using var pg = await Database(SpanTable.Ddl, Calendar);
        await using var guarded = new GuardedSpanContext(Options<GuardedSpanContext>(pg.ConnectionString));
        await AssertCalendarRefused(guarded, pg.ConnectionString);
    }

    // `dotnet ef dbcontext optimize`, programmatically: the design-time services generate the
    // compiled model's C#, Roslyn compiles it, and the context runs on it through UseModel.
    private static IModel CompiledModel()
    {
        using var ctx = new GuardedSpanContext(Options<GuardedSpanContext>("Host=localhost;Database=unused"));
        var services = new ServiceCollection();
        services.AddEntityFrameworkDesignTimeServices();
        var provider = typeof(NpgsqlDbContextOptionsBuilderExtensions).Assembly; // found the way `dotnet ef` finds it
        var designTime = provider.GetCustomAttribute<DesignTimeProviderServicesAttribute>()!.TypeName;
        ((IDesignTimeServices)Activator.CreateInstance(provider.GetType(designTime, throwOnError: true)!)!).ConfigureDesignTimeServices(services);
        services.AddDbContextDesignTimeServices(ctx);
        using var sp = services.BuildServiceProvider();
        var options = new CompiledModelCodeGenerationOptions
        {
            ContextType = typeof(GuardedSpanContext), ModelNamespace = "CompiledDuration", Language = "C#", UseNullableReferenceTypes = true,
        };
        var files = sp.GetRequiredService<ICompiledModelCodeGeneratorSelector>().Select(options)
            .GenerateModel(ctx.GetService<IDesignTimeModel>().Model, options);

        var references = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator))
            if (path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) references[Path.GetFileName(path)] = path;
        references[Path.GetFileName(typeof(Span).Assembly.Location)] = typeof(Span).Assembly.Location;
        var compilation = CSharpCompilation.Create(CompiledModelAssembly,
            files.Select(f => CSharpSyntaxTree.ParseText(f.Code, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path)),
            references.Values.Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        using var ms = new MemoryStream();
        var emit = compilation.Emit(ms);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        var modelType = Assembly.Load(ms.ToArray()).GetType("CompiledDuration.GuardedSpanContextModel", throwOnError: true)!;
        return (IModel)modelType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;
    }

    [Fact]
    public async Task A_compiled_model_keeps_the_mapping_and_the_refusal()
    {
        var model = CompiledModel();
        await using var pg = await Database(SpanTable.Ddl, SpanTable.Rows, Calendar);
        await using var guarded = new GuardedSpanContext(Options<GuardedSpanContext>(pg.ConnectionString, model));
        var entity = guarded.Model.FindEntityType(typeof(Span))!;
        Assert.Same(typeof(DurationIntervalMapping), entity.FindProperty(nameof(Span.Wait))!.GetTypeMapping().GetType());
        Assert.Same(typeof(DurationIntervalArrayMapping), entity.FindProperty(nameof(Span.Steps))!.GetTypeMapping().GetType());

        await AssertCalendarRefused(guarded, pg.ConnectionString);
        await ScenarioEngine.Postgres.ExecuteScriptAsync(pg.ConnectionString, """DELETE FROM "spans" WHERE "label" IN ('month', 'array')""");
        AssertSameAsControl(pg.ConnectionString, guarded, arrayQueries: false);

        // EF Core 8's compiled model carries no element type for a primitive collection, so an
        // interval[] there reads and writes (above) but is not queryable as a collection: EF's
        // limit, not this mapping's (Npgsql's own interval[] mapping cannot be compiled at all:
        // the 8.0 generator fails on its comparer). If this starts translating, drop the exclusion.
        foreach (var (name, query) in Queries.Where(q => QueriesTheArray(q.Name)))
        {
            var ex = Assert.Throws<InvalidOperationException>(() => Run(guarded, query));
            Assert.Contains("could not be translated", ex.Message);
        }
    }
}
