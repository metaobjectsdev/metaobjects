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
// or is one of the categories this port still spells literally, or one it drops. The
// non-Constant values are PINNED, not exempted: the gate asserts the literal is still there
// (or, for Dropped, still unread), so the day a generator changes, this test fails and says
// "promote it". A known gap that stops being a gap without anyone noticing is how a ledger
// rots.
//
// WHAT THE FIXTURE MUST CONTAIN is the other half, and the half that failed first. This
// gate ran green for its whole life over a fixture with no TPH pair, no `field.enum`, no
// `identity.secondary`, no `index.lookup`, no callable source, no `@schema`, no `@isArray`
// and no abstract base. Every one of those shapes is handled on its own code path, so the
// green meant "the paths we happened to model are clean", which is a much smaller claim
// than the one the gate's name makes. A gate is only ever as wide as its fixture, so treat
// the model below as the load-bearing part of this file and add to it whenever a generator
// grows a new path.
//
// A fixture is PER-PORT; this one is derived from what the C# names artifact actually
// emits, not copied from the TS one. C#'s member form is `Pascal(field) + "Column"` with only
// the first character upper-cased (`customerId` → `CustomerIdColumn`), so two fields that
// would collide under the JVM's snake-upper form do not collide here, and vice versa. Each
// ShouldUse below was read off the emitted `<Entity>Names.g.cs`, not guessed.
//
// ONE category is out of this method's reach, and it is worth naming rather than leaving a
// reader to assume otherwise: a RELATIONSHIP-SYNTHESIZED foreign-key column — the column a
// parent-side `relationship.composition @cardinality: many` contributes to the child's
// table when the child declares no field for it. That name is DERIVED (the relationship's
// short name + "Id", through the naming strategy), never declared, so there is no physical
// name to de-blind and nothing for a generator to restate. It is a different defect class —
// a name computed twice by two derivations — and `<Entity>Names` has no constant for it
// because it belongs to no field of any object.

