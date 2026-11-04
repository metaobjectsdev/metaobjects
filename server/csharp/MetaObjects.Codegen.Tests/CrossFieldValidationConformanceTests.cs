using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-field validator gate (C# port). Runs the shared
/// <c>fixtures/validation-conformance/cross-field-cases.json</c> corpus through the GENERATED
/// <c>Event</c> record (compiled in-memory with Roslyn) exactly the way
/// <see cref="ValidationConformanceTests"/> does: bind the payload, then
/// <see cref="Validator.TryValidateObject(object, ValidationContext, ICollection{ValidationResult}, bool)"/>
/// with validateAllProperties: true, which invokes <see cref="IValidatableObject"/> once the
/// property-level attributes pass.
/// </summary>
public sealed class CrossFieldValidationConformanceTests
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

    private static JsonElement[] AllCases()
    {
        using JsonDocument doc = JsonDocument.Parse(
            File.ReadAllText(Path.Combine(CorpusDir(), "cross-field-cases.json")));
        return doc.RootElement.GetProperty("cases").EnumerateArray().Select(c => c.Clone()).ToArray();
    }

    public static IEnumerable<object[]> Cases() =>
        AllCases().Select(c => new object[] { c.GetProperty("name").GetString()! });

    [Fact]
    public void Discovers_all_cross_field_cases() => Assert.Equal(23, AllCases().Length);

    [Theory]
    [MemberData(nameof(Cases))]
    public void Generated_record_cross_field_validation_matches_expected_verdict(string caseName)
    {
        JsonElement theCase = AllCases().Single(c => c.GetProperty("name").GetString() == caseName);
        string entityName = theCase.TryGetProperty("entity", out JsonElement e) ? e.GetString()! : "Event";
        Type type = Generated.Asm.GetType($"Acme.Events.Generated.{entityName}")!;
        bool expectValid = theCase.GetProperty("expectValid").GetBoolean();

        bool valid;
        var results = new List<ValidationResult>();
        try
        {
            object? instance = JsonSerializer.Deserialize(theCase.GetProperty("payload").GetRawText(), type,
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

    [Fact]
    public void Violation_names_the_target_members()
    {
        Type type = Generated.Asm.GetType("Acme.Events.Generated.Event")!;
        Assert.True(typeof(IValidatableObject).IsAssignableFrom(type));
        object inst = JsonSerializer.Deserialize(
            "{\"startsAt\":5,\"endsAt\":2,\"kind\":\"BIRTH\",\"state\":\"OPEN\",\"email\":\"a@b.c\"}", type,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        var results = new List<ValidationResult>();
        Assert.False(Validator.TryValidateObject(inst, new ValidationContext(inst), results, true));
        var members = results.SelectMany(r => r.MemberNames).ToHashSet();
        Assert.Contains("StartsAt", members);
        Assert.Contains("EndsAt", members);
        Assert.Contains("Subject", members); // BIRTH without a subject
    }

    private static class Generated
    {
        internal static readonly Assembly Asm = Compile();

        private static Assembly Compile()
        {
            var loadResult = new MetaDataLoader().Load(
                [new FileSource(Path.Combine(CorpusDir(), "meta.cross-field.json"))]);
            Assert.Empty(loadResult.Errors);
            var ctx = new GenContext
            {
                Entities = loadResult.Root.Objects(),
                Root = loadResult.Root,
                Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Events.Generated" },
            };
            var trees = new EntityGenerator().Generate(ctx)
                .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)))
                .ToArray();
            var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
                .Split(Path.PathSeparator).Where(p => p.Length > 0)
                .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
            var comp = CSharpCompilation.Create("crossfield_" + Guid.NewGuid().ToString("N"), trees, refs,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using var ms = new MemoryStream();
            var emit = comp.Emit(ms);
            var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
                .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
            Assert.True(errors.Count == 0, "generated cross-field record should compile, got: " + string.Join("; ", errors));
            return Assembly.Load(ms.ToArray());
        }
    }
}
