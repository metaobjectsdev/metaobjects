// validator.array (@min/@max) on an array field reaches the extract engine: a reply with too
// many elements keeps the first @max, and one with too few is MALFORMED and counted in
// MalformedRequired, so the strict gate fails. Mirrors the TypeScript, Java and Python tests.

using System.Collections.Generic;
using System.Linq;
using MetaObjects.Codegen.Runtime;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Render.Extract;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ExtractObjectArrayBoundsTests
{
    private const string Meta = """
        { "metadata.root": { "package": "app", "children": [
          { "object.value": { "name": "Suggestion", "children": [
            { "field.string": { "name": "tags", "@required": true, "isArray": true, "children": [
              { "validator.array": { "name": "threeTags", "@min": 3, "@max": 3 } } ] } } ] } } ] } }
        """;

    private static MetaObject Suggestion()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Meta, id: "array-bounds.json")]);
        Assert.Empty(r.Errors);
        return r.Root.FindObject("Suggestion")!;
    }

    [Fact]
    public void SchemaCarriesTheBounds()
    {
        FieldSpec tags = ExtractObject.ExtractSchemaFor(Suggestion()).Fields[0];
        Assert.Equal(3, tags.MinItems);
        Assert.Equal(3, tags.MaxItems);
    }

    [Fact]
    public void TooManyKeepsTheFirstMax()
    {
        MetaObject mo = Suggestion();
        ExtractionResult<object> result = ExtractObject.Extract(mo, "{\"tags\":[\"a\",\"b\",\"c\",\"d\",\"e\"]}", Format.Json);
        Assert.Equal(FieldExtraction.EXTRACTED, result.Report.States()["tags"]);
        var tags = (IReadOnlyList<object?>)mo.GetField("tags")!.GetValue(result.Data)!;
        Assert.Equal(new[] { "a", "b", "c" }, tags.Cast<string>());
    }

    [Fact]
    public void TooFewIsMalformedRequired()
    {
        ExtractionResult<object> result = ExtractObject.Extract(Suggestion(), "{\"tags\":[\"a\",\"b\"]}", Format.Json);
        Assert.Equal(FieldExtraction.MALFORMED, result.Report.States()["tags"]);
        Assert.Equal(new[] { "tags" }, result.Report.MalformedRequired());
    }
}
