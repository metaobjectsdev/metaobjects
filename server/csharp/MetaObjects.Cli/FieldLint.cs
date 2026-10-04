// `dotnet meta verify` — the field AUTHORING lint.
//
// Two metadata mistakes about an object's FIELDS load with no error on every port:
//
//   1. An `identity.reference` whose `@fields` names a field the object does not have.
//      The loader resolves `@references` (the target) and never looks at `@fields`, so a
//      typo there produces a foreign key over a column nothing declares.
//   2. Two `field.*` children with the same `name` in one object's `children` list. The
//      later declaration is folded into the first, and one of a different subtype is
//      dropped, both silently.
//
// WHY THESE ARE WARNINGS AND NOT LOAD ERRORS. docs/compatibility-policy.md does not allow
// a new load error for metadata that loads today, so every finding here is a warning by
// construction: nothing in this file reaches an exit code.
//
// THE TWO HALVES READ DIFFERENT THINGS, and have to. The reference half reads the LOADED
// model, because "does this object have that field" is a question about the EFFECTIVE
// field set — inherited through `extends` and merged from overlay files. The duplicate
// half reads the RAW DOCUMENTS, because the merge has already erased the duplicate from
// the model by the time anything can ask.
//
// Mirrors the TS reference (server/typescript/packages/cli/src/lib/field-lint.ts +
// packages/metadata/src/loader/declared-duplicate-fields.ts). The codes, the message
// text and the fixtures are shared: fixtures/field-lint-conformance/.

using System.Text.Encodings.Web;
using System.Text.Json;
using MetaObjects.Loader;
using MetaObjects.Meta;
using YamlDotNet.RepresentationModel;
using static MetaObjects.Core.Identity.IdentityConstants;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;

namespace MetaObjects.Cli;

/// <summary>The advisory field lint <c>dotnet meta verify</c> runs on every invocation.</summary>
public static class FieldLint
{
    /// <summary>An <c>identity.reference</c> lists a field its object does not have.</summary>
    public const string WARN_REFERENCE_FIELD_NOT_FOUND = "WARN_REFERENCE_FIELD_NOT_FOUND";
    /// <summary>One <c>children</c> list declares the same field name more than once.</summary>
    public const string WARN_DUPLICATE_FIELD_NAME = "WARN_DUPLICATE_FIELD_NAME";

    /// <summary>Opt-out environment variable, beside <c>--no-field-lint</c> (Node <c>meta</c> parity).</summary>
    public const string EnvOptOut = "META_NO_FIELD_LINT";

    private const string KeyName = "name";
    private const string KeyPackage = "package";
    private const string KeyChildren = "children";
    private const char TypeSubTypeSeparator = '.';
    /// <summary>The YAML authoring sugar for <c>isArray: true</c> — a suffix on the wrapper key.</summary>
    private const string ArraySuffix = "[]";

    /// <summary>One advisory finding: its code, the node's address, and the message.</summary>
    public sealed record Finding(string Code, string Path, string Message);

    // The JSON string form, so the text is byte-identical to the other ports'. The relaxed
    // encoder keeps `"` as `\"` and leaves non-ASCII alone, as JSON.stringify does.
    private static readonly JsonSerializerOptions QuoteOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private static string Quote(string value) => JsonSerializer.Serialize(value, QuoteOptions);

