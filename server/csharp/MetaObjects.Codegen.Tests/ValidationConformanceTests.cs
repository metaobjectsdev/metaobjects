using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// SP-C validator-parity gate (C# port). Loads the shared
/// <c>fixtures/validation-conformance/</c> corpus, generates the <c>Account</c> DTO via
/// <see cref="EntityGenerator"/>, compiles it in-memory (Roslyn), materializes each
/// corpus payload onto an instance of the GENERATED type, and validates via
/// <see cref="Validator.TryValidateObject"/> (validateAllProperties: true). The boolean
/// verdict must match the single-source <c>expectValid</c> from <c>cases.json</c>.
///
/// This exercises the generated DataAnnotations directly — it is a behavioral gate on
/// the emitted artifact, not a string assertion.
/// </summary>
public sealed class ValidationConformanceTests
{
    private static string CorpusDir()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "validation-conformance")))
        {
            string? parent = Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new InvalidOperationException("fixtures/validation-conformance not found");
            root = parent;
        }
        return Path.Combine(root, "fixtures", "validation-conformance");
    }

    public static IEnumerable<object[]> Cases()
    {
        using JsonDocument doc = JsonDocument.Parse(
            File.ReadAllText(Path.Combine(CorpusDir(), "cases.json")));
        foreach (JsonElement c in doc.RootElement.GetProperty("cases").EnumerateArray())
            yield return new object[] { c.GetProperty("name").GetString()! };
    }

    [Fact]
    public void Discovers_all_validation_conformance_cases()
    {
        Assert.Equal(32, Cases().Count());
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Generated_dto_validation_matches_expected_verdict(string caseName)
    {
        Type accountType = GeneratedAccountType.Value;

        using JsonDocument doc = JsonDocument.Parse(
            File.ReadAllText(Path.Combine(CorpusDir(), "cases.json")));
        JsonElement theCase = doc.RootElement.GetProperty("cases").EnumerateArray()
            .Single(c => c.GetProperty("name").GetString() == caseName);

        JsonElement payload = theCase.GetProperty("payload");
        bool expectValid = theCase.GetProperty("expectValid").GetBoolean();

        // Deserialize the WHOLE payload onto the generated type (case-insensitive: the corpus JSON is
        // camelCase, the properties PascalCase) so property [JsonConverter]s — the #234 strict
        // field.uri / field.inet converters — are honored (a per-property reflection set would bypass
        // them). A bind failure IS an invalid verdict: a request whose body fails to deserialize
        // returns 400 exactly as a DataAnnotations failure does (matches TS safeParse / Python
        // construct). Remaining constraints are enforced by Validator.TryValidateObject.
        bool valid;
        var results = new List<ValidationResult>();
        try
        {
            object? instance = JsonSerializer.Deserialize(payload.GetRawText(), accountType,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            valid = instance is not null && Validator.TryValidateObject(
                instance, new ValidationContext(instance), results, validateAllProperties: true);
        }
        catch (JsonException)
        {
            valid = false;
        }

        Assert.True(valid == expectValid,
            $"case '{caseName}': expected valid={expectValid} but got valid={valid}; " +
            $"errors=[{string.Join("; ", results.Select(r => r.ErrorMessage))}]");
    }

    // The compiled, generated Account type — compiled once for the whole test class.
    private static class GeneratedAccountType
    {
        internal static readonly Type Value = Compile();

        private static Type Compile()
        {
            var loadResult = new MetaDataLoader().Load(
            [
                new FileSource(Path.Combine(CorpusDir(), "meta.json")),
            ]);
            Assert.Empty(loadResult.Errors);

            var ctx = new GenContext
            {
                Entities = loadResult.Root.Objects(),
                Root = loadResult.Root,
                Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Validation.Generated" },
            };

            var files = new EntityGenerator().Generate(ctx).ToList();
            var trees = files.Select(f =>
                CSharpSyntaxTree.ParseText(f.Content,
                    new CSharpParseOptions(LanguageVersion.CSharp12))).ToArray();

            var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
                .Split(Path.PathSeparator).Where(p => p.Length > 0)
                .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();

            var comp = CSharpCompilation.Create(
                "validationconformance_" + Guid.NewGuid().ToString("N"),
                trees, refs,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

            using var ms = new MemoryStream();
            var emit = comp.Emit(ms);
            var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
                .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
            Assert.True(errors.Count == 0,
                "generated Account DTO should compile, got: " + string.Join("; ", errors));

            ms.Seek(0, SeekOrigin.Begin);
            Assembly asm = Assembly.Load(ms.ToArray());
            return asm.GetType("Acme.Validation.Generated.Account")!;
        }
    }
}