using MetaObjects.Cli;
using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using System.Text.RegularExpressions;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class NoMagicPhysicalNamesTests
{
    /// <summary>
    /// How a physical name reaches generated output today.
    /// <para>The three non-<see cref="Constant"/> values are PINNED, not exempted: the gate
    /// asserts the literal is still there (or, for <see cref="Dropped"/>, still unread), so
    /// the day a generator starts referencing a constant instead, the pin fails and says
    /// "promote it". A known gap that stops being a gap without anyone noticing is how a
    /// ledger rots.</para>
    /// <para><see cref="KnownLiteral"/> and <see cref="Escape"/> are kept APART because they
    /// are not the same claim, and collapsing them is how a defect acquires the standing of a
    /// ruling. A KnownLiteral is STRUCTURAL — there is no constant to reference, and none
    /// should be expected. An Escape is a DEFECT — the constant exists, in an artifact this
    /// very run emits, and a generator spelled the name again anyway. Every Escape row is
    /// additionally required to have a reachable constant (see
    /// <see cref="Proves_every_escape_is_a_defect_and_not_a_structural_impossibility"/>), so no
    /// row can sit here claiming a fix is impossible when it is merely undone.</para>
    /// <para><see cref="Dropped"/> is the third failure mode and the one this gate was BLIND
    /// to until the fixture grew a shape that has one. An escape spells a name twice; a
    /// dropped name is spelled ZERO times — the artifact carries it, no generator reads it,
    /// and the binding silently takes a default instead. Every "does any file contain this
    /// literal" assertion passes for it, which is why the REFERENCE test is the load-bearing
    /// one and why a dropped name needs a row that pins its absence rather than merely
    /// tolerating it.</para>
    /// </summary>
    private enum Reach
    {
        /// <summary>Travels as a `<Entity>Names` reference, and appears literally nowhere else.</summary>
        Constant,
        /// <summary>STRUCTURAL: no constant exists and none should be expected. Pinned, not exempted.</summary>
        KnownLiteral,
        /// <summary>A DEFECT: the constant exists, in an artifact this same run emits, and a generator spelled the name again anyway.</summary>
        Escape,
        /// <summary>The artifact carries the name and NO generator reads it, so the binding silently takes a default. Spelled zero times.</summary>
        Dropped,
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

    // --- Shapes the original fixture did not contain -----------------------------------
    // Each block below exists because a generator handles it on a DIFFERENT code path from
    // the plain-entity one above, and a path no fixture reaches is a path this gate cannot
    // speak for.
    private const string TphTable = "zz_phys_tbl_veh";      // a TPH discriminator base's table
    private const string TphId = "zz_phys_col_vid";
    private const string TphDisc = "zz_phys_col_kind";      // the discriminator column
    private const string TphSubCol = "zz_phys_col_doors";   // a SUBTYPE's own column, folded into the base table
    private const string WidgetTable = "zz_phys_tbl_wid";   // the index/enum/schema entity's table
    private const string Schema = "zz_phys_sch_one";        // @schema on a source.rdb
    private const string EnumCol = "zz_phys_col_stat";      // a string-backed field.enum
    private const string EnumIntCol = "zz_phys_col_grad";   // an int-backed field.enum (@intValueMap)
    private const string ArrayCol = "zz_phys_col_tags";     // an @isArray scalar field
    private const string AltCol = "zz_phys_col_alt";        // the column an identity.secondary keys on
    private const string SecIndex = "zz_phys_idx_sec";      // an identity.secondary's own name
    private const string LkpIndex = "zz_phys_idx_lkp";      // an index.lookup's own name
    private const string AbsCol = "zz_phys_col_bid";        // a column declared on an ABSTRACT base
    private const string Proc = "zz_phys_proc_alpha";       // a storedProc source's physical name
    private const string ProcArgCol = "zz_phys_col_since";
    private const string ProcOutCol = "zz_phys_col_total";
    // A field.enum hosted ON the value object. The scalar VO members take the
    // `withAttributes: false` path; the enum member does not (EntityGenerator.cs, the VO
    // member loop — `EnumProperty(vo, field, ...)` with `withAttributes` left at its default
    // of true), so it is the one VO member that emits a [Column(...)] at all.
    private const string VoEnumCol = "zz_phys_col_mood";
    // An @isArray value-object column (OwnsMany ... ToJson). Its OWN entity, so that the
    // routes tier's post-save array-null clear — which builds a raw UPDATE from the table,
    // the json column and the PK column — lands its findings on tokens of its own rather
    // than demoting Customer's rows.
    private const string TaggerTable = "zz_phys_tbl_eps";   // NOT pluralize(snake("Tagger"))
    private const string TaggerId = "zz_phys_col_tkey";
    private const string LabelsCol = "zz_phys_col_lbls";

    /// <summary>
    /// Every de-blinded token, with the constant a generator should have referenced.
    /// <para>Not every declared name has a row. <see cref="SecIndex"/>, <see cref="LkpIndex"/>
    /// and <see cref="ProcArgCol"/> are declared in the model and listed nowhere here ON
    /// PURPOSE: this port emits nothing that carries them (C# emits no index DDL at all —
    /// schema is TS-owned, ADR-0015 — and the callable binds its arguments positionally),
    /// and the artifact has no slot for them, so none of the four reaches fits. They are
    /// still in the model so the exhaustive test convicts a generator that starts spelling
    /// one.</para>
    /// </summary>
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
            "constant to reference. DbContextGenerator.OwnedTypeConfig."),
        (WtView,     "(no constant exists)", Reach.KnownLiteral,
            "A write-through entity has TWO physical names; <Entity>Names carries the PRIMARY source's " +
            "only. The replica view name has no slot in the artifact's schema. DbContextGenerator, " +
            "the .ToView(...) for the <Entity>View read model."),

        // --- TPH: a discriminator base folds its subtypes' own columns into one table ------
        (TphTable,   "VehicleNames.Name",              Reach.Constant, ""),
        (TphId,      "VehicleNames.IdColumn",          Reach.Constant, ""),
        (TphDisc,    "VehicleNames.KindColumn",        Reach.Constant, ""),
        (TphSubCol,  "CarNames.DoorsColumn",           Reach.Constant, ""),

        // --- the enum / index / schema entity ---------------------------------------------
        (WidgetTable, "WidgetNames.Name",              Reach.Constant, ""),
        (EnumCol,     "WidgetNames.StatusColumn",      Reach.Constant, ""),
        (EnumIntCol,  "WidgetNames.GradeColumn",       Reach.Constant, ""),
        (ArrayCol,    "WidgetNames.TagsColumn",        Reach.Constant, ""),
        (AltCol,      "WidgetNames.AltColumn",         Reach.Constant, ""),
        (AbsCol,      "WidgetNames.IdColumn",          Reach.Constant, ""),
        (Schema,      "WidgetNames.Schema",            Reach.Dropped,
            "`@schema` reaches the names artifact (`public const string Schema`) and NO generator " +
            "reads it: EntityGenerator's [Table(...)] is CSharpNaming.NameRef → <Entity>Names.Name " +
            "with no schema argument, and nothing emits ToTable(name, schema) or HasDefaultSchema, so " +
            "the table lands in the connection's default schema. This is a BEHAVIOUR bug that happens " +
            "to show up here, not a naming nit — and it is pinned rather than merely absent so that " +
            "wiring @schema fails this row and says 'promote it' instead of passing unnoticed."),

        // --- the callable (stored procedure) ----------------------------------------------
        (Proc,        "ProcOutNames.Name",             Reach.Escape,
            "CallableGenerator spells `source.PhysicalName` directly — in the XML doc summary and " +
            "inside the FromSqlInterpolated SQL — with no CSharpNaming.NameRef lookup at all, while " +
            "ProcOutNames.Name exists in this same run. Note the emitted form matters: the name is " +
            "inside an interpolated-string SQL literal, so referencing the constant means composing " +
            "the SQL from it, not binding it as a parameter."),
        (ProcOutCol,  "ProcOutNames.TotalColumn",      Reach.Constant, ""),

        // --- a field.enum ON the value object ---------------------------------------------
        (VoEnumCol,   "(no constant exists)", Reach.KnownLiteral,
            "EntityGenerator.cs, the value-object member loop: the scalar arm calls ScalarProperty(..., " +
            "withAttributes: false) — \"VO POCO members carry NO EF-mapping attrs\" — but the enum arm " +
            "calls EnumProperty(vo, field, config, strategy) with `withAttributes` left at its default " +
            "of TRUE, so the VO enum member emits a [Column(...)] the scalar members correctly omit. " +
            "A value object has no source and so no <Vo>Names (FR-024 value purity), so ColumnRef " +
            "falls back to the bare literal. This is pinned as a KnownLiteral because no constant " +
            "exists to promote it to — but it is a DEFECT of a different kind: the attribute should " +
            "not be emitted at all. The fix is `withAttributes: false`, after which this literal " +
            "disappears and the exhaustive test fails this row and says 'delete it'. " +
            "Whether it is a BEHAVIOUR bug depends on the owner's @storage, and was measured " +
            "against EF Core 8 + Sqlite rather than assumed: on a jsonb owner (OwnsOne(...).ToJson) " +
            "EF ignores [Column] — the stored JSON keys off JsonPropertyName — so there it is dead " +
            "but misleading; on a FLATTENED owner (table-split OwnsOne) EF HONOURS it, and because " +
            "DbContextGenerator.OwnedTypeConfig fluent-names only ScalarFor(...) members (enum is " +
            "deliberately not one), the enum member's physical column becomes the UNPREFIXED " +
            "@column while migrate-ts (flattenObjectField) names it `<parent_col>_<member_col>`."),

        // --- an @isArray value-object column: the routes tier's raw-SQL null clear ---------
        (TaggerTable, "TaggerNames.Name",              Reach.Escape,
            "RoutesGenerator.AppendArrayNullClears builds `UPDATE \"<table>\" SET \"<json column>\" = " +
            "NULL WHERE \"<pk column>\" = {0}` from CSharpNaming.Table(entity) / Column(pkf) / " +
            "Column(f) — the raw resolvers, not NameRef/ColumnRef — so all three physical names are " +
            "spelled a second time inside a SQL string, while TaggerNames carries every one of them."),
        (TaggerId,    "TaggerNames.IdColumn",          Reach.Escape,
            "As TaggerTable — the PK column of the same UPDATE."),
        (LabelsCol,   "TaggerNames.LabelsColumn",      Reach.Escape,
            "As TaggerTable — the json column of the same UPDATE. The DbContext's OwnsMany(...).ToJson(" +
            "TaggerNames.LabelsColumn) DOES reference the constant; this is the second site."),
    ];

    // Placeholder substitution rather than raw-string interpolation: the fixture is JSON,
    // whose `}}` runs collide with an interpolation hole's closing delimiter.
    private static readonly string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "road", "@column": "__VO_MEMBER_COL__" } },
        { "field.enum":   { "name": "mood", "@column": "__VO_ENUM_COL__", "@values": ["CALM", "WILD"] } }
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
      { "object.entity": { "name": "AbstractKeyed", "abstract": true, "children": [
        { "field.long": { "name": "id", "@column": "__ABS_COL__" } }
      ]}},
      { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
        { "source.rdb": { "@table": "__TPH_TABLE__" } },
        { "field.long":   { "name": "id",   "@column": "__TPH_ID__" } },
        { "field.string": { "name": "kind", "@column": "__TPH_DISC__" } },
        { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "Car", "extends": "Vehicle", "@discriminatorValue": "Car", "children": [
        { "field.int": { "name": "doors", "@column": "__TPH_SUB_COL__" } }
      ]}},
      { "object.entity": { "name": "Widget", "extends": "AbstractKeyed", "children": [
        { "source.rdb": { "@table": "__WIDGET_TABLE__", "@schema": "__SCHEMA__" } },
        { "field.enum":   { "name": "status", "@column": "__ENUM_COL__", "@values": ["OPEN", "SHUT"] } },
        { "field.enum":   { "name": "grade",  "@column": "__ENUM_INT_COL__", "@values": ["LO", "HI"],
                            "@intValueMap": { "LO": 1, "HI": 2 } } },
        { "field.string": { "name": "tags", "isArray": true, "@column": "__ARRAY_COL__" } },
        { "field.string": { "name": "alt", "@column": "__ALT_COL__" } },
        { "identity.primary":   { "name": "pk", "@fields": "id", "@generation": "increment" } },
        { "identity.secondary": { "name": "__SEC_INDEX__", "@fields": ["alt"] } },
        { "index.lookup":       { "name": "__LKP_INDEX__", "@fields": ["status"] } }
      ]}},
      { "object.value": { "name": "ProcArgs", "children": [
        { "field.long": { "name": "since", "@column": "__PROC_ARG_COL__" } }
      ]}},
      { "object.projection": { "name": "ProcOut", "children": [
        { "source.rdb": { "@kind": "storedProc", "@proc": "__PROC__", "@parameterRef": "ProcArgs" } },
        { "field.long": { "name": "total", "@column": "__PROC_OUT_COL__" } }
      ]}},
      { "object.entity": { "name": "Tagger", "children": [
        { "source.rdb": { "@table": "__TAGGER_TABLE__" } },
        { "field.long":   { "name": "id", "@column": "__TAGGER_ID__" } },
        { "field.object": { "name": "labels", "@column": "__LABELS_COL__", "isArray": true,
                            "@objectRef": "Address", "@storage": "jsonb" } },
        { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
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
        .Replace("__VO_ENUM_COL__", VoEnumCol)
        .Replace("__VIEW__", View)
        .Replace("__ORDER_TABLE__", OrderTable)
        .Replace("__ORDER_ID__", OrderId)
        .Replace("__COL_FK__", ColFk)
        .Replace("__ABS_COL__", AbsCol)
        .Replace("__TPH_TABLE__", TphTable)
        .Replace("__TPH_ID__", TphId)
        .Replace("__TPH_DISC__", TphDisc)
        .Replace("__TPH_SUB_COL__", TphSubCol)
        .Replace("__WIDGET_TABLE__", WidgetTable)
        .Replace("__SCHEMA__", Schema)
        .Replace("__ENUM_COL__", EnumCol)
        .Replace("__ENUM_INT_COL__", EnumIntCol)
        .Replace("__ARRAY_COL__", ArrayCol)
        .Replace("__ALT_COL__", AltCol)
        .Replace("__SEC_INDEX__", SecIndex)
        .Replace("__LKP_INDEX__", LkpIndex)
        .Replace("__PROC__", Proc)
        .Replace("__PROC_ARG_COL__", ProcArgCol)
        .Replace("__PROC_OUT_COL__", ProcOutCol)
        .Replace("__TAGGER_TABLE__", TaggerTable)
        .Replace("__TAGGER_ID__", TaggerId)
        .Replace("__LABELS_COL__", LabelsCol)
        .Replace("__WT_TABLE__", WtTable)
        .Replace("__WT_VIEW__", WtView)
        .Replace("__WT_ID__", WtId);

    /// <summary>A names artifact is the ONE file allowed to spell a physical name literally.</summary>
    private static bool IsNamesArtifact(string path) => path.EndsWith("Names.g.cs", StringComparison.Ordinal);

    /// <summary>
    /// The DEFAULT generator suite — the one `dotnet meta gen` runs — plus <c>callable</c>.
    /// <c>callable</c> is opt-in (FR-015 niche) and so OUTSIDE the default set; a stored-proc
    /// shape in the model reaches no generator unless it is wired in, and an unreached
    /// generator is a gap this gate would otherwise be blind to, not a shape it covers.
    /// </summary>
    private static readonly IReadOnlyList<string> GeneratorNames =
        [.. GenCommand.DefaultGeneratorNames, "callable"];

    /// <summary>Run the generator suite over the fixture.</summary>
    private static IReadOnlyList<EmittedFile> Generate()
    {
        var result = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "no-magic.json")]);
        // A gate whose fixture the loader would reject proves nothing.
        Assert.True(result.Errors.Count == 0, string.Join("\n", result.Errors.Select(e => e.ToString())));

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
                IncludeNames = GeneratorRegistry.IncludesNames(GeneratorNames),
            },
        };
        return GeneratorRegistry.Resolve(GeneratorNames).SelectMany(g => g.Generate(ctx)).ToList();
    }

    private static string NamesBody(IEnumerable<EmittedFile> files) =>
        string.Join("\n", files.Where(f => IsNamesArtifact(f.Path)).Select(f => f.Content));

    private static string ConsumerBody(IEnumerable<EmittedFile> files) =>
        string.Join("\n", files.Where(f => !IsNamesArtifact(f.Path)).Select(f => f.Content));

    [Fact]
    public void Emits_a_names_artifact_carrying_every_de_blinded_physical_name()
    {
        var files = Generate();
        var names = files.Where(f => IsNamesArtifact(f.Path)).ToList();
        // Teeth: with no names artifact at all every assertion below passes vacuously.
        Assert.NotEmpty(names);
        var all = string.Join("\n", names.Select(f => f.Content));
        var missing = Tokens
            // A KnownLiteral has no constant by definition; every other reach claims one.
            .Where(t => t.Reach != Reach.KnownLiteral && !all.Contains(t.Literal, StringComparison.Ordinal))
            .Select(t => $"{t.Literal} appears in no names artifact — {t.ShouldUse} cannot exist")
            .OrderBy(s => s, StringComparer.Ordinal).ToList();
        Assert.True(missing.Count == 0, string.Join("\n", missing));
    }

    [Fact]
    public void References_the_constant_everywhere_else_no_generated_file_spells_one_literally()
    {
        // A declared literal can CONTAIN a constant's literal as a substring (a flattened
        // column is `<prefix>_<member>`), so scanning raw content would report the part a
        // second time for a restatement already booked against the composite. Mask the
        // declared literals first — longest FIRST, so a composite is removed whole before a
        // shorter literal inside it can dismantle it — and a residual hit is a standalone
        // restatement reported against exactly one row.
        var declaredLiterals = Tokens
            .Where(t => t.Reach is Reach.Escape or Reach.KnownLiteral)
            .Select(t => t.Literal)
            .OrderByDescending(l => l.Length).ThenBy(l => l, StringComparer.Ordinal)
            .ToList();
        string Masked(string content) =>
            declaredLiterals.Aggregate(content, (acc, lit) => acc.Replace(lit, string.Empty, StringComparison.Ordinal));

        var offenders = (from f in Generate()
                         where !IsNamesArtifact(f.Path)
                         let body = Masked(f.Content)
                         from t in Tokens
                         where t.Reach == Reach.Constant
                         where body.Contains(t.Literal, StringComparison.Ordinal)
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
        var body = ConsumerBody(Generate());
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
        // does a KnownLiteral or Escape quietly fixed: a "known gaps" list nothing re-checks
        // is how a ledger ends up describing a codebase that moved on.
        var escaped = Generate()
            .Where(f => !IsNamesArtifact(f.Path))
            .SelectMany(f => Regex.Matches(f.Content, @"zz_phys_\w+").Select(m => m.Value))
            .Distinct().OrderBy(s => s, StringComparer.Ordinal).ToList();
        var declared = Tokens.Where(t => t.Reach is Reach.KnownLiteral or Reach.Escape)
            .Select(t => t.Literal).Distinct().OrderBy(s => s, StringComparer.Ordinal).ToList();

        Assert.Equal(declared, escaped);
    }

    [Fact]
    public void Proves_every_escape_is_a_defect_and_not_a_structural_impossibility()
    {
        // The row type lets an author write Escape with a ShouldUse naming a constant that
        // does not exist — which would read as "we know about it" while being unfixable, the
        // most comfortable possible state for a defect to sit in. So: for every escape, the
        // constant it should have used must be REACHABLE — its owning names artifact emitted,
        // by this same run, carrying the literal. That turns each row into a claim that can
        // be acted on today, and it is what separates these rows from the KnownLiteral ones.
        var names = NamesBody(Generate());
        var unreachable = Tokens
            .Where(t => t.Reach == Reach.Escape)
            .Where(t => !names.Contains(t.Literal, StringComparison.Ordinal))
            .Select(t => $"{t.Literal} is marked an escape but {t.ShouldUse} is in no names artifact")
            .OrderBy(s => s, StringComparer.Ordinal).ToList();
        Assert.True(unreachable.Count == 0, string.Join("\n", unreachable));
    }

    [Fact]
    public void Pins_each_dropped_name_as_carried_but_unread_so_wiring_it_up_fails_this_row()
    {
        // The counterpart to the reference test, for the failure mode that test cannot
        // state. A Dropped row asserts BOTH halves of its own claim: the artifact carries
        // the name (so a consumer could read it) and no generated file references the
        // constant (so none does). Asserting the second half is the point — it is a pin on
        // a DEFECT, and the day a generator starts honouring the name this row fails and
        // demands promotion to Constant, rather than the fix landing with nothing to notice
        // it.
        var files = Generate();
        var names = NamesBody(files);
        var body = ConsumerBody(files);
        var wrong = Tokens.Where(t => t.Reach == Reach.Dropped).SelectMany(t => new[]
            {
                names.Contains(t.Literal, StringComparison.Ordinal)
                    ? null : $"{t.Literal} is marked dropped but no names artifact carries it",
                body.Contains(t.ShouldUse, StringComparison.Ordinal)
                    ? $"{t.ShouldUse} IS referenced now — promote \"{t.Literal}\" to Reach.Constant" : null,
            })
            .Where(s => s is not null)
            .OrderBy(s => s, StringComparer.Ordinal).ToList();
        Assert.True(wrong.Count == 0, string.Join("\n", wrong));
    }
}
