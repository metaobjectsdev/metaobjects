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
}
