// EXAMPLE GENERATORS — copy into codegen/generators/ of your owned codegen project and own
// them. Worked examples, NOT a supported MetaObjects product surface: no release promises
// their output.
//
// Wiring (see docs/recipes/write-your-own-generator.md): codegen/ is a console project
// (codegen/Codegen.csproj referencing MetaObjects.Codegen, plus codegen/Program.cs). Add
//     new JsonSchemaGenerator(),
//     new OpenApiGenerator("Shop", "/api"),
// to the list in Program.cs. `dotnet meta gen` and `dotnet meta verify --codegen` hand off
// to that project whenever codegen/Codegen.csproj exists, so both run and drift-gate these.
//
// Emits schemas/<Name>.schema.json (JSON Schema 2020-12) per concrete object, and one
// openapi.json (OpenAPI 3.1) with the cross-port CRUD paths for each object with a source.
using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.Codegen;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;

namespace Codegen.Generators;

public static class JsonSchemaShapes
{
    static readonly JsonSerializerOptions Pretty = new(JsonSerializerOptions.Default) { WriteIndented = true };

    public static string Dump(JsonNode node) => node.ToJsonString(Pretty) + "\n";

    /// <summary>Effective required-ness: <c>@required: true</c> or a <c>validator.required</c>
    /// child. <c>Attr()</c> and <c>Validators()</c> both RESOLVE through <c>extends</c>.</summary>
    public static bool IsRequired(MetaField f) =>
        f.Attr(FIELD_ATTR_REQUIRED) is true || f.Validators().Any(v => v.IsRequired());

    public static JsonObject FieldSchema(MetaField f, MetaRoot root, Func<MetaObject, string> refFor)
    {
        JsonObject value = f.SubType switch
        {
            FIELD_SUBTYPE_INT or FIELD_SUBTYPE_LONG or FIELD_SUBTYPE_CURRENCY => new() { ["type"] = "integer" },
            FIELD_SUBTYPE_DOUBLE or FIELD_SUBTYPE_FLOAT => new() { ["type"] = "number" },
            FIELD_SUBTYPE_DECIMAL => new() { ["type"] = "string", ["pattern"] = "^-?\\d+(\\.\\d+)?$" },
            FIELD_SUBTYPE_BOOLEAN => new() { ["type"] = "boolean" },
            FIELD_SUBTYPE_DATE => new() { ["type"] = "string", ["format"] = "date" },
            FIELD_SUBTYPE_TIME => new() { ["type"] = "string", ["format"] = "time" },
            FIELD_SUBTYPE_TIMESTAMP => new() { ["type"] = "string", ["format"] = "date-time" },
            FIELD_SUBTYPE_UUID => new() { ["type"] = "string", ["format"] = "uuid" },
            FIELD_SUBTYPE_ENUM => new()
            {
                ["type"] = "string",
                ["enum"] = new JsonArray((f.EffectiveEnumValues ?? []).Select(v => (JsonNode)v!).ToArray()),
            },
            // Package-aware @objectRef resolution (ADR-0042) — never a short-name match.
            FIELD_SUBTYPE_OBJECT => ValueObjectNames.ResolveFieldRef(f, root) is { } target
                ? new() { ["$ref"] = refFor(target) }
                : new() { ["type"] = "object" },
            _ => new() { ["type"] = "string" },
        };
        if (f.MaxLength is { } max) value["maxLength"] = max;
        // ResolvedIsArray(), never IsArray: that is the own flag and misses an inherited isArray.
        return f.ResolvedIsArray() ? new JsonObject { ["type"] = "array", ["items"] = value } : value;
    }

    public static JsonObject ObjectSchema(MetaObject obj, MetaRoot root, Func<MetaObject, string> refFor)
    {
        var props = new JsonObject();
        var required = new JsonArray();
        // Fields() RESOLVES: an entity that `extends` a base gets the base's fields too.
        foreach (var f in obj.Fields())
        {
            props[f.Name] = FieldSchema(f, root, refFor);
            if (IsRequired(f)) required.Add(f.Name);
        }
        var schema = new JsonObject { ["title"] = obj.Name, ["type"] = "object", ["properties"] = props };
        if (required.Count > 0) schema["required"] = required;
        return schema;
    }
}

/// <summary>One JSON Schema (2020-12) per concrete object.</summary>
public sealed class JsonSchemaGenerator : IGenerator
{
    public string Name => "json-schema";

    public IEnumerable<EmittedFile> Generate(GenContext ctx) =>
        // ctx.Entities is EVERY object, abstract bases included.
        ctx.Entities.Where(o => !o.IsAbstract).Select(o =>
        {
            var schema = new JsonObject { ["$schema"] = "https://json-schema.org/draft/2020-12/schema" };
            foreach (var (k, v) in JsonSchemaShapes.ObjectSchema(o, ctx.Root, t => $"./{t.Name}.schema.json").ToList())
                schema[k] = v?.DeepClone();
            return new EmittedFile($"schemas/{o.Name}.schema.json", JsonSchemaShapes.Dump(schema));
        });
}

/// <summary>One OpenAPI 3.1 document for the whole model.</summary>
public sealed class OpenApiGenerator(string title, string apiPrefix) : IGenerator
{
    public string Name => "openapi";

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        string Ref(MetaObject t) => $"#/components/schemas/{t.Name}";
        JsonObject Row(MetaObject o) =>
            new() { ["content"] = new JsonObject { ["application/json"] = new JsonObject { ["schema"] = new JsonObject { ["$ref"] = Ref(o) } } } };
        JsonObject Op(string id, JsonObject? body, string status, string description, JsonObject? response)
        {
            var resp = response ?? new JsonObject();
            resp["description"] = description;
            var op = new JsonObject { ["operationId"] = id, ["responses"] = new JsonObject { [status] = resp } };
            if (body is not null) op["requestBody"] = body;
            return op;
        }

        var schemas = new JsonObject();
        var paths = new JsonObject();
        foreach (var o in ctx.Entities.Where(o => !o.IsAbstract))
        {
            schemas[o.Name] = JsonSchemaShapes.ObjectSchema(o, ctx.Root, Ref);
            if (!o.Children().OfType<MetaSource>().Any()) continue;   // a value object has no routes
            // RoutePath is the cross-port collection segment the reference routes serve.
            var basePath = $"{apiPrefix}/{CSharpNaming.RoutePath(o)}";
            paths[basePath] = new JsonObject
            {
                ["get"] = Op($"list{o.Name}", null, "200", "OK", null),
                ["post"] = Op($"create{o.Name}", Row(o), "201", "Created", Row(o)),
            };
            paths[$"{basePath}/{{id}}"] = new JsonObject
            {
                ["get"] = Op($"get{o.Name}", null, "200", "OK", Row(o)),
                ["patch"] = Op($"update{o.Name}", Row(o), "200", "OK", Row(o)),
                ["delete"] = Op($"delete{o.Name}", null, "204", "Deleted", null),
            };
        }
        var doc = new JsonObject
        {
            ["openapi"] = "3.1.0",
            ["info"] = new JsonObject { ["title"] = title, ["version"] = "0.0.0" },
            ["paths"] = paths,
            ["components"] = new JsonObject { ["schemas"] = schemas },
        };
        yield return new EmittedFile("openapi.json", JsonSchemaShapes.Dump(doc));
    }
}
