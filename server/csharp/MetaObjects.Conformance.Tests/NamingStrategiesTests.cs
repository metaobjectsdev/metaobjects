// ADR-0058 Amendment 1 — the naming strategies are a registry an application extends. The
// built-ins are registered strategies by name; an application registers its own (which may
// wrap a built-in in one line); `.metaobjects/config.json` selects either by name, and a name
// nothing registers is refused when the config is read.
using MetaObjects.Config;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class NamingStrategiesTests
{
    [Fact]
    public void Every_built_in_is_a_registered_strategy()
    {
        Assert.Equal(["snake_case", "literal", "kebab-case", "pascal"], NamingStrategies.BuiltInColumns.Select(s => s.Name));
        Assert.Equal(["snake_case", "literal"], NamingStrategies.BuiltInTables.Select(s => s.Name));
        Assert.Same(ColumnNamingStrategy.Pascal, NamingStrategies.Column("pascal"));
        Assert.Equal("RequestURL", ColumnNamingStrategy.Pascal.Apply("requestURL"));
        Assert.Equal("Npi", ColumnNamingStrategy.Pascal.Apply("npi"));
        Assert.Equal("ßeta", ColumnNamingStrategy.Pascal.Apply("ßeta"));
        Assert.Equal("request_url", NamingStrategies.Column("snake_case").Apply("requestURL"));
        Assert.Equal("OrderItem", NamingStrategies.Table("literal").Apply("OrderItem"));
    }

    [Fact]
    public void An_application_strategy_wraps_a_built_in()
    {
        NamingStrategies.RegisterColumns("cs-test-acronyms", n => n == "npi" ? "NPI" : ColumnNamingStrategy.Pascal.Apply(n));
        NamingStrategies.RegisterTables("cs-test-prefixed", n => "t_" + TableNamingRule.SnakeCase.Apply(n));

        Assert.Equal("NPI", NamingStrategies.Column("cs-test-acronyms").Apply("npi"));
        Assert.Equal("CreatedAt", NamingStrategies.Column("cs-test-acronyms").Apply("createdAt"));
        Assert.Equal("t_order_item", NamingStrategies.Table("cs-test-prefixed").Apply("OrderItem"));
        Assert.Contains(NamingStrategies.Columns, s => s.Name == "cs-test-acronyms");
        Assert.DoesNotContain(NamingStrategies.Tables, s => s.Name == "cs-test-acronyms");
    }

    [Fact]
    public void A_built_in_cannot_be_replaced()
    {
        Assert.Throws<ArgumentException>(() => NamingStrategies.RegisterColumns("snake_case", n => n));
        Assert.Throws<ArgumentException>(() => NamingStrategies.RegisterTables("literal", n => n));
    }

    [Fact]
    public void An_unknown_name_fails_loud_naming_the_strategy_and_the_port()
    {
        var ex = Assert.Throws<MetaModelException>(() => NamingStrategies.Column("no-such-rule"));
        Assert.Contains("\"naming.columns\" names \"no-such-rule\"", ex.Message);
        Assert.Contains("C# port", ex.Message);
        Assert.Contains("built in: snake_case, literal, kebab-case, pascal", ex.Message);
        Assert.Throws<MetaModelException>(() => NamingStrategies.Table("pascal"));
    }

    [Fact]
    public void The_config_reader_selects_an_application_strategy_by_name()
    {
        NamingStrategies.RegisterColumns("cs-test-config", n => n.ToUpperInvariant());
        var dir = Path.Combine(Path.GetTempPath(), "mo-naming-strategies-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, ".metaobjects"));
        try
        {
            File.WriteAllText(Path.Combine(dir, ".metaobjects", "config.json"),
                """{ "schema_version": 1, "naming": { "columns": "cs-test-config" } }""");
            var naming = NeutralConfig.Read(dir)!.Naming;
            Assert.Equal("cs-test-config", naming.Columns.Name);
            Assert.Equal(TableNamingRule.SnakeCase, naming.Tables);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
