// ADR-0023 Decision 2 — the sealed registry (C# edition).
//
// C# already composes its registry from an explicit immutable provider set
// (Provider.ComposeRegistry(...)), so there is no polluted global singleton to
// pivot off — sealing here is the guard + negative test that codegen cannot
// register a made-up metamodel attribute/type post-bootstrap. After Seal(),
// every mutating registration throws ERR_REGISTRY_SEALED.

using System;
using MetaObjects;
using MetaObjects.Core.Documentation;
using MetaObjects.Core.Field;
using MetaObjects.Shared;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class SealedRegistryTests
{
    private static TypeRegistry Sealed()
    {
        TypeRegistry registry = Provider.ComposeRegistry(new[]
        {
            CoreTypes.CoreTypesProvider,
            DocumentationTypes.DocTypesProvider,
        });
        registry.Seal();
        return registry;
    }

    private static void AssertSealed(Action mutation)
    {
        MetaModelException ex = Assert.Throws<MetaModelException>(mutation);
        Assert.Equal(ErrorCode.ERR_REGISTRY_SEALED, ex.Code);
    }

    [Fact]
    public void Seal_IsIdempotentAndQueryable()
    {
        TypeRegistry registry = Provider.ComposeRegistry(new[]
        {
            CoreTypes.CoreTypesProvider,
            DocumentationTypes.DocTypesProvider,
        });
        Assert.False(registry.IsSealed);
        registry.Seal();
        Assert.True(registry.IsSealed);
        registry.Seal(); // idempotent
        Assert.True(registry.IsSealed);
    }

    [Fact]
    public void Register_AfterSeal_Throws()
    {
        TypeRegistry registry = Sealed();
        var def = new TypeDefinition(
            new TypeId("widget", "madeUp"),
            "a subtype no provider agreed on",
            new System.Collections.Generic.List<ChildRule>(),
            (_, _) => throw new InvalidOperationException("factory must never run"),
            new System.Collections.Generic.List<AttrSchema>());
        AssertSealed(() => registry.Register(def));
    }

    [Fact]
    public void Extend_AfterSeal_Throws()
    {
        // The codegen self-registration case: a generator extending a core type
        // with a made-up attribute (ai*/json*) against a sealed registry.
        TypeRegistry registry = Sealed();
        AssertSealed(() => registry.Extend(
            BaseTypes.TYPE_FIELD, FieldConstants.FIELD_SUBTYPE_STRING,
            new[] { new AttrSchema("aiMadeUpAttr", "string", false) }));
    }

    [Fact]
    public void RegisterCommonAttrs_AfterSeal_Throws()
    {
        TypeRegistry registry = Sealed();
        AssertSealed(() => registry.RegisterCommonAttrs(
            new[] { new AttrSchema("madeUpCommonAttr", "string", false) }));
    }

    [Fact]
    public void SetDefaultSubType_AfterSeal_Throws()
    {
        TypeRegistry registry = Sealed();
        AssertSealed(() => registry.SetDefaultSubType(BaseTypes.TYPE_FIELD, "madeUpDefault"));
    }

    [Fact]
    public void Reads_AfterSeal_StillWork()
    {
        TypeRegistry registry = Sealed();
        Assert.True(registry.Has(BaseTypes.TYPE_FIELD, FieldConstants.FIELD_SUBTYPE_STRING));
        Assert.True(registry.AllTypes().Count > 0);
    }
}
