// GeneratorGoldenTests — the output of DbContextGenerator and EntityGenerator (and NamesGenerator,
// round 2) for models that exercise every kind of field-type configuration, compared byte for byte
// against committed files. The fine-grained `protected virtual` hooks must not move a single line
// of default output; a refactor that did would fail here, not in an adopter's diff.
//
// How the files were established: this test was run with GOLDEN_WRITE=1 against the generators as
// they were before the hooks existed (no hooks at all), and the hooked generators' output was
// diffed against that capture. Every line that differs comes from one of these fixes, each its own
// CHANGELOG entry, and from nothing else:
//   - a literal @default is HasDefaultValue(v).HasSentinel(v) (Auth.Active, BridgeAuth.Quantity);
//   - a TPH subtype's own fields get their EF configuration (BridgeAuth's precision, durations,
//     primitive collection);
//   - a reference declared on an abstract TPH intermediate is configured on each concrete subtype
//     (CallJob, MailJob; CaseJob when abstract shapes are emitted);
//   - a <Entity>Names whose base lives in another namespace imports it (`using Acme.Base;`);
//   - under EmitAbstractShapes the DbContext configures the key and columns a concrete entity
//     inherits from its shape (Workflow).
// The committed files are the hooked output, so they are that capture plus exactly those lines.
//
// Recapture only for a deliberate change to default output: GOLDEN_WRITE=1 dotnet test --filter
// GeneratorGoldenTests, then review the diff line by line. Compare mode is the default.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class GeneratorGoldenTests
{
    // A scalar duration declared BEFORE an array duration, then decimal/timestamp/uri/inet/map/enum
    // array fields, a TPH hierarchy, flattened and jsonb value objects, a self-reference and a
    // write-through entity (Invoice) with its InvoiceView read model.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
        { "field.enum":   { "name": "kind",   "@values": ["HOME", "WORK"] } },
        { "field.duration": { "name": "window" } },
        { "field.map":    { "name": "hints",  "@valueType": "string" } }
      ]}},
      { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
        { "source.rdb": { "@table": "auths" } },
        { "field.long":   { "name": "id" } },
        { "field.enum":   { "name": "type", "@values": ["Bridge", "Plain"] } },
        { "field.duration": { "name": "ttl" } },
        { "field.duration": { "name": "slots", "isArray": true } },
        { "field.decimal": { "name": "amount", "@precision": 10, "@scale": 2 } },
        { "field.timestamp": { "name": "createdAt" } },
        { "field.uri":    { "name": "homepage" } },
        { "field.inet":   { "name": "addr" } },
        { "field.string": { "name": "tags", "isArray": true } },
        { "field.enum":   { "name": "statuses", "isArray": true, "@values": ["DRAFT", "LIVE"] } },
        { "field.object": { "name": "home", "@objectRef": "Address", "@storage": "flattened" } },
        { "field.object": { "name": "config", "@objectRef": "Address", "@storage": "jsonb" } },
        { "field.map":    { "name": "labels", "@valueType": "string" } },
        { "field.boolean": { "name": "active", "@default": true } },
        { "field.long":   { "name": "parentId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "refParent", "@fields": "parentId", "@references": "Auth" } }
      ]}},
      { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
        { "field.int":  { "name": "quantity", "@required": true, "@default": 3 } },
        { "field.duration": { "name": "grace" } },
        { "field.duration": { "name": "retries", "isArray": true } },
        { "field.decimal": { "name": "fee", "@precision": 8, "@scale": 2 } }
      ]}},
      { "object.entity": { "name": "Client", "children": [
        { "source.rdb": { "@kind": "table", "@table": "clients" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "identity.primary": { "name": "pk", "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Invoice", "children": [
        { "source.rdb": { "@role": "primary", "@kind": "table", "@table": "invoices" } },
        { "source.rdb": { "@role": "replica", "@kind": "view", "@view": "v_invoice_with_client" } },
        { "field.long":   { "name": "id" } },
        { "field.long":   { "name": "clientId", "@required": true } },
        { "field.duration": { "name": "term" } },
        { "field.duration": { "name": "reminders", "isArray": true } },
        { "field.decimal": { "name": "total", "@precision": 12, "@scale": 2 } },
        { "field.uri":    { "name": "docUrl" } },
        { "field.object": { "name": "billingAddress", "@objectRef": "Address", "@storage": "jsonb" } },
        { "field.string": { "name": "clientName", "extends": "Client.name", "children": [
          { "origin.passthrough": { "@from": "Client.name" } }
        ]}},
        { "relationship.association": { "name": "client", "@cardinality": "one", "@objectRef": "Client" } },
        { "identity.primary":   { "name": "pk", "@fields": "id" } },
        { "identity.reference": { "name": "refClient", "@fields": "clientId", "@references": "Client" } }
      ]}}
    ]}}
    """;

    // Found from the repo root, not [CallerFilePath]: a CI build (CI=true turns on
    // ContinuousIntegrationBuild) maps source paths to /_/, where no golden file exists.
    private static string GoldenDir() =>
        Path.Combine(CorpusPaths.RepoRoot(), "server", "csharp", "MetaObjects.Codegen.Tests", "Golden", "pre-hooks");

    [Fact]
    public void Default_output_matches_the_output_captured_before_the_hooks()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "golden.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        var files = new DbContextGenerator().Generate(ctx).Concat(new EntityGenerator().Generate(ctx)).ToList();
        Assert.Contains(files, f => f.Path == "InvoiceView.g.cs");

        var dir = GoldenDir();
        if (Environment.GetEnvironmentVariable("GOLDEN_WRITE") == "1")
        {
            Directory.CreateDirectory(dir);
            foreach (var f in files) File.WriteAllText(Path.Combine(dir, f.Path), f.Content);
            return;
        }
        var expected = Directory.GetFiles(dir).Select(p => Path.GetFileName(p)).Order().ToList();
        Assert.Equal(expected, files.Select(f => f.Path).Order().ToList());
        foreach (var f in files)
            Assert.Equal(File.ReadAllText(Path.Combine(dir, f.Path)), f.Content);
    }

    // The constructs the second round of hooks reaches (captured as described at the top):
    // an abstract base in ANOTHER package's namespace (its <Base>Names lives there too), a TPH
    // base with an abstract intermediate that declares a reference, a concrete subtype with its
    // own reference, a jsonb value object, and the names artifact itself. Run twice: with
    // abstract shapes emitted (the intermediate is a class) and without (it is folded into its
    // subtypes).
    private const string BasePackage = """
    { "metadata.root": { "package": "acme::base", "children": [
      { "object.entity": { "name": "BaseEntity", "abstract": true, "children": [
        { "field.long":      { "name": "id" } },
        { "field.timestamp": { "name": "createdAt" } }
      ]}}
    ]}}
    """;

    private const string WorkPackage = """
    { "metadata.root": { "package": "acme::work", "children": [
      { "object.value": { "name": "Note", "children": [
        { "field.string": { "name": "text", "@maxLength": 200 } },
        { "field.enum":   { "name": "level", "@values": ["LOW", "HIGH"] } }
      ]}},
      { "object.entity": { "name": "Workflow", "extends": "acme::base::BaseEntity", "children": [
        { "source.rdb": { "@table": "workflows" } },
        { "field.string": { "name": "title", "@maxLength": 80 } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Job", "@discriminator": "kind", "children": [
        { "source.rdb": { "@table": "jobs" } },
        { "field.long":   { "name": "id" } },
        { "field.enum":   { "name": "kind", "@values": ["Call", "Mail", "Plain"] } },
        { "field.object": { "name": "note", "@objectRef": "Note", "@storage": "jsonb" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "CaseJob", "extends": "Job", "abstract": true, "children": [
        { "field.long":   { "name": "workflowId" } },
        { "field.string": { "name": "subject", "@maxLength": 120 } },
        { "identity.reference": { "name": "refWorkflow", "@fields": "workflowId", "@references": "Workflow" } }
      ]}},
      { "object.entity": { "name": "CallJob", "extends": "CaseJob", "@discriminatorValue": "Call", "children": [
        { "field.string": { "name": "phone", "@maxLength": 20 } }
      ]}},
      { "object.entity": { "name": "MailJob", "extends": "CaseJob", "@discriminatorValue": "Mail", "children": [
        { "field.string": { "name": "address", "@maxLength": 120 } }
      ]}},
      { "object.entity": { "name": "PlainJob", "extends": "Job", "@discriminatorValue": "Plain", "children": [
        { "field.long": { "name": "ownerId" } },
        { "identity.reference": { "name": "refOwner", "@fields": "ownerId", "@references": "Workflow" } }
      ]}}
    ]}}
    """;

    internal static List<EmittedFile> GenerateRound2(bool shapes)
    {
        var ctx = Round2Context(shapes);
        return new DbContextGenerator().Generate(ctx)
            .Concat(new EntityGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .ToList();
    }

    internal static GenContext Round2Context(bool shapes)
    {
        var r = new MetaDataLoader().Load(
        [
            new InMemoryStringSource(BasePackage, id: "golden-base.json"),
            new InMemoryStringSource(WorkPackage, id: "golden-work.json"),
        ]);
        Assert.Empty(r.Errors);
        return new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig
            {
                OutDir = "/tmp", Namespace = "Acme", IncludeNames = true, EmitAbstractShapes = shapes,
                PackageNamespaces = new() { ["acme::base"] = "Acme.Base", ["acme::work"] = "Acme.Work" },
            },
        };
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Round_2_output_matches_the_output_captured_before_the_second_hooks(bool shapes)
    {
        var files = GenerateRound2(shapes);
        Assert.Contains(files, f => f.Path == "WorkflowNames.g.cs");

        var dir = Path.Combine(GoldenDir(), "..", "pre-hooks-2", shapes ? "shapes" : "no-shapes");
        if (Environment.GetEnvironmentVariable("GOLDEN_WRITE") == "1")
        {
            Directory.CreateDirectory(dir);
            foreach (var f in files) File.WriteAllText(Path.Combine(dir, f.Path), f.Content);
            return;
        }
        var expected = Directory.GetFiles(dir).Select(p => Path.GetFileName(p)).Order().ToList();
        Assert.Equal(expected, files.Select(f => f.Path).Order().ToList());
        foreach (var f in files)
            Assert.Equal(File.ReadAllText(Path.Combine(dir, f.Path)), f.Content);
    }
}
