using System.Reflection;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Core.Requirement;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// <see cref="RequirementTestsGenerator"/>: the files it writes for the identity corpus's
/// <c>worked-example</c>, that the output COMPILES and behaves (a live test with no witness fails, with
/// one it passes), that author prose cannot break it, and every refusal and seam of Table I. The tests
/// this generator WRITES are xUnit, like the tests in this file.
/// </summary>
public sealed class RequirementTestsGeneratorTests : IDisposable
{
    private const string TestNamespace = "Acme.Req";
    private const string WitnessClass = "Acme.Witnesses";

    private readonly List<string> _temp = [];

    public void Dispose()
    {
        foreach (var dir in _temp)
        {
            try { Directory.Delete(dir, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    // ---------------------------------------------------------------- fixtures

    private string NewDir()
    {
        var dir = Directory.CreateTempSubdirectory("mo-req-tests-gen-").FullName;
        _temp.Add(dir);
        return dir;
    }

    private static string WorkedExampleInput() =>
        Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "requirement-test-identity-conformance", "worked-example", "input");

    private static MetaRoot LoadDir(string dir)
    {
        var load = MetaDataLoader.FromDirectory(dir, strict: true);
        Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));
        return load.Root;
    }

    private MetaRoot LoadYaml(string yaml)
    {
        var dir = NewDir();
        File.WriteAllText(Path.Combine(dir, "meta.shop.yaml"), yaml, new UTF8Encoding(false));
        return LoadDir(dir);
    }

    private static string Requirement(string name, int level, string status, string statement, string counterexample, string? implementedBy) =>
        $"    - requirement.functional:\n        name: {name}\n        level: {level}\n        status: {status}\n" +
        $"        statement: {statement}\n        counterexample: {counterexample}\n" +
        (implementedBy is null ? "" : $"        implementedBy: [{implementedBy}]\n");

    private const string OrderEntity =
        "    - object.entity:\n        name: Order\n        children:\n" +
        "          - field.uuid: { name: id }\n          - field.string: { name: total }\n" +
        "          - identity.primary: { name: pk, fields: [id] }\n";

    private static string Shop(params string[] requirements) =>
        "metadata:\n  package: acme::shop\n  children:\n" + OrderEntity + string.Concat(requirements);

    /// <summary>
    /// A generator with the uncovered warning OFF: the worked example has an L3 requirement the default
    /// filter drops, so most tests would otherwise warn, and test output must be pristine. Only the tests
    /// about the warning switch it on.
    /// </summary>
    private static RequirementTestsGenerator Generator(
        RequirementTestGrain grain = RequirementTestGrain.Concern,
        IRequirementTestFilter? filter = null,
        IRequirementTestRenderer? renderer = null,
        bool warnUncovered = false,
        string? testNamespace = TestNamespace,
        string? witnessClass = WitnessClass) =>
        new()
        {
            TestNamespace = testNamespace,
            WitnessClass = witnessClass,
            Grain = grain,
            Filter = filter,
            Renderer = renderer,
            WarnUncovered = warnUncovered,
        };

    private static GenContext Context(MetaRoot root, List<string>? warnings = null) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = Path.Combine(Path.GetTempPath(), "unused-requirement-tests"), Namespace = "Acme.Generated" },
        Warn = (warnings ?? []).Add,
    };

    private static Dictionary<string, string> Run(MetaRoot root, RequirementTestsGenerator? generator = null, List<string>? warnings = null) =>
        (generator ?? Generator()).Generate(Context(root, warnings)).ToDictionary(f => f.Path, f => f.Content);

    private const string Interface = "Requirements_acme_shop_Witnesses.g.cs";
    private const string Tests = "Requirements_acme_shop_Tests.g.cs";

    // ---------------------------------------------------------------- compile and run

    private const string WitnessNone =
        "namespace Acme { public class Witnesses : Acme.Req.Requirements_acme_shop_Witnesses { } }";

    private const string WitnessRecorded =
        "namespace Acme { public class Witnesses : Acme.Req.Requirements_acme_shop_Witnesses {\n" +
        "  public void req_acme_shop_Orders_Recorded__object_entity() { }\n} }";

    private static List<MetadataReference> References()
    {
        var refs = DbContextCompileTests.BuildReferences();
        foreach (var type in new[] { typeof(FactAttribute), typeof(Xunit.Sdk.XunitException) })
        {
            var location = type.Assembly.Location;
            if (!refs.Any(r => r is PortableExecutableReference p && p.FilePath == location))
                refs.Add(MetadataReference.CreateFromFile(location));
        }
        return refs;
    }

    /// <summary>
    /// Compile the generated tree beside a hand-written witness class with the real compiler, nullable
    /// enabled, and demand NO warning either: a generated test that warns warns in every adopter's build.
    /// </summary>
    private static Assembly Compile(Dictionary<string, string> generated, string witnessSource)
    {
        var parse = new CSharpParseOptions(LanguageVersion.CSharp12);
        var trees = generated.OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => CSharpSyntaxTree.ParseText(kv.Value, parse, path: kv.Key))
            .Append(CSharpSyntaxTree.ParseText(witnessSource, parse, path: "Witnesses.cs"))
            .ToList();
        var compilation = CSharpCompilation.Create(
            "requirement_tests_" + Guid.NewGuid().ToString("N"), trees, References(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        using var ms = new MemoryStream();
        var emit = compilation.Emit(ms);
        var problems = emit.Diagnostics.Where(d => d.Severity >= DiagnosticSeverity.Warning).Select(d => d.ToString()).ToList();
        Assert.True(emit.Success && problems.Count == 0, "generated requirement tests failed to compile cleanly:\n" + string.Join("\n", problems));
        return Assembly.Load(ms.ToArray());
    }

    /// <summary>Invoke one generated test method; returns the exception it threw, or null.</summary>
    private static Exception? Invoke(Assembly assembly, string className, string method)
    {
        var type = assembly.GetType($"{TestNamespace}.{className}") ?? throw new InvalidOperationException($"no type {className}");
        var instance = Activator.CreateInstance(type)!;
        try
        {
            type.GetMethod(method)!.Invoke(instance, null);
            return null;
        }
        catch (TargetInvocationException e)
        {
            return e.InnerException;
        }
    }

    // ---------------------------------------------------------------- the worked example

    [Fact]
    public void The_worked_example_emits_the_witness_interface_and_the_test_class()
    {
        var files = Run(LoadDir(WorkedExampleInput()));
        Assert.Equal([Tests, Interface], files.Keys.Order(StringComparer.Ordinal));
        Assert.Contains($"namespace {TestNamespace};", files[Interface]);
        Assert.Contains($"namespace {TestNamespace};", files[Tests]);
        Assert.Contains("public interface Requirements_acme_shop_Witnesses", files[Interface]);
        Assert.Contains("public class Requirements_acme_shop_Tests", files[Tests]);
    }

    [Fact]
    public void Both_files_say_they_are_generated_and_name_the_witness_class_in_their_header()
    {
        var files = Run(LoadDir(WorkedExampleInput()));
        Assert.StartsWith("// <auto-generated/>\n// GENERATED by metaobjects (requirement-tests). DO NOT EDIT: this file is rewritten whole.\n", files[Interface]);
        Assert.StartsWith("// <auto-generated/>\n// GENERATED by metaobjects (requirement-tests). DO NOT EDIT: this file is rewritten whole.\n", files[Tests]);
        Assert.Contains("// Witnesses are project-owned: implement this interface in Acme.Witnesses and override the members it has witnesses for.\n", files[Interface]);
        Assert.Contains("// The witnesses are project-owned, in Acme.Witnesses.\n", files[Tests]);
    }

    [Fact]
    public void Tests_are_emitted_sorted_by_id_in_code_units_whatever_order_they_are_declared_in()
    {
        // Declared alpha, Zeta, Beta: in neither id order. Ordinal order puts the upper case first
        // (Beta, Zeta, alpha); a culture collation would give alpha, Beta, Zeta.
        var root = LoadYaml(Shop(
            Requirement("alpha", 4, "live", "A.", "A!", "Order"),
            Requirement("Zeta", 4, "live", "Z.", "Z!", "Order"),
            Requirement("Beta", 4, "live", "B.", "B!", "Order")));
        var files = Run(root);
        foreach (var file in new[] { Interface, Tests })
        {
            var source = files[file];
            var beta = source.IndexOf("// acme::shop::Beta [object.entity]", StringComparison.Ordinal);
            var zeta = source.IndexOf("// acme::shop::Zeta [object.entity]", StringComparison.Ordinal);
            var alpha = source.IndexOf("// acme::shop::alpha [object.entity]", StringComparison.Ordinal);
            Assert.True(beta >= 0 && zeta >= 0 && alpha >= 0, file + ": all three present");
            Assert.True(beta < zeta && zeta < alpha, file + ": Beta, Zeta, alpha in that order");
        }
    }

    [Fact]
    public void The_interface_has_a_member_for_the_live_test_and_none_for_the_skipped_one()
    {
        var iface = Run(LoadDir(WorkedExampleInput()))[Interface];
        Assert.Contains("void req_acme_shop_Orders_Recorded__object_entity()", iface);
        Assert.DoesNotContain("req_acme_shop_Orders_Refunded", iface);
    }

    [Fact]
    public void The_skipped_test_carries_the_reason_of_table_H_and_an_empty_body()
    {
        var tests = Run(LoadDir(WorkedExampleInput()))[Tests];
        Assert.Contains("    [Fact(Skip = \"planned - not built yet\")]\n    public void req_acme_shop_Orders_Refunded()\n    {\n    }\n", tests);
        Assert.Contains("    private readonly Requirements_acme_shop_Witnesses witnesses = new Acme.Witnesses();", tests);
        Assert.Contains("        witnesses.req_acme_shop_Orders_Recorded__object_entity();", tests);
        // The comments above a test: id, statement, counterexample, status, claims, digest.
        Assert.Contains(
            "    // acme::shop::Orders.Recorded [object.entity]\n" +
            "    // An order is recorded when it is placed.\n" +
            "    // Counterexample: A placed order has no row.\n" +
            "    // Status: live\n" +
            "    // Claims: Order  (object.entity)\n" +
            "    // Digest: 2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a\n", tests);
        Assert.Contains("// Claims: (none)", tests);
    }

    [Fact]
    public void A_retired_test_says_the_capability_must_stay_removed_and_the_package_interface_is_empty()
    {
        var root = LoadYaml(Shop(Requirement("Gone", 4, "retired", "Old thing.", "Old thing returns.", null)));
        var files = Run(root);
        Assert.Contains("[Fact(Skip = \"retired - the capability was deliberately removed; assert it stays removed\")]", files[Tests]);
        // Every test of the package is skipped: no witness member at all.
        Assert.DoesNotContain("req_acme_shop_Gone", files[Interface]);
    }

    [Fact]
    public void The_output_imports_only_Xunit_and_names_nothing_of_MetaObjects()
    {
        var files = Run(LoadDir(WorkedExampleInput()));
        foreach (var (path, source) in files)
        {
            foreach (var line in source.Split('\n').Where(l => l.StartsWith("using ", StringComparison.Ordinal)))
                Assert.Equal("using Xunit;", line);
            Assert.DoesNotContain("MetaObjects", source, StringComparison.Ordinal);
            Assert.DoesNotContain("RequirementTestsGenerator", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Codegen", source, StringComparison.Ordinal);
            // The witness interface needs no import: it names XunitException in full.
            if (path == Interface) Assert.DoesNotContain("using ", source, StringComparison.Ordinal);
        }
        Assert.Contains("using Xunit;", files[Tests]);
    }

    [Fact]
    public void Output_is_byte_identical_on_a_rerun()
    {
        var root = LoadDir(WorkedExampleInput());
        Assert.Equal(Run(root), Run(root));
    }

    [Fact]
    public void A_live_test_with_no_witness_fails_naming_the_counterexample()
    {
        var assembly = Compile(Run(LoadDir(WorkedExampleInput())), WitnessNone);
        var failure = Invoke(assembly, "Requirements_acme_shop_Tests", "req_acme_shop_Orders_Recorded__object_entity");
        Assert.IsAssignableFrom<Xunit.Sdk.XunitException>(failure);
        Assert.Equal(
            "unimplemented requirement: acme::shop::Orders.Recorded [object.entity] - write Acme.Witnesses." +
            "req_acme_shop_Orders_Recorded__object_entity() so that it fails when: A placed order has no row.",
            failure!.Message);
    }

    [Fact]
    public void A_live_test_passes_when_the_witness_class_implements_it_and_a_skipped_test_is_skipped()
    {
        var assembly = Compile(Run(LoadDir(WorkedExampleInput())), WitnessRecorded);
        Assert.Null(Invoke(assembly, "Requirements_acme_shop_Tests", "req_acme_shop_Orders_Recorded__object_entity"));

        // The skipped test is a real [Fact(Skip = ...)] that xUnit will report as skipped, and runs empty.
        var skipped = assembly.GetType($"{TestNamespace}.Requirements_acme_shop_Tests")!.GetMethod("req_acme_shop_Orders_Refunded")!;
        var fact = skipped.GetCustomAttribute<FactAttribute>()!;
        Assert.Equal("planned - not built yet", fact.Skip);
        Assert.Null(Invoke(assembly, "Requirements_acme_shop_Tests", "req_acme_shop_Orders_Refunded"));
        var live = assembly.GetType($"{TestNamespace}.Requirements_acme_shop_Tests")!.GetMethod("req_acme_shop_Orders_Recorded__object_entity")!;
        Assert.Null(live.GetCustomAttribute<FactAttribute>()!.Skip);
    }

    // ---------------------------------------------------------------- escaping

    [Fact]
    public void Prose_with_quotes_backslashes_newlines_and_comment_terminators_still_compiles_and_is_carried()
    {
        // YAML double-quoted scalars: the statement decodes to  say "hi" to C:\dir<LF>second line */ end \u000a not an escape<CR>lone cr
        // and the counterexample to  it breaks "here" at C:\tmp<LF>then */ and \u000a
        const string statement = """ "say \"hi\" to C:\\dir\nsecond line */ end \\u000a not an escape\rlone cr" """;
        const string counterexample = """ "it breaks \"here\" at C:\\tmp\nthen */ and \\u000a" """;
        var root = LoadYaml(Shop(Requirement("Recorded", 4, "live", statement.Trim(), counterexample.Trim(), "Order")));
        var files = Run(root);
        var assembly = Compile(files, WitnessNone);

        var failure = Invoke(assembly, "Requirements_acme_shop_Tests", "req_acme_shop_Recorded__object_entity");
        Assert.IsAssignableFrom<Xunit.Sdk.XunitException>(failure);
        Assert.EndsWith("so that it fails when: it breaks \"here\" at C:\\tmp\nthen */ and \\u000a", failure!.Message);

        var tests = files[Tests];
        Assert.Contains("    // say \"hi\" to C:\\dir\n", tests);
        Assert.Contains("    // second line * / end \\u000a not an escape\n", tests);
        Assert.Contains("    // lone cr\n", tests);
        Assert.Contains("    // Counterexample: it breaks \"here\" at C:\\tmp\n    // then * / and \\u000a\n", tests);
    }

    [Fact]
    public void Carriage_returns_in_a_counterexample_are_escaped_in_the_literal_and_split_in_the_comment()
    {
        // YAML escapes: CR LF, then a lone CR. A raw CR in a string literal would end the line.
        var root = LoadYaml(Shop(Requirement("Recorded", 4, "live", "S.", "\"first\\r\\nsecond\\rthird\"", "Order")));
        var files = Run(root);
        Assert.All(files.Values, source => Assert.DoesNotContain('\r', source));
        Assert.Contains("so that it fails when: first\\r\\nsecond\\rthird\");", files[Interface]);
        Assert.Contains("    // Counterexample: first\n    // second\n    // third\n", files[Tests]);

        var assembly = Compile(files, WitnessNone);
        var failure = Invoke(assembly, "Requirements_acme_shop_Tests", "req_acme_shop_Recorded__object_entity");
        Assert.NotNull(failure);
        Assert.EndsWith("so that it fails when: first\r\nsecond\rthird", failure!.Message);
    }

    [Fact]
    public void The_other_line_terminators_of_the_language_cannot_end_a_literal_or_a_comment_early()
    {
        // U+0085, U+2028 and U+2029 end a C# line as a line feed does.
        var root = LoadYaml(Shop(Requirement("Recorded", 4, "live", "S.", "\"a\\u2028b\\u0085c\\u2029d\"", "Order")));
        var files = Run(root);
        var assembly = Compile(files, WitnessNone);
        Assert.All(files.Values, source => Assert.DoesNotContain("\u2028", source));
        Assert.Contains("    // Counterexample: a\n    // b\n    // c\n    // d\n", files[Tests]);
        var failure = Invoke(assembly, "Requirements_acme_shop_Tests", "req_acme_shop_Recorded__object_entity");
        Assert.EndsWith("so that it fails when: a\u2028b\u0085c\u2029d", failure!.Message);
    }

    // ---------------------------------------------------------------- refusals

    [Fact]
    public void Two_requirements_with_one_witness_key_are_refused_naming_the_code_and_both_ids()
    {
        // A name cannot hold a dot, so Orders.Recorded is a requirement nested under Orders.
        var root = LoadYaml(Shop(
            Requirement("Orders", 3, "live", "P.", "Q.", null)
                + "        children:\n          - requirement.functional:\n"
                + "              name: Recorded\n              level: 4\n              status: live\n"
                + "              statement: A.\n              counterexample: B.\n              implementedBy: [Order]\n",
            Requirement("Orders_Recorded", 4, "live", "C.", "D.", "Order")));
        var refused = Assert.Throws<InvalidOperationException>(() => Generator().Generate(Context(root)).ToList());
        Assert.Contains("ERR_REQUIREMENT_WITNESS_KEY_COLLISION", refused.Message);
        Assert.Contains("acme::shop::Orders.Recorded [object.entity]", refused.Message);
        Assert.Contains("acme::shop::Orders_Recorded [object.entity]", refused.Message);
        Assert.Contains("req_acme_shop_Orders_Recorded__object_entity", refused.Message);
    }

    [Fact]
    public void An_unknown_grain_is_refused_with_a_clear_error_whatever_the_model_holds()
    {
        var undefined = (RequirementTestGrain)7;
        foreach (var root in new[] { LoadDir(WorkedExampleInput()), LoadYaml(Shop()) })
        {
            var refused = Assert.Throws<ArgumentException>(() => Generator(grain: undefined).Generate(Context(root)).ToList());
            Assert.Contains("unknown requirement-test grain 7", refused.Message);
            Assert.Contains("\"concern\" or \"member\"", refused.Message);
        }
    }

    [Fact]
    public void A_test_namespace_or_witness_class_that_is_not_a_C_sharp_name_is_refused_rather_than_spliced_into_source()
    {
        var root = LoadDir(WorkedExampleInput());
        var badClass = Assert.Throws<InvalidOperationException>(() =>
            Generator(witnessClass: "Acme.W(); System.Environment.Exit(1").Generate(Context(root)).ToList());
        Assert.Contains("WitnessClass", badClass.Message);
        var badNamespace = Assert.Throws<InvalidOperationException>(() =>
            Generator(testNamespace: "Acme; using Evil").Generate(Context(root)).ToList());
        Assert.Contains("TestNamespace", badNamespace.Message);
    }

    [Fact]
    public void A_model_with_no_requirement_writes_nothing_and_warns_nothing_even_with_options_that_would_be_refused()
    {
        var warnings = new List<string>();
        var root = LoadYaml(Shop());
        Assert.Empty(Run(root, Generator(testNamespace: "not a name", witnessClass: "also not", warnUncovered: true), warnings));
        Assert.Empty(warnings);
    }

    // ---------------------------------------------------------------- defaults

    [Fact]
    public void With_no_option_at_all_the_names_are_derived_from_the_run_namespace()
    {
        // `dotnet meta gen --generators requirement-tests`: the registry builds it with nothing set.
        var generator = GeneratorRegistry.Get("requirement-tests")!.Factory(new GeneratorBuildContext());
        var files = generator.Generate(Context(LoadDir(WorkedExampleInput()))).ToDictionary(f => f.Path, f => f.Content);
        Assert.Contains("namespace Acme.Generated.Requirements;", files[Tests]);
        Assert.Contains("new Acme.Generated.RequirementWitnesses();", files[Tests]);
        Assert.Contains("implement this interface in Acme.Generated.RequirementWitnesses", files[Interface]);
    }

    [Fact]
    public void The_registry_lists_requirement_tests_as_a_native_capability_generator_with_an_ejectable_source()
    {
        var entry = GeneratorRegistry.Get("requirement-tests")!;
        Assert.Equal(GeneratorTier.Native, entry.Tier);
        Assert.Equal(GeneratorLayer.Capability, entry.Layer);
        Assert.Equal("RequirementTestsGenerator.cs", entry.SourceFileName);
        Assert.Equal("requirement-tests", entry.Factory(new GeneratorBuildContext()).Name);
    }

    // ---------------------------------------------------------------- grain, filter, renderer

    [Fact]
    public void Member_grain_writes_one_test_per_resolving_reference()
    {
        var root = LoadYaml(Shop(Requirement("Recorded", 4, "live", "S.", "C.", "Order, acme::shop::Order.total")));
        var tests = Run(root, Generator(grain: RequirementTestGrain.Member))[Tests];
        Assert.Contains("public void req_acme_shop_Recorded__Order()", tests);
        Assert.Contains("public void req_acme_shop_Recorded__acme_shop_Order_total()", tests);
        Assert.DoesNotContain("object_entity", tests);
    }

    private sealed class KeepEverything : IRequirementTestFilter
    {
        public bool Include(RequirementView view) => true;
    }

    [Fact]
    public void A_filter_keeps_an_L3_requirement_the_default_drops_and_it_renders_with_unit_star()
    {
        var root = LoadDir(WorkedExampleInput());
        Assert.DoesNotContain("req_acme_shop_Orders()", Run(root)[Tests]);
        var tests = Run(root, Generator(filter: new KeepEverything()))[Tests];
        Assert.Contains("// acme::shop::Orders [*]", tests);
        Assert.Contains("public void req_acme_shop_Orders()", tests);
    }

    private sealed class RecordingRenderer : IRequirementTestRenderer
    {
        public List<RequirementTestArgs> Seen { get; } = [];

        public RenderedTest? Render(RequirementTestArgs args)
        {
            Seen.Add(args);
            if (args.Identity.Path != "Orders.Recorded") return null;
            return new RenderedTest(
                ["System.Linq"],
                $"[Fact]\npublic void {args.Identity.WitnessKey}()\n{{\n    Assert.True(new[] {{ 1 }}.Any(), \"digest {args.Identity.Digest}\");\n}}");
        }
    }

    [Fact]
    public void A_renderer_replaces_one_test_and_receives_the_digest_while_the_others_keep_the_default()
    {
        var renderer = new RecordingRenderer();
        var files = Run(LoadDir(WorkedExampleInput()), Generator(renderer: renderer));
        var tests = files[Tests];
        Assert.Contains("using System.Linq;\nusing Xunit;\n", tests);
        Assert.Contains("        Assert.True(new[] { 1 }.Any(), \"digest 2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a\");", tests);
        Assert.DoesNotContain("witnesses.req_acme_shop_Orders_Recorded__object_entity();", tests);
        Assert.Contains("[Fact(Skip = \"planned - not built yet\")]", tests);

        Assert.Equal(2, renderer.Seen.Count);
        var recorded = renderer.Seen.Single(a => a.Identity.Path == "Orders.Recorded");
        Assert.Equal("An order is recorded when it is placed.", recorded.Statement);
        Assert.Equal("A placed order has no row.", recorded.Counterexample);
        Assert.Equal(new RequirementTestClaim("Order", "object.entity"), Assert.Single(recorded.Targets));
        Assert.Equal("2714aa3925a47959aa5e48ae39d80ed203fd4e2caa046a90aab9e04691d9881a", recorded.Identity.Digest);
        // The interface keeps its member whatever the renderer wrote.
        Assert.Contains("void req_acme_shop_Orders_Recorded__object_entity()", files[Interface]);
    }

    // ---------------------------------------------------------------- the uncovered warning

    [Fact]
    public void Excluded_requirements_produce_one_capped_warning_and_the_switch_silences_it()
    {
        var requirements = Enumerable.Range(1, 7).Select(i => Requirement($"Area{i}", 3, "live", "S.", "C.", null)).ToList();
        requirements.Add(Requirement("Recorded", 4, "live", "S.", "C.", "Order"));
        var root = LoadYaml(Shop([.. requirements]));

        var warnings = new List<string>();
        Run(root, Generator(warnUncovered: true), warnings);
        // Diagnostics name the PATH, never the package-qualified address, so the same model gives the
        // same names in every port.
        Assert.Equal(
            ["7 requirement(s) matched no filter and get no test. If that is deliberate, set WarnUncovered = false to silence this. " +
             "Uncovered: Area1, Area2, Area3, Area4, Area5, and 2 more."],
            warnings);

        var quiet = new List<string>();
        Run(root, Generator(warnUncovered: false), quiet);
        Assert.Empty(quiet);
    }

    [Fact]
    public void Five_or_fewer_excluded_requirements_are_all_named_and_no_more_is_said()
    {
        var root = LoadDir(WorkedExampleInput());
        var warnings = new List<string>();
        Run(root, Generator(warnUncovered: true), warnings);
        Assert.Equal(
            ["1 requirement(s) matched no filter and get no test. If that is deliberate, set WarnUncovered = false to silence this. Uncovered: Orders."],
            warnings);

        // Exactly five: all named, and no "and 0 more".
        var five = LoadYaml(Shop([.. Enumerable.Range(1, 5).Select(i => Requirement($"Area{i}", 3, "live", "S.", "C.", null))]));
        var fiveWarnings = new List<string>();
        Run(five, Generator(warnUncovered: true), fiveWarnings);
        Assert.Equal(
            ["5 requirement(s) matched no filter and get no test. If that is deliberate, set WarnUncovered = false to silence this. " +
             "Uncovered: Area1, Area2, Area3, Area4, Area5."],
            fiveWarnings);
    }

    [Fact]
    public void Nothing_excluded_means_nothing_said()
    {
        var root = LoadYaml(Shop(Requirement("Recorded", 4, "live", "S.", "C.", "Order")));
        var warnings = new List<string>();
        Run(root, Generator(warnUncovered: true), warnings);
        Assert.Empty(warnings);
    }

    // ---------------------------------------------------------------- stale files

    [Fact]
    public void Stale_file_gen_never_removes_the_files_of_a_package_that_lost_its_last_requirement_and_verify_codegen_reports_them()
    {
        const string billing =
            "metadata:\n  package: acme::billing\n  children:\n" +
            "    - object.entity:\n        name: Invoice\n        children:\n" +
            "          - field.uuid: { name: id }\n          - identity.primary: { name: pk, fields: [id] }\n";
        var billed = Requirement("Billed", 4, "live", "S.", "C.", "Invoice");
        var dir = NewDir();
        File.WriteAllText(Path.Combine(dir, "meta.billing.yaml"), billing + billed, new UTF8Encoding(false));
        File.WriteAllText(Path.Combine(dir, "meta.shop.yaml"), Shop(Requirement("Recorded", 4, "live", "S.", "C.", "Order")), new UTF8Encoding(false));

        var outDir = Path.Combine(NewDir(), "generated");
        var config = new GenConfig { OutDir = outDir, Namespace = "Acme.Generated" };
        IReadOnlyList<IGenerator> generators = [Generator()];
        CodegenRunner.Run(config, LoadDir(dir), generators);
        string[] both =
        [
            "Requirements_acme_billing_Tests.g.cs", "Requirements_acme_billing_Witnesses.g.cs",
            "Requirements_acme_shop_Tests.g.cs", "Requirements_acme_shop_Witnesses.g.cs",
        ];
        Assert.Equal(both, Directory.GetFiles(outDir).Select(Path.GetFileName).Order(StringComparer.Ordinal));
        Assert.True(CodegenDrift.Compute(config, LoadDir(dir), generators).Clean);

        // The billing package loses its requirement.
        File.WriteAllText(Path.Combine(dir, "meta.billing.yaml"), billing, new UTF8Encoding(false));
        var after = LoadDir(dir);
        CodegenRunner.Run(config, after, generators);

        // What gen does, as for every generator of this port: it does not delete. The two files stay...
        Assert.Equal(both, Directory.GetFiles(outDir).Select(Path.GetFileName).Order(StringComparer.Ordinal));
        // ...and `dotnet meta verify --codegen` reports each of them.
        var drift = CodegenDrift.Compute(config, after, generators);
        Assert.False(drift.Clean);
        Assert.Equal(["Requirements_acme_billing_Tests.g.cs", "Requirements_acme_billing_Witnesses.g.cs"], drift.DriftedFiles);
        Assert.All(drift.Lines, line => Assert.Contains("committed but a fresh regen would not emit it", line));
    }

    [Fact]
    public void A_change_to_a_claim_makes_verify_codegen_go_red_through_the_digest_in_the_file()
    {
        var dir = NewDir();
        File.WriteAllText(Path.Combine(dir, "meta.shop.yaml"), Shop(Requirement("Recorded", 4, "live", "S.", "C.", "Order")), new UTF8Encoding(false));
        var outDir = Path.Combine(NewDir(), "generated");
        var config = new GenConfig { OutDir = outDir, Namespace = "Acme.Generated" };
        IReadOnlyList<IGenerator> generators = [Generator()];
        CodegenRunner.Run(config, LoadDir(dir), generators);

        File.WriteAllText(Path.Combine(dir, "meta.shop.yaml"), Shop(Requirement("Recorded", 4, "live", "S, reworded.", "C.", "Order")), new UTF8Encoding(false));
        var drift = CodegenDrift.Compute(config, LoadDir(dir), generators);
        Assert.Contains("Requirements_acme_shop_Tests.g.cs", drift.DriftedFiles);
    }
}
