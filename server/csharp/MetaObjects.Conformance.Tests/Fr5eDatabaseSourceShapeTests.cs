// FR5e — cross-port envelope shape lock for `format: "database"`.
//
// The schema is reserved by ADR-0009 and instantiable in every port today;
// a real database-source loader is future work. This test pins the shape so
// a future loader (FR5e implementation) has a guaranteed-correct target.

using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Fr5eDatabaseSourceShapeTests
{
    [Fact]
    public void FormatIsDatabase()
    {
        var src = new DatabaseSource(new DbLocation("metaobjects_field_attr", "fld_abc123/currency"));
        Assert.Equal("database", src.Format);
    }

    [Fact]
    public void DbLocationCarriesTableAndId()
    {
        var loc = new DbLocation("metaobjects_object", "obj_42");
        Assert.Equal("metaobjects_object", loc.Table);
        Assert.Equal("obj_42", loc.Id);
    }

    [Fact]
    public void JsonPathIsOptional()
    {
        var noPath = new DatabaseSource(new DbLocation("t", "id"));
        Assert.Null(noPath.JsonPath);

        var withPath = new DatabaseSource(
            new DbLocation("metaobjects_field_attr", "fld_abc123/currency"),
            "$.metadata.root.children[0].field.currency.@currency");
        Assert.NotNull(withPath.JsonPath);
        Assert.Equal("$.metadata.root.children[0].field.currency.@currency", withPath.JsonPath);
    }

    [Fact]
    public void CompositeKeyEncodedInIdString()
    {
        // FR5e design lock: composite primary keys are encoded as a single
        // delimited string in the id, e.g. "row_id/attr_name". This keeps the
        // envelope schema dialect-neutral and avoids a deeper DbLocation shape.
        var loc = new DbLocation("metaobjects_field_attr", "fld_abc123/currency");
        Assert.Equal("fld_abc123/currency", loc.Id);
    }
}
