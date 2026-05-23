using System.Collections.Generic;
using System.Linq;
using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests.Loader;

/// <summary>
/// Cross-attribute validation for @storage on field.object. Mirrors the TS
/// storage-validation tests (validateFieldObjectStorage in validation-passes.ts):
///   - @storage requires @objectRef on the same field.
///   - @storage "flattened" requires isArray=false.
/// </summary>
public class FieldObjectStorageValidationTests
{
    private static (bool ok, IReadOnlyList<ErrorCode> codes) Load(string json)
    {
        var result = new MetaDataLoader().Load([new InMemorySource(json, id: "storage.json")]);
        return (result.Errors.Count == 0, result.Errors.Select(e => e.Code).ToList());
    }

    [Fact]
    public void Storage_without_objectRef_is_rejected()
    {
        var (ok, codes) = Load("""
        {
          "metadata.root": {
            "package": "test",
            "children": [
              {
                "object.entity": {
                  "name": "Order",
                  "children": [
                    { "source.dbTable": { "@name": "orders" } },
                    { "field.object": { "name": "addr", "@storage": "flattened" } },
                    { "field.long":   { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """);
        Assert.False(ok);
        Assert.Contains(ErrorCode.ERR_STORAGE_WITHOUT_OBJECT_REF, codes);
    }

    [Fact]
    public void Storage_flattened_with_isArray_true_is_rejected()
    {
        var (ok, codes) = Load("""
        {
          "metadata.root": {
            "package": "test",
            "children": [
              { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street" } }
              ]}},
              {
                "object.entity": {
                  "name": "Order",
                  "children": [
                    { "source.dbTable": { "@name": "orders" } },
                    { "field.object": { "name": "addrs", "isArray": true, "@objectRef": "Address", "@storage": "flattened" } },
                    { "field.long":   { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """);
        Assert.False(ok);
        Assert.Contains(ErrorCode.ERR_STORAGE_FLATTENED_ARRAY, codes);
    }

    [Fact]
    public void Storage_flattened_with_objectRef_and_isArray_false_passes()
    {
        var (ok, codes) = Load("""
        {
          "metadata.root": {
            "package": "test",
            "children": [
              { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street" } }
              ]}},
              {
                "object.entity": {
                  "name": "Order",
                  "children": [
                    { "source.dbTable": { "@name": "orders" } },
                    { "field.object": { "name": "addr", "@objectRef": "Address", "@storage": "flattened" } },
                    { "field.long":   { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """);
        Assert.True(ok, $"expected no errors, got: {string.Join(", ", codes)}");
    }

    [Fact]
    public void Storage_jsonb_with_isArray_true_passes()
    {
        var (ok, codes) = Load("""
        {
          "metadata.root": {
            "package": "test",
            "children": [
              { "object.value": { "name": "ContactInfo", "children": [
                { "field.string": { "name": "email" } }
              ]}},
              {
                "object.entity": {
                  "name": "Patient",
                  "children": [
                    { "source.dbTable": { "@name": "patients" } },
                    { "field.object": { "name": "contactInfos", "isArray": true, "@objectRef": "ContactInfo", "@storage": "jsonb" } },
                    { "field.long":   { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
                }
              }
            ]
          }
        }
        """);
        Assert.True(ok, $"expected no errors, got: {string.Join(", ", codes)}");
    }
}
