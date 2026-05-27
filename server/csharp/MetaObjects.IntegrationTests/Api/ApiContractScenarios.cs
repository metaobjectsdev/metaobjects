// ApiContractScenarios — typed records + YAML loader for the
// api-contract-conformance corpus. Mirrors the Java reference runner's
// ApiContractScenarios + ApiContractScenarioLoader pair; the YAML wire shape
// is the cross-port contract documented at
// fixtures/api-contract-conformance/README.md.

using YamlDotNet.RepresentationModel;

namespace MetaObjects.IntegrationTests.Api;

/// <summary>A single HTTP request inside a scenario.</summary>
public sealed record ApiRequest(
    string Id,
    string Method,                                 // GET | POST | PATCH | PUT | DELETE
    string Path,                                   // includes query string
    object? Body,                                  // JSON-shaped (Dictionary | List | scalar) or null
    int ExpectStatus,
    Dictionary<string, object?>? ExpectBody);      // assertion vocabulary keys

/// <summary>A scenario file (one <c>*.yaml</c> under <c>scenarios/</c>).</summary>
public sealed record ApiScenario(
    string Name,
    string Description,
    string SourcePath,
    bool Truncate,                                  // true when setup.truncate is set
    IReadOnlyList<ApiRequest> Requests);

public static class ApiContractScenarioLoader
{
    public static IReadOnlyList<ApiScenario> LoadScenarios(string dir) =>
        Directory.EnumerateFiles(dir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(LoadScenario)
            .ToList();

    public static ApiScenario LoadScenario(string yamlPath)
    {
        // YamlStream gives us the full representation model — critical because
        // YamlDotNet's higher-level Deserialize<object> collapses every scalar
        // to a CLR string, losing the YAML 1.2 scalar inference (id: 3 →
        // long, not "3") the cross-port assertion engine depends on. Walk the
        // AST and use ScalarStyle.Plain (unquoted) vs Quoted to gate the
        // inference: plain scalars infer; quoted scalars stay string.
        var stream = new YamlStream();
        using (var rdr = new StreamReader(yamlPath))
            stream.Load(rdr);
        if (stream.Documents.Count == 0)
            throw new InvalidOperationException($"{yamlPath}: empty YAML document");
        if (stream.Documents[0].RootNode is not YamlMappingNode rootNode)
            throw new InvalidOperationException($"{yamlPath}: top-level YAML must be a mapping");
        var root = (Dictionary<string, object?>)YamlToObject(rootNode)!;

        bool truncate = false;
        if (root.TryGetValue("setup", out var setupObj) && setupObj is Dictionary<string, object?> setup)
        {
            if (setup.TryGetValue("truncate", out var t) && t is bool b) truncate = b;
        }

        var requests = new List<ApiRequest>();
        if (root.TryGetValue("requests", out var reqObj) && reqObj is List<object?> rawReqs)
        {
            foreach (var r in rawReqs)
            {
                if (r is Dictionary<string, object?> reqMap)
                    requests.Add(ParseRequest(reqMap, yamlPath));
            }
        }

        return new ApiScenario(
            Name: AsString(root, "name", Path.GetFileName(yamlPath)),
            Description: AsString(root, "description", ""),
            SourcePath: yamlPath,
            Truncate: truncate,
            Requests: requests);
    }

    private static ApiRequest ParseRequest(Dictionary<string, object?> r, string yamlPath)
    {
        if (!r.TryGetValue("expect", out var exObj) || exObj is not Dictionary<string, object?> expect)
            throw new InvalidOperationException($"{yamlPath}: request '{r.GetValueOrDefault("id")}' missing 'expect' block");
        if (!expect.TryGetValue("status", out var statusObj) || statusObj is null)
            throw new InvalidOperationException($"{yamlPath}: request '{r.GetValueOrDefault("id")}' missing 'expect.status'");
        int status = Convert.ToInt32(statusObj);

        Dictionary<string, object?>? expectBody = null;
        if (expect.TryGetValue("body", out var bodyObj) && bodyObj is Dictionary<string, object?> bm)
            expectBody = bm;

        if (!r.TryGetValue("method", out var methodObj) || methodObj is not string method)
            throw new InvalidOperationException($"{yamlPath}: request missing 'method'");
        if (!r.TryGetValue("path", out var pathObj) || pathObj is not string path)
            throw new InvalidOperationException($"{yamlPath}: request missing 'path'");

        r.TryGetValue("body", out var reqBody);

        return new ApiRequest(
            Id: AsString(r, "id", "?"),
            Method: method.ToUpperInvariant(),
            Path: path,
            Body: reqBody,
            ExpectStatus: status,
            ExpectBody: expectBody);
    }

    /// <summary>
    /// Convert a YamlNode tree into Dictionary&lt;string, object?&gt; +
    /// List&lt;object?&gt; + primitive scalars. Applies YAML 1.2 scalar
    /// inference (int / double / bool / null) to <see cref="ScalarStyle.Plain"/>
    /// scalars; quoted scalars stay strings. This matches the shape the live
    /// HTTP response decodes to after JSON parsing — apples-to-apples for the
    /// cross-port {@code equals} / {@code row} / {@code ids} assertions.
    /// </summary>
    internal static object? YamlToObject(YamlNode node)
    {
        switch (node)
        {
            case YamlMappingNode mn:
                var d = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var kvp in mn.Children)
                {
                    string key = ((YamlScalarNode)kvp.Key).Value ?? "";
                    d[key] = YamlToObject(kvp.Value);
                }
                return d;
            case YamlSequenceNode sn:
                var l = new List<object?>(sn.Children.Count);
                foreach (var item in sn.Children) l.Add(YamlToObject(item));
                return l;
            case YamlScalarNode scalar:
                return InferScalar(scalar);
            default:
                throw new InvalidOperationException($"unsupported YAML node kind: {node.GetType().Name}");
        }
    }

    private static object? InferScalar(YamlScalarNode scalar)
    {
        string s = scalar.Value ?? "";
        // Quoted scalars are always strings — short-circuit before inference.
        if (scalar.Style is YamlDotNet.Core.ScalarStyle.SingleQuoted
                          or YamlDotNet.Core.ScalarStyle.DoubleQuoted)
            return s;
        // Block scalars (literal `|`, folded `>`) are also string-typed.
        if (scalar.Style is YamlDotNet.Core.ScalarStyle.Literal
                          or YamlDotNet.Core.ScalarStyle.Folded)
            return s;
        // Plain (unquoted) scalar — apply YAML 1.2 core schema inference.
        if (s.Length == 0) return s;
        if (s == "null" || s == "~" || s == "Null" || s == "NULL") return null;
        if (s == "true" || s == "True" || s == "TRUE") return true;
        if (s == "false" || s == "False" || s == "FALSE") return false;
        if (long.TryParse(s, System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture, out var lv)) return lv;
        if (double.TryParse(s, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var dv)) return dv;
        return s;
    }

    private static string AsString(Dictionary<string, object?> m, string key, string fallback)
    {
        if (!m.TryGetValue(key, out var v) || v is null) return fallback;
        return v.ToString() ?? fallback;
    }
}
