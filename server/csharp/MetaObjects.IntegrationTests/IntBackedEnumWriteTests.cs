// An int-backed field.enum (@intValueMap) must refuse to WRITE a value the map does not describe,
// the way its read side already refuses a stored int with no member.
//
// The model->provider chain used to be `v == A ? 1 : v == B ? 2 : 3`: the last member was the
// else branch, so a cast like (Status)99 — or a member a @provided C# enum carries but @values
// does not — was silently stored as the LAST member's int, and a single-member enum compiled to
// `v => 4`. Covered on the scalar column and on an enum array's element converter. SQLite, so
// no container is needed: the converter is the provider-independent half of the mapping.

using MetaObjects.Codegen;
using MetaObjects.IntegrationTests.Runner;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace MetaObjects.IntegrationTests;

public sealed class IntBackedEnumWriteTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "field.enum": { "name": "Status", "abstract": true,
          "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
          "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
      { "object.entity": { "name": "Ticket", "children": [
        { "source.rdb": { "@table": "tickets" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "extends": "acme::Status" } },
        { "field.enum": { "name": "history", "extends": "acme::Status", "isArray": true } },
        { "field.enum": { "name": "solo", "@values": ["ONLY"], "@intValueMap": { "ONLY": 4 } } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}}
    ]}}
    """;

    private const string Ddl = """
        CREATE TABLE "tickets" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          "status" INTEGER, "history" TEXT, "solo" INTEGER);
        """;

    private static readonly Lazy<GeneratedEfModel> Gen = new(() => GeneratedEfModel.Compile(Model, "Acme.IvmWrite"));

    private static async Task<string> NewDatabase(SqliteTempDatabase file)
    {
        var cs = $"Data Source={file.FilePath}";
        await using var conn = new SqliteConnection(cs);
        await conn.OpenAsync();
        await using var ddl = conn.CreateCommand();
        ddl.CommandText = Ddl;
        await ddl.ExecuteNonQueryAsync();
        return cs;
    }

    private static object Ticket(object? status, System.Collections.IList? history, object? solo)
    {
        var t = Gen.Value.New("Ticket");
        GeneratedEfModel.Set(t, "Status", status);
        GeneratedEfModel.Set(t, "History", history);
        GeneratedEfModel.Set(t, "Solo", solo);
        return t;
    }

    private static System.Collections.IList Statuses(params object[] members)
    {
        var list = (System.Collections.IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(Gen.Value.Type("Status")))!;
        foreach (var m in members) list.Add(m);
        return list;
    }

    private static object Status(int raw) => System.Enum.ToObject(Gen.Value.Type("Status"), raw);

    private static object Solo(int raw) => System.Enum.ToObject(Gen.Value.Type("Ticket+TicketSolo"), raw);

    private static void AssertWriteRefused(string cs, object ticket, string field)
    {
        using var db = Gen.Value.NewContext(o => o.UseSqlite(cs));
        db.Add(ticket);
        var ex = Assert.ThrowsAny<Exception>(() => db.SaveChanges());
        var chain = string.Join(" | ", GeneratedEfModel.Chain(ex).Select(e => e.Message));
        Assert.Contains("intValueMap", chain);
        Assert.Contains(field, chain);
    }

    private static async Task<long> RowCount(string cs)
    {
        await using var conn = new SqliteConnection(cs);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """SELECT COUNT(*) FROM "tickets" """;
        return (long)(await cmd.ExecuteScalarAsync())!;
    }

    [Fact]
    public async Task A_value_outside_the_map_is_refused_on_write_not_stored_as_the_last_member()
    {
        using var file = new SqliteTempDatabase("mo-ivm-write-");
        var cs = await NewDatabase(file);

        // A scalar cast to a value with no member.
        AssertWriteRefused(cs, Ticket(Status(99), null, null), "status");
        // An array element with no member.
        AssertWriteRefused(cs, Ticket(null, Statuses(Gen.Value.Enum("Status", "DRAFT"), Status(99)), null), "history");
        // A single-member enum: its chain used to be the bare constant.
        AssertWriteRefused(cs, Ticket(null, null, Solo(7)), "solo");
        Assert.Equal(0, await RowCount(cs));
    }

    [Fact]
    public async Task Every_member_is_still_stored_as_its_declared_int()
    {
        using var file = new SqliteTempDatabase("mo-ivm-write-ok-");
        var cs = await NewDatabase(file);
        using (var db = Gen.Value.NewContext(o => o.UseSqlite(cs)))
        {
            db.Add(Ticket(Gen.Value.Enum("Status", "ARCHIVED"),
                Statuses(Gen.Value.Enum("Status", "PUBLISHED"), Gen.Value.Enum("Status", "DRAFT")),
                Gen.Value.Enum("Ticket+TicketSolo", "ONLY")));
            db.SaveChanges();
        }

        await using var conn = new SqliteConnection(cs);
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """SELECT "status", "history", "solo" FROM "tickets" """;
        await using var r = await cmd.ExecuteReaderAsync();
        Assert.True(await r.ReadAsync());
        Assert.Equal(9L, r.GetInt64(0));
        Assert.Equal("[5,0]", r.GetString(1));
        Assert.Equal(4L, r.GetInt64(2));
    }
}
