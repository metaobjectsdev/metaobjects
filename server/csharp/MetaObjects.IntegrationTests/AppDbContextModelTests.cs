// AppDbContextModelTests — Docker-FREE EF Core model-build gate.
//
// EF Core finalizes (validates) its model offline — no database connection is
// opened just to build `context.Model`. So this test reproduces model-level
// misconfiguration (e.g. a TPH discriminator base with no discriminator value)
// WITHOUT Testcontainers. It is the fast guard for the class of failure that
// otherwise only surfaces in the Docker integration suite.

using MetaObjects.IntegrationTests.Generated;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace MetaObjects.IntegrationTests;

public class AppDbContextModelTests
{
    [Fact]
    public void Model_builds_without_error()
    {
        // A dummy connection string is enough — model building never connects.
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql("Host=localhost;Database=unused")
            .Options;
        using var db = new AppDbContext(options);

        // Forces EF model finalization. Before the FR-017 fix this threw
        // InvalidOperationException: "The entity type 'Auth' has a discriminator
        // property, but does not have a discriminator value configured."
        var model = db.Model;

        // The TPH hierarchy is mapped to one table with the discriminator + subtypes.
        var auth = model.FindEntityType(typeof(Auth));
        Assert.NotNull(auth);
        Assert.NotNull(model.FindEntityType(typeof(BridgeAuth)));
        Assert.NotNull(model.FindEntityType(typeof(CopayAuth)));
        Assert.NotNull(model.FindEntityType(typeof(PriorAuthAuth)));
        Assert.Equal("auths", auth!.GetTableName());
    }

    /// <summary>
    /// The int-backed <c>field.enum</c> value converter, EXECUTED in both directions off
    /// the finalized model — the emitted lambdas are the whole feature, and a string
    /// assertion over the generated source cannot tell a working converter from one that
    /// compiles and computes the wrong thing.
    /// </summary>
    [Fact]
    public void Int_backed_enum_converter_maps_both_ways_and_rejects_an_unmapped_stored_value()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql("Host=localhost;Database=unused")
            .Options;
        using var db = new AppDbContext(options);

        var prop = db.Model.FindEntityType(typeof(AllTypes))!.FindProperty(nameof(AllTypes.IntEnumVal));
        var converter = prop!.GetValueConverter();
        Assert.NotNull(converter);

        // @intValueMap declares DRAFT=0, PUBLISHED=5, ARCHIVED=9 — NOT the C# ordinals
        // (which would make PUBLISHED 1 and ARCHIVED 2), so these assertions also prove
        // the declared map is what reaches the column rather than EF's ordinal default.
        Assert.Equal(5, converter!.ConvertToProvider(AllTypes.AllTypesIntEnumVal.PUBLISHED));
        Assert.Equal(9, converter.ConvertToProvider(AllTypes.AllTypesIntEnumVal.ARCHIVED));
        Assert.Equal(AllTypes.AllTypesIntEnumVal.PUBLISHED, converter.ConvertFromProvider(5));
        Assert.Equal(AllTypes.AllTypesIntEnumVal.ARCHIVED, converter.ConvertFromProvider(9));

        // 7 maps to no member. Materializing the last member instead — which is what the
        // ternary chain did before it grew a final else — would hand the caller
        // ARCHIVED for a row that is not archived, silently.
        var ex = Assert.Throws<InvalidOperationException>(() => converter.ConvertFromProvider(7));
        Assert.Contains("7", ex.Message);
        Assert.Contains("intValueMap", ex.Message);
    }
}
