// Runs the shared response-verify corpus (fixtures/response-verify-conformance/cases.json) against this
// port's template gate. Contract: server/typescript/packages/cli/src/lib/response-verify.ts.
using System.Text.Json;
using MetaObjects.Cli;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class ResponseVerifyConformanceTests
{
    private sealed record Case(string Name, string MetadataText, List<(string Template, string Code, string Path, string Severity)> Expect);

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in LoadCases()) data.Add(c.Name);
        return data;
    }

    private static string CorpusPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "response-verify-conformance", "cases.json");
    }

    private static List<Case> LoadCases()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(CorpusPath()));
        return doc.RootElement.GetProperty("cases").EnumerateArray().Select(el => new Case(
            el.GetProperty("name").GetString()!,
            el.GetProperty("metadata").GetRawText(),
            el.GetProperty("expect").EnumerateArray().Select(e =>
                (e.GetProperty("template").GetString()!, e.GetProperty("code").GetString()!,
                 e.GetProperty("path").GetString()!, e.GetProperty("severity").GetString()!)).ToList())).ToList();
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void ReportsTheReplyFindingsTheCorpusPins(string name)
    {
        var c = LoadCases().Single(x => x.Name == name);
        var load = new MetaDataLoader().Load([new InMemoryStringSource(c.MetadataText, id: "case.json")]);
        Assert.Empty(load.Errors);

        var templates = Path.Combine(Path.GetTempPath(), "mo-resp-verify-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(templates);
        try
        {
            var outcome = VerifyCommand.Run(load, templates);
            static bool IsReply(string code) => code is ResponseVerify.ERR_RESPONSE_UNRESOLVED or ResponseVerify.ERR_RESPONSE_TAG_UNDECLARED;
            var got = outcome.Errors.Select(d => (d.Template, d.Code, d.Path, Severity: "error"))
                .Concat(outcome.Warnings.Select(d => (d.Template, d.Code, d.Path, Severity: "warning")))
                .Where(d => IsReply(d.Code))
                .OrderBy(d => d.Template, StringComparer.Ordinal).ThenBy(d => d.Path, StringComparer.Ordinal).ToList();
            var want = c.Expect.OrderBy(d => d.Template, StringComparer.Ordinal).ThenBy(d => d.Path, StringComparer.Ordinal).ToList();
            Assert.Equal(want, got);
        }
        finally
        {
            Directory.Delete(templates, recursive: true);
        }
    }
}