    /// <summary>Report every <c>identity.reference</c> whose <c>@fields</c> names a field its object lacks.</summary>
    public static List<Finding> LintReferenceFields(MetaData root)
    {
        var findings = new List<Finding>();
        // OWN-ONLY (ADR-0039 sanctioned case): a root has no super, and its own children
        // are the declared objects.
        foreach (var obj in root.OwnChildren())
        {
            if (obj.Type != TYPE_OBJECT) continue;
            var address = obj.ResolutionKey();
            // RESOLVING: the effective field set — a field inherited through `extends` or
            // added by an overlay file is a field the object has.
            var fields = obj.Children().Where(c => c.Type == TYPE_FIELD).Select(c => c.Name).ToHashSet(StringComparer.Ordinal);
            // OWN-ONLY (ADR-0039 sanctioned case): report each DECLARATION once, on the
            // object that declares it. The resolving Children() would repeat an inherited
            // reference on every subtype.
            foreach (var identity in obj.OwnChildren())
            {
                if (identity.Type != TYPE_IDENTITY || identity.SubType != IDENTITY_SUBTYPE_REFERENCE) continue;
                // RESOLVING: `@fields` may itself be inherited through the identity's `extends`.
                foreach (var name in ListedFields(identity.Attr(IDENTITY_ATTR_FIELDS)))
                {
                    if (fields.Contains(name)) continue;
                    findings.Add(new Finding(
                        WARN_REFERENCE_FIELD_NOT_FOUND,
                        $"{address}.{identity.Name}",
                        $"identity.reference {Quote(identity.Name)} lists {Quote(name)} in @fields, but " +
                        $"{address} has no field of that name, inherited and overlaid fields included. Nothing " +
                        "checks this at load, so the reference is built on a field that does not exist. Rename " +
                        "the entry to an existing field, or declare the field."));
                }
            }
        }
        return findings;
    }

    private static IEnumerable<string> ListedFields(object? listed) => listed switch
    {
        string single => [single],
        IEnumerable<string> many => many,
        IEnumerable<object?> many => many.OfType<string>(),
        _ => [],
    };

