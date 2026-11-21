// The raw document model the authoring lints read: a metadata file as written, before the
// parser merges it. The field lint's duplicate half and the overlay lint both need it, because
// the merged model has already lost what they look for (a second declaration of a field, the file
// a declaration came from).
//
// A mapping is an ORDERED list of pairs, a sequence a List<object?>, a string scalar a string,
// and a boolean a RawBool, which keeps the text YAML wrote. Everything else reads as null.

using System.Text.Json;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;
using static MetaObjects.Shared.Structural;

namespace MetaObjects.Cli;

/// <summary>A boolean scalar, with the text it was written as (a YAML name may be a plain <c>true</c>).</summary>
internal sealed record RawBool(bool Value, string Text);

internal static class RawDocument
{
    private const string KeyName = "name";
    private const char TypeSubTypeSeparator = '.';
    /// <summary>The YAML authoring sugar for <c>isArray: true</c> — a suffix on the wrapper key.</summary>
    private const string ArraySuffix = "[]";

    internal static object? Get(List<KeyValuePair<string, object?>> mapping, string key)
    {
        foreach (var (k, v) in mapping)
            if (k == key) return v;
        return null;
    }

    /// <summary>The TYPE segment of a wrapper key: <c>field.string[]</c> and bare <c>field</c> are both <c>field</c>.</summary>
    internal static string WrapperType(string key)
    {
        var dot = key.IndexOf(TypeSubTypeSeparator);
        var head = dot < 0 ? key : key[..dot];
        return head.EndsWith(ArraySuffix, StringComparison.Ordinal) ? head[..^ArraySuffix.Length] : head;
    }

    /// <summary>A node's declared name: the body's <c>name</c>, or the body itself when YAML wrote a scalar.</summary>
    internal static string? DeclaredName(object? body)
    {
        var name = body is List<KeyValuePair<string, object?>> mapping ? Get(mapping, KeyName) : body;
        return name switch
        {
            string s when s != "" => s,
            RawBool b => b.Text,
            _ => null,
        };
    }

    /// <summary>Whether <paramref name="value"/> is the boolean <c>true</c>.</summary>
    internal static bool IsTrue(object? value) => value is RawBool { Value: true };

    /// <summary>
    /// The package the parser gives a root-level node: its own <c>package</c> (a <c>::</c>-prefixed one
    /// is relative to the root's), else the root's.
    /// </summary>
    internal static string ResolvePackage(string rootPkg, string? ownPkg) =>
        string.IsNullOrEmpty(ownPkg)
            ? rootPkg
            : rootPkg.Trim() != "" && ownPkg.StartsWith(PACKAGE_SEPARATOR, StringComparison.Ordinal)
                ? rootPkg + ownPkg
                : ownPkg;

    internal static object? ParseJson(string text)
    {
        using var doc = JsonDocument.Parse(text);
        return FromJson(doc.RootElement);
    }

    private static object? FromJson(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Object => element.EnumerateObject()
            .Select(p => new KeyValuePair<string, object?>(p.Name, FromJson(p.Value))).ToList(),
        JsonValueKind.Array => element.EnumerateArray().Select(FromJson).ToList(),
        JsonValueKind.String => element.GetString(),
        JsonValueKind.True => new RawBool(true, "true"),
        JsonValueKind.False => new RawBool(false, "false"),
        _ => null,
    };

    internal static object? ParseYaml(string text)
    {
        var stream = new YamlStream();
        stream.Load(new StringReader(text));
        return stream.Documents.Count == 0 ? null : FromYaml(stream.Documents[0].RootNode);
    }

    private static object? FromYaml(YamlNode node) => node switch
    {
        YamlMappingNode mapping => mapping.Children
            .Where(p => p.Key is YamlScalarNode)
            .Select(p => new KeyValuePair<string, object?>(((YamlScalarNode)p.Key).Value ?? "", FromYaml(p.Value))).ToList(),
        YamlSequenceNode sequence => sequence.Children.Select(FromYaml).ToList(),
        YamlScalarNode scalar => Scalar(scalar),
        _ => null,
    };

    // A PLAIN true/false is a YAML 1.2 boolean; a quoted one is the string, as the loader reads it.
    private static object? Scalar(YamlScalarNode scalar) => scalar.Style == ScalarStyle.Plain
        ? scalar.Value switch
        {
            "true" or "True" or "TRUE" => new RawBool(true, scalar.Value),
            "false" or "False" or "FALSE" => new RawBool(false, scalar.Value),
            _ => scalar.Value,
        }
        : scalar.Value;
}
