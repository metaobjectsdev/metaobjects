using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// A reply type declared in a reference source (<c>{ "path": ..., "reference": true }</c>) resolves for
/// the prompt that names it, but no generator emits it: another run owns the type. The prompt's output
/// parser still emits and names the reply type exactly as it would have if generated here. Mirrors
/// server/typescript/packages/codegen-ts/test/reference-nodes-gen.test.ts.
/// </summary>
public sealed class ReferenceNodesGenTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "mo-ref-gen-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { /* best effort */ }
    }

    private const string Prompts = """
    { "metadata.root": { "package": "acme::support", "children": [
      { "object.value": { "name": "SupportRequest", "children": [ { "field.string": { "name": "question", "@required": true } } ] } },
      { "template.prompt": { "name": "SupportAnswerPrompt", "@payloadRef": "acme::support::SupportRequest",
          "@responseRef": "acme::support::SupportAnswer", "@textRef": "support/answer", "@format": "text" } }
    ]}}
    """;

    private const string Replies = """
    { "metadata.root": { "package": "acme::support", "children": [
      { "object.value": { "name": "SupportAnswer", "children": [
          { "field.string": { "name": "text", "@required": true } },
          { "field.object": { "name": "source", "@objectRef": "acme::support::AnswerSource" } } ] } },
      { "object.value": { "name": "AnswerSource", "children": [ { "field.string": { "name": "url" } } ] } }
    ]}}
    """;

    private Dictionary<string, string> Generate(bool reference)
    {
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        Directory.CreateDirectory(Path.Combine(_root, "model"));
        File.WriteAllText(Path.Combine(_root, "model", "meta.prompts.json"), Prompts);
        // The control keeps the reply file in the one ordinary source; the case under test moves it to a reference source.
        var replies = reference ? "replies" : "model";
        Directory.CreateDirectory(Path.Combine(_root, replies));
        File.WriteAllText(Path.Combine(_root, replies, "meta.replies.json"), Replies);
        var sources = reference
            ? """[ { "path": "model" }, { "path": "replies", "reference": true } ]"""
            : """[ { "path": "model" } ]""";
        File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"), $$"""{ "schema_version": 1, "sources": {{sources}} }""");

        var load = MetadataLocation.Resolve(null, _root).Load();
        Assert.Empty(load.Errors);

        var outDir = Path.Combine(_root, "out");
        CodegenRunner.Run(new GenConfig { OutDir = outDir, Namespace = "Acme.Generated" }, load.Root,
            [new EntityGenerator(), new OutputParserGenerator()]);
        return Directory.EnumerateFiles(outDir, "*.cs", SearchOption.AllDirectories)
            .ToDictionary(f => Path.GetRelativePath(outDir, f).Replace('\\', '/'), File.ReadAllText);
    }

    [Fact]
    public void A_reference_reply_type_gets_no_poco_but_its_parser_still_emits()
    {
        var files = Generate(reference: true);
        // The prompt's own payload type is the project's; the reply type and the value object it nests are not.
        Assert.Contains(files.Values, c => c.Contains("class SupportRequest") || c.Contains("record SupportRequest"));
        Assert.DoesNotContain(files.Values, c => c.Contains("class SupportAnswer ") || c.Contains("record SupportAnswer "));
        Assert.DoesNotContain(files.Values, c => c.Contains("class AnswerSource ") || c.Contains("record AnswerSource "));
        // The parser is emitted and names the reply type as it would have if it were generated here.
        var parser = Assert.Single(files, f => f.Key.EndsWith("SupportAnswerPrompt.response.cs", StringComparison.Ordinal));
        Assert.Contains("SupportAnswer", parser.Value);
    }

    [Fact]
    public void The_same_files_as_an_ordinary_source_do_emit_the_reply_type()
    {
        var files = Generate(reference: false);
        Assert.Contains(files.Values, c => c.Contains("class SupportAnswer") || c.Contains("record SupportAnswer"));
    }
}
