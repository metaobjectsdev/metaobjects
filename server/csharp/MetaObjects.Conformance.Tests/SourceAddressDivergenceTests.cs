// Two `@role: primary` sources must agree on the object's physical ADDRESS — kind, schema
// AND physical name — not merely on the name.
//
// This closes a divergence between two doors that answered one question. `PrimaryRdbSource`
// compared the bare physical name, for `primary` only; the names artifact compared the whole
// resolved record for every role. So two primaries agreeing on `@table` and disagreeing on
// `@schema` loaded with ZERO errors, were ACCEPTED here, and were refused by the names
// generator — `dotnet meta gen` failing on a model every other door admitted.
//
// WHAT DECIDED IT is not the asymmetry but WHICH source the weaker key returned. The accepted
// answer was `primaries[0]`, and that is the INHERITED source in C#/TS/Python (Children()
// puts the super's entries first) and the OWN source on the JVM. So the model below bound
// "s1"."t" here and "s2"."t" on the JVM — one document, two verdicts depending on which
// toolchain read it, which is the defect 0.25.0 spent its breaking slot on.
//
// Named sources are what makes the shape reachable: effective-children shadowing matches an
// own child over a super child on a (Type, Name) pair, so two UNNAMED sources across an
// `extends` boundary collapse into one and there is nothing left to compare.
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SourceAddressDivergenceTests
{
    private const string SchemaOnlyDivergence = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Base", "abstract": true, "children": [
        { "field.long":  { "name": "id" } },
        { "source.rdb":  { "name": "a", "@table": "t", "@schema": "s1", "@role": "primary" } }
      ] } },
      { "object.entity": { "name": "Acct", "extends": "Base", "children": [
        { "source.rdb":       { "name": "b", "@table": "t", "@schema": "s2", "@role": "primary" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
      ] } }
    ] } }
    """;

    // An absent `@schema` is NOT the same address as an explicit one, and the reason is
    // dialect-shaped rather than pedantic. On Postgres absent and "public" address the same
    // relation (migrate normalizes the two). On SQLite/D1 they do not: the expected-schema
    // builder rejects ANY declared schema, "public" included, while an absent one is fine.
    // So the comparison stays RAW — normalizing to one dialect's default inside a
    // dialect-free tier would be wrong for the other.
    private const string AbsentVsExplicit = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Base", "abstract": true, "children": [
        { "field.long":  { "name": "id" } },
        { "source.rdb":  { "name": "a", "@table": "t", "@role": "primary" } }
      ] } },
      { "object.entity": { "name": "Acct", "extends": "Base", "children": [
        { "source.rdb":       { "name": "b", "@table": "t", "@schema": "public", "@role": "primary" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
      ] } }
    ] } }
    """;

    private static MetaObject Acct(string model, string id)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: id)]);
        // A guard test whose fixture the loader would reject proves nothing: the whole point
        // is that this shape is legal to the loader and refused at use.
        Assert.Empty(r.Errors);
        return r.Root.Objects().Single(o => o.Name == "Acct");
    }

    [Fact]
    public void PrimariesAgreeingOnNameButDisagreeingOnSchemaAreRefused()
    {
        var e = Assert.Throws<InvalidOperationException>(
            () => SourceResolution.PrimaryRdbSource(Acct(SchemaOnlyDivergence, "schema-divergence.json")));

        Assert.Contains("physical address", e.Message);
        // The ADDRESS, not the bare name: the names AGREE here, so a message quoting only
        // "t" would describe two identical things as different.
        Assert.Contains("\"s1\".\"t\"", e.Message);
        Assert.Contains("\"s2\".\"t\"", e.Message);
    }

    [Fact]
    public void AbsentSchemaIsNotTheSameAddressAsAnExplicitOne()
    {
        var e = Assert.Throws<InvalidOperationException>(
            () => SourceResolution.PrimaryRdbSource(Acct(AbsentVsExplicit, "absent-vs-public.json")));

        Assert.Contains("physical address", e.Message);
    }

    [Fact]
    public void TwoPrimariesAgreeingOnTheWholeAddressStayLegal()
    {
        const string agreeing = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Base", "abstract": true, "children": [
            { "field.long":  { "name": "id" } },
            { "source.rdb":  { "name": "a", "@table": "t", "@schema": "s1", "@role": "primary" } }
          ] } },
          { "object.entity": { "name": "Acct", "extends": "Base", "children": [
            { "source.rdb":       { "name": "b", "@table": "t", "@schema": "s1", "@role": "primary" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
          ] } }
        ] } }
        """;

        // The invariant is that an object has ONE address, not that it declares one source.
        // Without this case the refusal could tighten into "two primaries are illegal" and
        // nothing would notice.
        var src = SourceResolution.PrimaryRdbSource(Acct(agreeing, "agreeing.json"));
        Assert.NotNull(src);
        Assert.Equal("t", src!.PhysicalName);
    }
}
