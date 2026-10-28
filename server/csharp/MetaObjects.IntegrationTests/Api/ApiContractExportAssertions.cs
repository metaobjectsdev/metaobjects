// ApiContractExportAssertions — the three assertion keys the report-export scenarios add to the
// api-contract vocabulary (docs/features/api-contract.md, "Report export"):
//
//   expect.headers   lower-cased header name -> exact value; null = the header is absent
//   body.text        the exact body, compared as UTF-8 text
//   body.xml         the body compared as an XML infoset: element names, attributes, text and
//                    order; the declaration and whitespace between elements are ignored
//
// A scenario that uses `text` or `xml` has a body that is not JSON, so the runner must not parse
// it as JSON; IsRawBody says when.

using System.Net.Http.Headers;
using System.Xml;
using System.Xml.Linq;

namespace MetaObjects.IntegrationTests.Api;

internal static class ApiContractExportAssertions
{
    /// <summary>True when the scenario asserts the body as raw text or XML rather than as JSON.</summary>
    public static bool IsRawBody(ApiRequest request) =>
        request.ExpectBody is { } body && (body.ContainsKey("text") || body.ContainsKey("xml"));

    public static void AssertHeaders(string scenarioName, ApiRequest request, HttpResponseMessage response)
    {
        if (request.ExpectHeaders is null) return;
        foreach (var (name, want) in request.ExpectHeaders)
        {
            var actual = HeaderValue(response, name);
            if (actual != want)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected header {name}={Quote(want)}, got {Quote(actual)}");
        }
    }

    public static void AssertRawBody(string scenarioName, ApiRequest request, string actualText)
    {
        var want = request.ExpectBody!;
        if (want.TryGetValue("text", out var textObj) && textObj is string wantText && actualText != wantText)
            throw new Xunit.Sdk.XunitException(
                $"{scenarioName} / {request.Id}: body text mismatch\n  expected: {Escape(wantText)}\n  actual:   {Escape(actualText)}");
        if (want.TryGetValue("xml", out var xmlObj) && xmlObj is string wantXml)
        {
            if (!InfosetEquals(wantXml, actualText, out var why))
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: body xml mismatch ({why})\n  expected: {wantXml}\n  actual:   {actualText}");
        }
    }

    // A response header's value, or null when absent. content-type and content-disposition live on
    // the content headers in HttpClient's model; every header is looked up on both.
    private static string? HeaderValue(HttpResponseMessage response, string lowerName)
    {
        IEnumerable<string>? values = null;
        if (response.Headers.TryGetValues(lowerName, out var h)) values = h;
        else if (response.Content.Headers.TryGetValues(lowerName, out var c)) values = c;
        return values is null ? null : string.Join(", ", values);
    }

    /// <summary>Element names, attributes (namespace declarations included), text and order; not the declaration, not whitespace between elements.</summary>
    public static bool InfosetEquals(string expected, string actual, out string why)
    {
        why = "";
        XElement e, a;
        try { e = XElement.Parse(expected); a = XElement.Parse(actual); }
        catch (XmlException ex) { why = "not well-formed: " + ex.Message; return false; }
        return ElementEquals(e, a, "/" + e.Name.LocalName, ref why);
    }

    private static bool ElementEquals(XElement e, XElement a, string path, ref string why)
    {
        if (e.Name != a.Name) { why = $"{path}: element {e.Name} vs {a.Name}"; return false; }
        var ea = e.Attributes().OrderBy(x => x.Name.ToString(), StringComparer.Ordinal).ToList();
        var aa = a.Attributes().OrderBy(x => x.Name.ToString(), StringComparer.Ordinal).ToList();
        if (ea.Count != aa.Count || ea.Zip(aa).Any(p => p.First.Name != p.Second.Name || p.First.Value != p.Second.Value))
        { why = $"{path}: attributes [{string.Join(" ", ea)}] vs [{string.Join(" ", aa)}]"; return false; }
        var en = e.Nodes().Where(Significant).ToList();
        var an = a.Nodes().Where(Significant).ToList();
        if (en.Count != an.Count) { why = $"{path}: {en.Count} child nodes vs {an.Count}"; return false; }
        for (var i = 0; i < en.Count; i++)
        {
            if (en[i] is XElement ec && an[i] is XElement ac)
            {
                if (!ElementEquals(ec, ac, path + "/" + ec.Name.LocalName + "[" + i + "]", ref why)) return false;
            }
            else if (en[i] is XText et && an[i] is XText at)
            {
                if (et.Value != at.Value) { why = $"{path}: text \"{et.Value}\" vs \"{at.Value}\""; return false; }
            }
            else { why = $"{path}: node kinds differ at {i}"; return false; }
        }
        return true;
    }

    // Whitespace-only text between ELEMENTS is insignificant; text that is the element's only content is not.
    private static bool Significant(XNode n) => n is not XText t || !string.IsNullOrWhiteSpace(t.Value) || t.Parent!.Nodes().All(x => x is XText);

    private static string Quote(string? s) => s is null ? "<absent>" : "\"" + s + "\"";
    private static string Escape(string s) => s.Replace("\r", "\\r", StringComparison.Ordinal).Replace("\n", "\\n", StringComparison.Ordinal).Replace("\t", "\\t", StringComparison.Ordinal);
}
