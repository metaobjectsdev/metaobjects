using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using MetaObjects.Codegen;
using MetaObjects.Codegen.TemplateCodegen;
using MetaObjects.Loader;
using MetaObjects.Render;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port conformance gate (C#): runs spec.json over the shared
/// fixtures/template-codegen-conformance/ corpus and asserts byte-identical output
/// to expected/ (the TS-produced oracle). The render engine is already byte-equal
/// across ports, so any diff here is a C# data-dict or scope/pattern bug — never a
/// reason to edit expected/.
/// </summary>
public class TemplateCodegenConformanceTests
{
    private static string Corpus()
    {
        var root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "template-codegen-conformance")))
            root = Path.GetDirectoryName(root) ?? throw new InvalidOperationException("corpus not found");
        return Path.Combine(root, "fixtures", "template-codegen-conformance");
    }

    private static List<string> RelFiles(string root) =>
        Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .Select(p => Path.GetRelativePath(root, p).Replace('\\', '/'))
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();

    [Fact]
    public void CorpusMatchesExpectedByteForByte()
    {
        var corpus = Corpus();
        var spec = TemplateSpec.Parse(
            JsonDocument.Parse(File.ReadAllText(Path.Combine(corpus, "spec.json"))).RootElement);
        var root = MetaDataLoader.FromDirectory(Path.Combine(corpus, "metadata")).Root;
        var provider = new FilesystemProvider(Path.Combine(corpus, "templates"));

        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig { OutDir = "(unused)", Namespace = "Conformance" },
        };

        var outDir = Path.Combine(Path.GetTempPath(), "tmpl-conf-cs-" + Guid.NewGuid().ToString("N"));
        try
        {
            foreach (var gen in TemplateSpec.ToGenerators(spec, provider))
            {
                foreach (var f in gen.Generate(ctx))
                {
                    var target = Path.Combine(outDir, f.Path);
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    File.WriteAllText(target, f.Content);
                }
            }

            var expected = Path.Combine(corpus, "expected");
            Assert.Equal(RelFiles(expected), RelFiles(outDir));
            foreach (var rel in RelFiles(expected))
                Assert.True(
                    File.ReadAllText(Path.Combine(expected, rel)) == File.ReadAllText(Path.Combine(outDir, rel)),
                    $"byte mismatch in {rel}");
        }
        finally
        {
            if (Directory.Exists(outDir)) Directory.Delete(outDir, recursive: true);
        }
    }
}
