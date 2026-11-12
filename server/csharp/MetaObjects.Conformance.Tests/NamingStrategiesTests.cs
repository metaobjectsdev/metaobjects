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

    // The enums these were before ADR-0058 Amendment 1 defaulted to their first member, Literal;
    // default(...) of the class is null, and calling Apply on it threw NullReferenceException.
    [Fact]
    public void A_default_strategy_applies_as_the_enum_default_did()
    {
        Assert.Equal("fooBar", default(ColumnNamingStrategy).Apply("fooBar"));
        Assert.Equal("OrderItem", default(TableNamingRule).Apply("OrderItem"));
    }

    // Like the TypeScript, Java and Python ports, a strategy is looked up by NAME each time it
    // resolves a name, so a registration made (or replaced) after the value was read is the one used.
    [Fact]
    public void A_strategy_resolves_by_name_each_time()
    {
        NamingStrategies.RegisterColumns("cs-test-reregister", n => "A_" + n);
        var held = NamingStrategies.Column("cs-test-reregister");
        Assert.Equal("A_id", held.Apply("id"));
        NamingStrategies.RegisterColumns("cs-test-reregister", n => "B_" + n);
        Assert.Equal("B_id", held.Apply("id"));
    }

    [Fact]
    public void ResetForTesting_forgets_the_application_strategies_and_keeps_the_built_ins()
    {
        NamingStrategies.RegisterColumns("cs-test-reset", n => n.ToUpperInvariant());
        NamingStrategies.RegisterTables("cs-test-reset-tables", n => n.ToUpperInvariant());
        var held = NamingStrategies.Column("cs-test-reset");

        NamingStrategies.ResetForTesting();

        Assert.False(NamingStrategies.TryGetColumn("cs-test-reset", out _));
        Assert.False(NamingStrategies.TryGetTable("cs-test-reset-tables", out _));
        var ex = Assert.Throws<MetaModelException>(() => held.Apply("id"));
        Assert.Contains("\"naming.columns\" names \"cs-test-reset\"", ex.Message);
        Assert.Equal(NamingStrategies.BuiltInColumns, NamingStrategies.Columns);
        Assert.Equal(NamingStrategies.BuiltInTables, NamingStrategies.Tables);
        Assert.Equal("request_url", ColumnNamingStrategy.SnakeCase.Apply("requestURL"));
    }

    // A caller that hands the config to a process which registers the strategy (dotnet meta verify
    // handing --codegen to the project's codegen runner) reads it without refusing a name it does
    // not know; resolving a name through it then fails as loudly as the read would have.
    [Fact]
    public void The_config_reader_can_leave_an_unknown_name_to_resolution()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mo-naming-deferred-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, ".metaobjects"));
        try
        {
            File.WriteAllText(Path.Combine(dir, ".metaobjects", "config.json"),
                """{ "schema_version": 1, "naming": { "columns": "cs-test-later", "tables": "cs-test-later-tables" } }""");
            Assert.Throws<MetaModelException>(() => NeutralConfig.Read(dir));

            var naming = NeutralConfig.Read(dir, validateNaming: false)!.Naming;
            Assert.Equal("cs-test-later", naming.Columns.Name);
            Assert.Equal("cs-test-later-tables", naming.Tables.Name);
            var ex = Assert.Throws<MetaModelException>(() => naming.Columns.Apply("id"));
            Assert.Contains("\"naming.columns\" names \"cs-test-later\"", ex.Message);

            NamingStrategies.RegisterColumns("cs-test-later", n => "c_" + n);
            Assert.Equal("c_id", naming.Columns.Apply("id"));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // naming.collections selects a pluralizer by name; an unknown one is refused at read.
    [Fact]
    public void The_config_reader_selects_a_pluralizer_and_refuses_an_unknown_one()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mo-naming-collections-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, ".metaobjects"));
        try
        {
            var config = Path.Combine(dir, ".metaobjects", "config.json");
            File.WriteAllText(config, """{ "schema_version": 1, "naming": { "collections": "none" } }""");
            Assert.Equal("none", NeutralConfig.Read(dir)!.Naming.Collections);

            File.WriteAllText(config, """{ "schema_version": 1 }""");
            Assert.Null(NeutralConfig.Read(dir)!.Naming.Collections);

            File.WriteAllText(config, """{ "schema_version": 1, "naming": { "collections": "klingon" } }""");
            var ex = Assert.Throws<MetaModelException>(() => NeutralConfig.Read(dir));
            Assert.Contains("\"naming.collections\" names \"klingon\"", ex.Message);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
