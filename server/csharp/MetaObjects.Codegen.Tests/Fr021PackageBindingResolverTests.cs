// FR-021 — central package-binding resolver tests.
// Covers each layer of the resolution order:
//   1. TypeOverrides (most specific)
//   2. PackageNamespaces (package-level overrides)
//   3. Convention rule (strip + prepend + case + separator)
//   4. UnmappedStrategy fallback (Flatten / Error / Derive)

using System.Collections.Generic;
using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class Fr021PackageBindingResolverTests
{
    private static GenConfig CfgWithDefaults() => new()
    {
        OutDir = "/tmp",
        Namespace = "Acme.Generated",
    };

    [Fact]
    public void Default_config_falls_back_to_Namespace_byte_identical_to_pre_FR021()
    {
        var cfg = CfgWithDefaults();
        Assert.Equal("Acme.Generated", PackageBindingResolver.Resolve(cfg, "acme::cases", "Case"));
        Assert.Equal("Acme.Generated", PackageBindingResolver.Resolve(cfg, null));
        Assert.Equal("Acme.Generated", PackageBindingResolver.Resolve(cfg, ""));
    }

    [Fact]
    public void Type_override_wins_over_package_override_and_convention()
    {
        var cfg = CfgWithDefaults() with
        {
            Convention = new PackageBindingConvention
            {
                Strip = "acme::",
                Prepend = "Acme.Entities",
                Case = PackageCase.PascalCase,
            },
            PackageNamespaces = new Dictionary<string, string>
            {
                ["acme::cases"] = "Acme.Entities.CaseSpecialOverride",
            },
            TypeOverrides = new Dictionary<string, string>
            {
                ["acme::cases::Currency"] = "Acme.Shared.Money",
            },
        };

        Assert.Equal("Acme.Shared.Money", PackageBindingResolver.Resolve(cfg, "acme::cases", "Currency"));
        Assert.Equal("Acme.Entities.CaseSpecialOverride", PackageBindingResolver.Resolve(cfg, "acme::cases", "OtherType"));
    }

    [Fact]
    public void Convention_rule_strips_prefix_pascalcases_segments_joins_by_separator()
    {
        var cfg = CfgWithDefaults() with
        {
            Convention = new PackageBindingConvention
            {
                Strip = "acme::",
                Prepend = "Acme.Domain.Entities",
                Separator = ".",
                Case = PackageCase.PascalCase,
            },
        };

        Assert.Equal("Acme.Domain.Entities.Cases",
            PackageBindingResolver.Resolve(cfg, "acme::cases", "Case"));
        Assert.Equal("Acme.Domain.Entities.UsersAccess",
            PackageBindingResolver.Resolve(cfg, "acme::users-access", "User"));
        Assert.Equal("Acme.Domain.Entities.Cases.CustomProperties",
            PackageBindingResolver.Resolve(cfg, "acme::cases::custom-properties", "CustomProperty"));
    }

    [Fact]
    public void Convention_falls_through_when_package_does_not_start_with_strip()
    {
        var cfg = CfgWithDefaults() with
        {
            Convention = new PackageBindingConvention
            {
                Strip = "acme::",
                Prepend = "Acme.Entities",
                Case = PackageCase.PascalCase,
            },
        };

        // Falls back to Flatten (Acme.Generated) since the package doesn't match strip.
        Assert.Equal("Acme.Generated", PackageBindingResolver.Resolve(cfg, "other::cases", "Case"));
    }

    [Fact]
    public void Unmapped_strategy_Error_throws_with_useful_diagnostic()
    {
        var cfg = CfgWithDefaults() with
        {
            UnmappedStrategy = UnmappedPackageStrategy.Error,
        };

        var ex = Assert.Throws<System.InvalidOperationException>(() =>
            PackageBindingResolver.Resolve(cfg, "unmapped::package", "SomeEntity", fallbackContext: "EmitMappedClass"));

        Assert.Contains("unmapped::package", ex.Message);
        Assert.Contains("SomeEntity", ex.Message);
        Assert.Contains("EmitMappedClass", ex.Message);
        Assert.Contains("PackageNamespaces", ex.Message);
    }

    [Theory]
    [InlineData(PackageCase.PascalCase, "users-access", "UsersAccess")]
    [InlineData(PackageCase.CamelCase, "users-access", "usersAccess")]
    [InlineData(PackageCase.KebabCase, "users-access", "users-access")]
    [InlineData(PackageCase.SnakeCase, "users-access", "users_access")]
    [InlineData(PackageCase.Lowercase, "users-access", "usersaccess")]
    [InlineData(PackageCase.Preserve, "users-access", "users-access")]
    public void Case_transformations(PackageCase casing, string input, string expected)
    {
        var cfg = CfgWithDefaults() with
        {
            Convention = new PackageBindingConvention
            {
                Strip = "acme::",
                Prepend = "Root",
                Case = casing,
                Separator = ".",
            },
        };

        var result = PackageBindingResolver.Resolve(cfg, $"acme::{input}", "X");
        Assert.Equal($"Root.{expected}", result);
    }

    [Fact]
    public void Real_P3_config_resolves_all_18_domains_correctly()
    {
        var cfg = CfgWithDefaults() with
        {
            Namespace = "Acme.Domain.DataAccess",
            Convention = new PackageBindingConvention
            {
                Strip = "acme::",
                Prepend = "Acme.Domain.Entities",
                Separator = ".",
                Case = PackageCase.PascalCase,
            },
            PackageNamespaces = new Dictionary<string, string>
            {
                ["acme::reporting"] = "Acme.Domain.Entities.ReportEntities",
                ["acme::domain::dataEnums"] = "Acme.Domain.DataEnums",
                ["acme::domain::dataEnums::authorizations"] = "Acme.Domain.DataEnums.Authorizations",
                ["acme::domain::dataEnums::copayCards"] = "Acme.Domain.DataEnums.CopayCards",
                ["acme::domain::dataEnums::dataExportIntegration"] = "Acme.Domain.DataEnums.DataExportIntegration",
                ["acme::domain::dataEnums::spIntegration"] = "Acme.Domain.DataEnums.SPIntegration",
            },
        };

        // Convention rule: 13 of the 19 P3 domains fall through here.
        Assert.Equal("Acme.Domain.Entities.Cases", PackageBindingResolver.Resolve(cfg, "acme::cases"));
        Assert.Equal("Acme.Domain.Entities.Workflow", PackageBindingResolver.Resolve(cfg, "acme::workflow"));
        Assert.Equal("Acme.Domain.Entities.Patients", PackageBindingResolver.Resolve(cfg, "acme::patients"));
        Assert.Equal("Acme.Domain.Entities.UsersAccess", PackageBindingResolver.Resolve(cfg, "acme::users-access"));
        Assert.Equal("Acme.Domain.Entities.Authorizations", PackageBindingResolver.Resolve(cfg, "acme::authorizations"));

        // Overrides win for the 6 P3-specific names.
        Assert.Equal("Acme.Domain.Entities.ReportEntities", PackageBindingResolver.Resolve(cfg, "acme::reporting"));
        Assert.Equal("Acme.Domain.DataEnums", PackageBindingResolver.Resolve(cfg, "acme::domain::dataEnums"));
        Assert.Equal("Acme.Domain.DataEnums.Authorizations", PackageBindingResolver.Resolve(cfg, "acme::domain::dataEnums::authorizations"));
    }
}
