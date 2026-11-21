// ADR-0067 layer 0, the business-rules half: the rules-names generator.
//
// The model is fixtures/codegen-noop/rules/with, the corpus every port's inert test already
// loads. The expected names come from ADR-0066, not from the generator: the lifecycle's states
// are the enum's @values, its initial state the @default, its terminal states the members no
// transition leaves; a transition that a declared command claims derives no command of its own
// under `rules.lifecycle.commands: unclaimed`; an absent @permission derives
// `<package>.<Entity>.<transition>` or `<package>.<operation>`, and a @public node asks for none.
//
// Each test compiles the emitted files with Roslyn, loads the assembly and reads the constants
// back, so what is checked is what a consumer's code would see.

using System.Reflection;
using MetaObjects.Codegen.Generators;
using MetaObjects.Config;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class RulesNamesGeneratorTests
{
    private const string Ns = "Acme.Rules";

    private static MetaRoot Load(string variant = "with")
    {
        var path = Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "codegen-noop", "rules", variant, "meta.purchasing.json");
        var result = new MetaDataLoader().Load([new FileSource(path)]);
        Assert.True(result.Errors.Count == 0, string.Join("\n", result.Errors.Select(e => $"{e.Code}: {e.Message}")));
        return result.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/unused", Namespace = Ns },
    };

    private static IReadOnlyList<EmittedFile> Emit(MetaRoot root, RulesNamesGenerator? gen = null) =>
        (gen ?? new RulesNamesGenerator()).Generate(Ctx(root)).ToList();

    /// <summary>Compile the files and load them; a compile error fails the test with the diagnostics.</summary>
    private static Assembly Compile(IEnumerable<EmittedFile> files)
    {
        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)));
        var comp = CSharpCompilation.Create("rules_names_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var result = comp.Emit(ms);
        Assert.True(result.Success, string.Join("\n", result.Diagnostics
            .Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => $"{d.Id}: {d.GetMessage()}")));
        return Assembly.Load(ms.ToArray());
    }

    private static Type Nested(Assembly asm, string path)
    {
        var parts = path.Split('+');
        var type = asm.GetType($"{Ns}.{parts[0]}") ?? throw new Xunit.Sdk.XunitException($"no type {Ns}.{parts[0]}");
        foreach (var p in parts.Skip(1))
            type = type.GetNestedType(p) ?? throw new Xunit.Sdk.XunitException($"no nested type {p} in {type.FullName}");
        return type;
    }

    /// <summary>A class's const string members, member name to value, in declaration order.</summary>
    private static List<(string Name, string Value)> Consts(Type type) =>
        type.GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.IsLiteral)
            .OrderBy(f => f.MetadataToken)
            .Select(f => (f.Name, (string)f.GetRawConstantValue()!)).ToList();

    private static string? Const(Type type, string name) =>
        type.GetField(name, BindingFlags.Public | BindingFlags.Static)?.GetRawConstantValue() as string;

    [Fact]
    public void The_lifecycle_names_are_the_enums_states_and_transitions()
    {
        var asm = Compile(Emit(Load()));
        var status = Nested(asm, "PurchaseRequestRules+Status");

        Assert.Equal("status", Const(status, "Field"));
        Assert.Equal("draft", Const(status, "Initial"));
        Assert.Equal(["approved", "rejected"],
            (IReadOnlyList<string>)status.GetField("TerminalStates")!.GetValue(null)!);
        Assert.Equal(
            [("Draft", "draft"), ("Submitted", "submitted"), ("Approved", "approved"), ("Rejected", "rejected")],
            Consts(Nested(asm, "PurchaseRequestRules+Status+States")));
        Assert.Equal(
            [("Submit", "submit"), ("Approve", "approve"), ("Reject", "reject")],
            Consts(Nested(asm, "PurchaseRequestRules+Status+Transitions")));
    }

    [Fact]
    public void Only_a_transition_that_derives_a_command_gets_a_permission()
    {
        // `decide` claims approve and reject, so under the default only submit derives a command,
        // and it declares no @permission: the derived name.
        var asm = Compile(Emit(Load()));
        Assert.Equal([("Submit", "acme::purchasing.PurchaseRequest.submit")],
            Consts(Nested(asm, "PurchaseRequestRules+Status+Permissions")));
    }

    [Fact]
    public void Commands_all_gives_every_transition_its_permission_declared_or_derived()
    {
        var root = Load();
        root.Rules = RulesSettings.Default with { LifecycleCommands = "all" };
        var asm = Compile(Emit(root));
        Assert.Equal(
            [
                ("Submit", "acme::purchasing.PurchaseRequest.submit"),
                ("Approve", "acme::purchasing.PurchaseRequest.approve"),
                ("Reject", "purchasing.review"),
            ],
            Consts(Nested(asm, "PurchaseRequestRules+Status+Permissions")));
    }

    [Fact]
    public void Commands_none_derives_no_command_so_no_permission()
    {
        var root = Load();
        root.Rules = RulesSettings.Default with { LifecycleCommands = "none" };
        var asm = Compile(Emit(root));
        Assert.Null(Nested(asm, "PurchaseRequestRules+Status").GetNestedType("Permissions"));
        // The states and transitions do not depend on the setting.
        Assert.Equal(3, Consts(Nested(asm, "PurchaseRequestRules+Status+Transitions")).Count);
    }

    [Fact]
    public void Each_operation_carries_its_name_permission_and_errors()
    {
        var asm = Compile(Emit(Load()));

        var decide = Nested(asm, "PurchasingOperations+Decide");
        Assert.Equal("decide", Const(decide, "Name"));
        Assert.Equal("purchasing.decide", Const(decide, "Permission"));
        Assert.Equal([("OverBudget", "over_budget"), ("AlreadyDecided", "already_decided")],
            Consts(Nested(asm, "PurchasingOperations+Decide+Errors")));

        var summary = Nested(asm, "PurchasingOperations+RequestSummary");
        Assert.Equal("acme::purchasing.requestSummary", Const(summary, "Permission"));
        Assert.Null(summary.GetNestedType("Errors"));

        // @public: nothing to ask the policy.
        var open = Nested(asm, "PurchasingOperations+OpenRequests");
        Assert.Equal("openRequests", Const(open, "Name"));
        Assert.Null(Const(open, "Permission"));
    }

    [Fact]
    public void The_shells_own_codes_are_written_once()
    {
        var asm = Compile(Emit(Load()));
        Assert.Equal(
            [
                ("NotFound", "not_found"), ("Forbidden", "forbidden"), ("InvalidTransition", "invalid_transition"),
                ("TransitionConditionFailed", "transition_condition_failed"), ("StateManaged", "state_managed"),
            ],
            Consts(Nested(asm, "RuleErrorCodes")));
    }

    [Fact]
    public void A_model_with_no_rules_vocabulary_gets_no_file()
    {
        Assert.Empty(Emit(Load("without")));
    }

    [Fact]
    public void Include_scopes_the_entity_and_its_packages_operations()
    {
        var none = new RulesNamesGenerator { Include = o => o.Name == "NoSuchObject" };
        Assert.Empty(Emit(Load(), none));

        var paths = Emit(Load(), new RulesNamesGenerator { Include = o => o.Name == "PurchaseRequest" })
            .Select(f => f.Path).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(["PurchaseRequestRules.g.cs", "PurchasingOperations.g.cs", "RuleErrorCodes.g.cs"], paths);
    }

    [Fact]
    public void Two_names_folding_to_one_member_are_refused_naming_both()
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource("""
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Ticket", "children": [
                { "source.rdb": { "@table": "tickets" } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "field.enum": { "name": "status", "@values": ["open", "in_review", "inReview"], "@default": "open", "@normalize": "none",
                  "children": [
                    { "transition.action": { "name": "review", "@from": ["open"], "@to": "in_review" } },
                    { "transition.action": { "name": "hold", "@from": ["in_review"], "@to": "inReview" } }
                  ] } }
              ] } }
            ] } }
            """)]);
        Assert.Empty(load.Errors);
        var e = Assert.Throws<InvalidOperationException>(() => Emit(load.Root));
        Assert.Contains("state \"in_review\"", e.Message);
        Assert.Contains("state \"inReview\"", e.Message);
        Assert.Contains("\"InReview\"", e.Message);
    }
}
