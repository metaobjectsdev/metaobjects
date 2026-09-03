// NO MAGIC STRINGS — the C# half of the gate that makes "generated code references the
// constant" checkable instead of asserted. Port of the TypeScript
// server/typescript/packages/codegen-ts/test/no-magic-physical-names.test.ts.
//
// METHOD — a DE-BLINDED fixture. Every physical name below is deliberately impossible
// for a generator to produce by derivation: it is not the snake_case of its field name,
// not the pluralization of its object name, and carries a `zz_phys_` prefix nothing else
// in the codebase uses. So a generator that embeds a literal cannot be confused with one
// that derived the same string by coincidence — if the token appears in a file, that file
// hard-coded it.
//
// Every token carries its REACH — whether it is expected to travel as a constant today,
// or is one of the categories this port still spells literally. A KnownLiteral is PINNED,
// not exempted: the gate asserts the literal is still there, so the day a generator starts
// referencing the constant instead, this test fails and says "promote it". A known gap
// that stops being a gap without anyone noticing is how a ledger rots.

using MetaObjects.Cli;
using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using System.Text.RegularExpressions;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class NoMagicPhysicalNamesTests
{
    /// <summary>How a physical name is expected to reach generated output today.</summary>
    private enum Reach
    {
        /// <summary>Must travel as a `<Entity>Names` reference, and appear literally nowhere else.</summary>
        Constant,
        /// <summary>Still spelled literally, for the reason on the row. Pinned, not exempted.</summary>
        KnownLiteral,
    }

    // ---------------------------------------------------------------------------
    // The de-blinded fixture. The first eight tokens are kept in step with the
    // TypeScript gate's constants so a reader can diff the two ports' coverage directly.
    // ---------------------------------------------------------------------------
    private const string Table = "zz_phys_tbl_alpha";       // NOT pluralize(snake("Customer"))
    private const string ColId = "zz_phys_col_ident";       // NOT snake("id")
    private const string ColEmail = "zz_phys_col_mail";     // NOT snake("email")
    private const string ColFk = "zz_phys_col_owner";       // NOT snake("customerId")
    private const string OrderTable = "zz_phys_tbl_beta";   // NOT pluralize(snake("Order"))
    private const string OrderId = "zz_phys_col_okey";
    private const string View = "zz_phys_view_gamma";       // NOT "v_" + snake("CustomerSummary")
    private const string VoCol = "zz_phys_col_street";

    // A single-jsonb-column value object: the field IS one physical column, so it has a
    // constant like any scalar.
    private const string JsonbCol = "zz_phys_col_blob";

    // The two categories C# documents as literal-only, each reachable by this fixture.
    // FlatPrefix is deliberately NOT tracked on its own: under @storage: flattened the
    // field's "column" is not a column at all, only the prefix each member column is built
    // from, so there is nothing for a generator to reference it AS.
    private const string FlatPrefix = "zz_phys_col_pfx";
    private const string VoMemberCol = "zz_phys_col_road";        // a member of the value object
    private const string FlatCol = FlatPrefix + "_" + VoMemberCol; // what EF is actually told
    private const string WtTable = "zz_phys_tbl_delta";           // a write-through entity's table
    private const string WtView = "zz_phys_view_delta";           // ...and its replica view
    private const string WtId = "zz_phys_col_acct";               // ...and its key column

    /// <summary>Every de-blinded token, with the constant a generator should have referenced.</summary>
    private static readonly (string Literal, string ShouldUse, Reach Reach, string Why)[] Tokens =
    [
        (Table,      "CustomerNames.Name",             Reach.Constant, ""),
        (ColId,      "CustomerNames.IdColumn",         Reach.Constant, ""),
        (ColEmail,   "CustomerNames.EmailColumn",      Reach.Constant, ""),
        (OrderTable, "OrderNames.Name",                Reach.Constant, ""),
        (OrderId,    "OrderNames.IdColumn",            Reach.Constant, ""),
        (ColFk,      "OrderNames.CustomerIdColumn",    Reach.Constant, ""),
        (View,       "CustomerSummaryNames.Name",      Reach.Constant, ""),
        (VoCol,      "CustomerNames.StreetColumn",     Reach.Constant, ""),
        (JsonbCol,   "CustomerNames.ProfileColumn",    Reach.Constant, ""),
        (WtTable,    "AccountNames.Name",              Reach.Constant, ""),
        (WtId,       "AccountNames.IdColumn",          Reach.Constant, ""),

        (FlatCol,    "(no constant exists)", Reach.KnownLiteral,
            "A flattened object.value's nested column is a COMPOSITE (owner field column + \"_\" + " +
            "member column). The value object has no source and so no <Vo>Names, and the owner's " +
            "artifact carries one constant per FIELD, not per flattened member — there is no single " +
            "constant to reference. DbContextGenerator.EmitOwnedTypeConfig."),
        (WtView,     "(no constant exists)", Reach.KnownLiteral,
            "A write-through entity has TWO physical names; <Entity>Names carries the PRIMARY source's " +
            "only. The replica view name has no slot in the artifact's schema. DbContextGenerator, " +
            "the .ToView(...) for the <Entity>View read model."),
    ];

    // Placeholder substitution rather than raw-string interpolation: the fixture is JSON,
    // whose `}}` runs collide with an interpolation hole's closing delimiter.
    private static readonly string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "road", "@column": "__VO_MEMBER_COL__" } }
      ]}},
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "__TABLE__" } },
        { "field.long":   { "name": "id",     "@column": "__COL_ID__" } },
        { "field.string": { "name": "email",  "@column": "__COL_EMAIL__", "@required": true } },
        { "field.string": { "name": "street", "@column": "__VO_COL__" } },
        { "field.object": { "name": "address", "@column": "__FLAT_PREFIX__",
                            "@objectRef": "Address", "@storage": "flattened" } },
        { "field.object": { "name": "profile", "@column": "__JSONB_COL__",
                            "@objectRef": "Address", "@storage": "jsonb" } },
        { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.projection": { "name": "CustomerSummary", "children": [
        { "source.rdb": { "@kind": "view", "@view": "__VIEW__" } },
        { "field.long":   { "name": "id",    "extends": "Customer.id" } },
        { "field.string": { "name": "email", "children": [
          { "origin.passthrough": { "@from": "Customer.email" } } ]}},
        { "identity.primary": { "name": "pk", "extends": "Customer.pk" } }
      ]}},
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "__ORDER_TABLE__" } },
        { "field.long": { "name": "id",         "@column": "__ORDER_ID__" } },
        { "field.long": { "name": "customerId", "@column": "__COL_FK__" } },
        { "identity.primary":   { "name": "pk", "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { "name": "customerRef", "@fields": "customerId", "@references": "Customer" } },
        { "relationship.association": { "name": "customer", "@cardinality": "one", "@objectRef": "Customer" } }
      ]}},
      { "object.entity": { "name": "Account", "children": [
        { "source.rdb": { "@table": "__WT_TABLE__", "@role": "primary" } },
        { "source.rdb": { "@kind": "view", "@view": "__WT_VIEW__", "@role": "replica" } },
        { "field.long":   { "name": "id",    "@column": "__WT_ID__" } },
        { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
      ]}}
    ]}}
    """
        .Replace("__TABLE__", Table)
        .Replace("__COL_ID__", ColId)
        .Replace("__COL_EMAIL__", ColEmail)
        .Replace("__VO_COL__", VoCol)
        .Replace("__FLAT_PREFIX__", FlatPrefix)
        .Replace("__JSONB_COL__", JsonbCol)
        .Replace("__VO_MEMBER_COL__", VoMemberCol)
        .Replace("__VIEW__", View)
        .Replace("__ORDER_TABLE__", OrderTable)
        .Replace("__ORDER_ID__", OrderId)
        .Replace("__COL_FK__", ColFk)
        .Replace("__WT_TABLE__", WtTable)
        .Replace("__WT_VIEW__", WtView)
        .Replace("__WT_ID__", WtId);

    /// <summary>A names artifact is the ONE file allowed to spell a physical name literally.</summary>
    private static bool IsNamesArtifact(string path) => path.EndsWith("Names.g.cs", StringComparison.Ordinal);

    /// <summary>Run the DEFAULT generator suite — the one `dotnet meta gen` runs — over the fixture.</summary>
    private static IReadOnlyList<EmittedFile> Generate()
    {
        var result = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "no-magic.json")]);
        // A gate whose fixture the loader would reject proves nothing.
        Assert.Empty(result.Errors);

        var names = GenCommand.DefaultGeneratorNames;
        var ctx = new GenContext
        {
            Entities = result.Root.Objects(),
            Root = result.Root,
            Config = new GenConfig
            {
                OutDir = "/unused",
                Namespace = "Acme.Generated",
                ColumnNamingStrategy = ColumnNamingStrategy.SnakeCase,
                // The names artifact IS in the run: this gate measures the ON arm. The OFF
                // arm legitimately emits literals — that is the documented fallback.
                IncludeNames = GeneratorRegistry.IncludesNames(names),
            },
        };
        return GeneratorRegistry.Resolve(names).SelectMany(g => g.Generate(ctx)).ToList();
    }

    [Fact]
    public void Emits_a_names_artifact_carrying_every_de_blinded_physical_name()
    {
        var files = Generate();
        var names = files.Where(f => IsNamesArtifact(f.Path)).ToList();
        // Teeth: with no names artifact at all every assertion below passes vacuously.
        Assert.NotEmpty(names);
        var all = string.Join("\n", names.Select(f => f.Content));
        var missing = Tokens.Where(t => t.Reach == Reach.Constant && !all.Contains(t.Literal, StringComparison.Ordinal))
            .Select(t => $"{t.Literal} appears in no names artifact — {t.ShouldUse} cannot exist")
            .OrderBy(s => s, StringComparer.Ordinal).ToList();
        Assert.True(missing.Count == 0, string.Join("\n", missing));
    }

    [Fact]
    public void References_the_constant_everywhere_else_no_generated_file_spells_one_literally()
    {
        var offenders = (from f in Generate()
                         where !IsNamesArtifact(f.Path)
                         from t in Tokens
                         where t.Reach == Reach.Constant
                         where f.Content.Contains(t.Literal, StringComparison.Ordinal)
                         select $"{f.Path}: hard-codes \"{t.Literal}\" — should reference {t.ShouldUse}")
                        .OrderBy(s => s, StringComparer.Ordinal).ToList();

        // Reported as a sorted list rather than a boolean, so a failure enumerates every
        // remaining gap in one run instead of one per fix-and-rerun cycle.
        Assert.True(offenders.Count == 0, string.Join("\n", offenders));
    }

    [Fact]
    public void Actually_references_each_constant_absence_of_the_literal_is_not_use_of_the_constant()
    {
        // The teeth for the test above. "No file contains the literal" is satisfied just as
        // well by a generator that emits NOTHING, or by one that emits a name it derived
        // instead of read. This asserts the positive.
        var body = string.Join("\n", Generate().Where(f => !IsNamesArtifact(f.Path)).Select(f => f.Content));
        var unreferenced = Tokens
            .Where(t => t.Reach == Reach.Constant)
            .Where(t => !body.Contains(t.ShouldUse, StringComparison.Ordinal))
            .Select(t => $"{t.ShouldUse} (for \"{t.Literal}\") is referenced by no generated file")
            .OrderBy(s => s, StringComparer.Ordinal).ToList();

        Assert.True(unreferenced.Count == 0, string.Join("\n", unreferenced));
    }

    [Fact]
    public void Lets_no_physical_name_escape_that_is_not_a_declared_known_literal()
    {
        // The exhaustive form, and the strongest statement this gate can make. Tokens says
        // what each KNOWN name should do; this says there is nothing ELSE. Every physical
        // name in the fixture is `zz_phys_`-prefixed, so any such token appearing outside a
        // names artifact is a physical name that escaped, whether or not anyone thought to
        // list it.
        //
        // Equality in BOTH directions. A new escape fails — including one from a generator
        // added after this test was written, which a hand-maintained list would miss. And so
        // does a KnownLiteral quietly fixed: a "known gaps" list nothing re-checks is how a
        // ledger ends up describing a codebase that moved on.
        var escaped = Generate()
            .Where(f => !IsNamesArtifact(f.Path))
            .SelectMany(f => Regex.Matches(f.Content, @"zz_phys_\w+").Select(m => m.Value))
            .Distinct().OrderBy(s => s, StringComparer.Ordinal).ToList();
        var declared = Tokens.Where(t => t.Reach == Reach.KnownLiteral)
            .Select(t => t.Literal).OrderBy(s => s, StringComparer.Ordinal).ToList();

        Assert.Equal(declared, escaped);
    }
}
