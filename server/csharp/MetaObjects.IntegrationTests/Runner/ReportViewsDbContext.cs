// ReportViewsDbContext — the generated AppDbContext, narrowed to its view-mapped entities
// so it builds on SQLite and MySQL.
//
// The generated context is Postgres-flavoured for the TABLE entities (jsonb JsonDocument,
// inet IPAddress, uuid conversions, `timestamp with time zone`), and EF's SQLite and MySQL
// providers refuse to build a model that contains a property they cannot map. The FR-044 report
// scenarios read only view-mapped entities (`ToView(...)`: reports and projections), whose
// columns are plain scalars, so this subclass ignores every entity that is not a view and
// leaves the generated mapping of the views untouched. Nothing here maps or renames a
// column: the views are the TypeScript-produced ones.
//
// One mapping is added: EF's SQLite provider refuses `ORDER BY` on a DateTimeOffset
// (it stores one as text with an offset, which does not sort as an instant), and a MySQL
// DATETIME holds no zone at all. A report whose time dimension is an instant
// (`RecordedAtHour`) is ordered by the generated query, so a DateTimeOffset reads and
// writes through its UTC DateTime. Both engines hold the instant as the UTC wall clock,
// so the value is unchanged.

using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using MetaObjects.IntegrationTests.Generated;

namespace MetaObjects.IntegrationTests.Runner;

public sealed class ReportViewsDbContext : AppDbContext
{
    public ReportViewsDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);
        var tables = modelBuilder.Model.GetEntityTypes()
            .Where(e => e.GetViewName() is null)
            .Select(e => e.ClrType)
            .ToList();
        foreach (var table in tables) modelBuilder.Ignore(table);

        var instant = new ValueConverter<DateTimeOffset, DateTime>(
            v => v.UtcDateTime,
            // Microsoft.Data.Sqlite parses the `...Z` text to a LOCAL DateTime; a MySQL
            // DATETIME arrives Unspecified. An Unspecified value carries no zone and is the
            // UTC wall clock the views hold.
            v => new DateTimeOffset(v.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(v, DateTimeKind.Utc) : v.ToUniversalTime()));
        foreach (var property in modelBuilder.Model.GetEntityTypes().SelectMany(e => e.GetProperties())
                     .Where(p => p.ClrType == typeof(DateTimeOffset)))
            property.SetValueConverter(instant);
    }
}