    /// <summary>
    /// Structurally scan one document's raw content and report every field name a root-level
    /// object declares more than once in its own <c>children</c> list.
    /// </summary>
    /// <remarks>
    /// Scope is ONE children list: a field redeclared by an overlay file, or by a subtype
    /// overriding an inherited field, is not in one list and is not a finding. Malformed
    /// shapes return an empty list; a syntax error throws, as the parser's own would.
    /// </remarks>
    public static List<Finding> DeclaredDuplicateFields(string content, MetaDataFormat format)
    {
        var findings = new List<Finding>();
        var normalized = content.Length > 0 && content[0] == '﻿' ? content[1..] : content;
        var parsed = format == MetaDataFormat.Yaml ? ParseYaml(normalized) : ParseJson(normalized);
        if (parsed is not List<KeyValuePair<string, object?>> document) return findings;

        // JSON fuses the subtype onto the root key; sigil-free YAML may write the bare type.
        var rootBody = Get(document, $"{TYPE_METADATA}{TypeSubTypeSeparator}{SUBTYPE_ROOT}") ?? Get(document, TYPE_METADATA);
        if (rootBody is not List<KeyValuePair<string, object?>> root) return findings;
        var rootPkg = Get(root, KeyPackage) as string ?? "";
        if (Get(root, KeyChildren) is not List<object?> children) return findings;

        foreach (var child in children)
        {
            if (child is not List<KeyValuePair<string, object?>> wrapper) continue;
            foreach (var (wrapperKey, bodyValue) in wrapper)
            {
                if (WrapperType(wrapperKey) != TYPE_OBJECT) continue;
                if (bodyValue is not List<KeyValuePair<string, object?>> body) continue;
                var name = DeclaredName(body);
                if (name is null || Get(body, KeyChildren) is not List<object?> members) continue;

                // Insertion-ordered, so findings come out in document order.
                var order = new List<string>();
                var counts = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var member in members)
                {
                    if (member is not List<KeyValuePair<string, object?>> memberWrapper) continue;
                    foreach (var (memberKey, memberBody) in memberWrapper)
                    {
                        if (WrapperType(memberKey) != TYPE_FIELD) continue;
                        var fieldName = DeclaredName(memberBody);
                        if (fieldName is null) continue;
                        if (!counts.TryGetValue(fieldName, out var seen)) order.Add(fieldName);
                        counts[fieldName] = seen + 1;
                    }
                }

                // The resolution key the parser gives a root-level node: its own `package`
                // (a `::`-prefixed one is relative to the root's), else the root's.
                var ownPkg = Get(body, KeyPackage) as string;
                var pkg = string.IsNullOrEmpty(ownPkg)
                    ? rootPkg
                    : rootPkg.Trim() != "" && ownPkg.StartsWith(PACKAGE_SEPARATOR, StringComparison.Ordinal)
                        ? rootPkg + ownPkg
                        : ownPkg;
                var address = pkg != "" ? $"{pkg}{PACKAGE_SEPARATOR}{name}" : name;
                foreach (var fieldName in order)
                {
                    var count = counts[fieldName];
                    if (count < 2) continue;
                    findings.Add(new Finding(
                        WARN_DUPLICATE_FIELD_NAME,
                        $"{address}.{fieldName}",
                        $"{address} declares the field {Quote(fieldName)} {count} times in one children list. " +
                        "Nothing reports this at load, and only the first declaration is certain to take " +
                        "effect. Remove or rename the duplicate."));
                }
            }
        }
        return findings;
    }

    /// <summary>
    /// Run <see cref="DeclaredDuplicateFields"/> over each metadata file. Unreadable or
    /// unparsable files are skipped — the loader reports those itself.
    /// </summary>
    public static List<Finding> LintDuplicateFields(IEnumerable<string> files)
    {
        var findings = new List<Finding>();
        foreach (var path in files)
        {
            try
            {
                var source = new FileSource(path);
                findings.AddRange(DeclaredDuplicateFields(source.Read(), source.Format));
            }
            catch (Exception)
            {
                // An advisory scan never breaks verify.
            }
        }
        return findings;
    }

    /// <summary>
    /// Load the metadata <c>verify</c> was pointed at, lint it, and print the findings to
    /// <paramref name="stderr"/>. Warnings ONLY: this never throws and never changes the
    /// exit code. Loads LENIENT so the findings are the same with and without <c>--lax</c>;
    /// a load failure is the gate's to report, so it stays silent here.
    /// </summary>
    public static void RunAdvisory(string metadataDir, IReadOnlyList<string>? metadataFiles, IReadOnlyList<string>? libraries, TextWriter stderr)
    {
        List<Finding> findings;
        try
        {
            var load = metadataFiles is { } resolved
                ? MetaDataLoader.FromUris(resolved.Select(f => new Uri(f)).ToList(), libraries, false)
                : MetaDataLoader.FromDirectory(metadataDir, libraries, strict: false);
            if (load.Errors.Count > 0) return;
            var files = metadataFiles ?? new DirectorySource(metadataDir).Expand().Select(f => f.FilePath).ToList();
            findings = [.. LintReferenceFields(load.Root), .. LintDuplicateFields(files)];
        }
        catch (Exception)
        {
            return;
        }
        if (findings.Count == 0) return;
        stderr.WriteLine($"dotnet meta verify — fields: {findings.Count} authoring warning(s) (advisory — does not fail the build):");
        foreach (var f in findings) stderr.WriteLine($"  {f.Code} [{f.Path}]: {f.Message}");
    }

    // -- raw document model ---------------------------------------------------
    // A mapping is an ORDERED list of pairs, a sequence a List<object?>, a scalar a string.

    private static object? Get(List<KeyValuePair<string, object?>> mapping, string key)
    {
        foreach (var (k, v) in mapping)
            if (k == key) return v;
        return null;
    }

    /// <summary>The TYPE segment of a wrapper key: <c>field.string[]</c> and bare <c>field</c> are both <c>field</c>.</summary>
    private static string WrapperType(string key)
    {
        var dot = key.IndexOf(TypeSubTypeSeparator);
        var head = dot < 0 ? key : key[..dot];
        return head.EndsWith(ArraySuffix, StringComparison.Ordinal) ? head[..^ArraySuffix.Length] : head;
    }

    /// <summary>A node's declared name: the body's <c>name</c>, or the body itself when YAML wrote a scalar.</summary>
    private static string? DeclaredName(object? body)
    {
        var name = body is List<KeyValuePair<string, object?>> mapping ? Get(mapping, KeyName) : body;
        return name is string s && s != "" ? s : null;
    }

    private static object? ParseJson(string text)
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
        _ => null,
    };

    private static object? ParseYaml(string text)
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
        YamlScalarNode scalar => scalar.Value,
        _ => null,
    };
}
