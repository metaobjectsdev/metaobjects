// #246 — a field.enum that both extends a shared root-level abstract enum AND
// declares its own @values must fail to load with ERR_ENUM_EXTENDS_VALUES_CONFLICT:
// one shared enum type has one member set, so the own @values would be silently
// dropped by codegen's shared-enum collapse.
//
// Mirrors the TS reference test
// (typescript/packages/metadata/test/enum-extends-values-conflict.test.ts) and the
// Java/Python ports (server/java/metadata/.../EnumExtendsValuesConflictTest.java,
// server/python/tests/loader/test_enum_extends_values_conflict.py).
//
// Three cases (the third pins the "root-level" clause of the predicate — dropping
// the `p.Type == BaseTypes.TYPE_METADATA` check would let a non-root abstract super
// go unrejected):
//   1. CONFLICT — extends a root-level (metadata.root child) abstract enum, and also
//      declares its own @values.
//   2. LEGAL — extends a CONCRETE (non-abstract) enum, and also declares its own @values.
//   3. LEGAL — extends an ABSTRACT but NON-ROOT enum (declared as a child of an
//      object.entity, not the shared package level), and also declares its own @values.

using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class EnumExtendsValuesConflictTests
{
    private static LoadResult LoadInline(string json) =>
        MetaDataLoader.FromString(json, MetaDataFormat.Json);

    [Fact]
    public void Conflict_extends_root_level_abstract_enum_with_own_values()
    {
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "Status", "abstract": true, "@values": ["A", "B"] } },
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "extends": "acme::Status", "@values": ["A", "B", "C"] } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);

        var err = Assert.Single(result.Errors, e => e.Code == ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT);
        Assert.Contains("status", err.Message);
    }

    [Fact]
    public void Legal_extends_concrete_enum_with_own_values()
    {
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "Status", "@values": ["A", "B"] } },
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "extends": "acme::Status", "@values": ["A", "B", "C"] } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);

        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT);
    }

    [Fact]
    public void Legal_extends_non_root_abstract_enum_with_own_values()
    {
        // Pins the `p.Type == BaseTypes.TYPE_METADATA` clause of the predicate —
        // dropping it would incorrectly reject this nested-abstract-super case.
        var doc = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Container", "abstract": true, "children": [
            { "field.enum": { "name": "kind", "abstract": true, "@values": ["X", "Y"] } }
          ] } },
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "extends": "acme::Container.kind", "@values": ["X", "Y", "Z"] } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ] } }
        ] } }
        """;
        var result = LoadInline(doc);

        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT);
    }
}
