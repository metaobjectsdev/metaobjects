// FR-033 — strict-load structural-child placement enforcement parity.
//
// Mirrors the TS reference (attr-schema-validate.ts Check 0b), Python's Check 0b
// (validation_passes.py) and Java's StrictChildPlacementTest: under strict load a
// STRUCTURAL child (field/identity/source/validator/… — not an attr) that the
// parent's registered childRules do not admit is ERR_CHILD_NOT_ALLOWED — the
// structural analogue of ERR_UNKNOWN_ATTR. Misplaced ATTRS keep the
// ERR_UNKNOWN_ATTR path. In lax mode the check is a no-op.
//
// The strict model (FR-033 S-B2) registers:
//   - object.projection children = field / identity / validator / layout / source
//     (NO relationship — derivation is expressed via @via).
//   - validator.required children = attr only (an attr-only node; no structural
//     children).

using MetaObjects.Loader;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class StrictChildPlacementTests
{
    private static LoadResult LoadStrict(string json)
    {
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var loader = new MetaDataLoader(registry, strict: true);
        return loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "meta.test.json"),
        });
    }

    private static LoadResult LoadLax(string json)
    {
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var loader = new MetaDataLoader(registry, strict: false);
        return loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "meta.test.json"),
        });
    }

    // Case 1: a relationship.association under an object.projection. The strict
    // projection child rules admit field/identity/validator/layout/source but NOT
    // relationship -> ERR_CHILD_NOT_ALLOWED.
    [Fact]
    public void Relationship_under_projection_is_rejected_strict()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme",
            "children": [
              { "object.projection": {
                  "name": "ProgramSummary",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.association": {
                        "name": "owner",
                        "@cardinality": "one",
                        "@objectRef": "Program" } }
                  ] } }
            ] } }
        """;

        var result = LoadStrict(json);

        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_CHILD_NOT_ALLOWED);
    }

    // Case 2: a field under an attr-only validator.required. The strict
    // validator.required child rules admit attr.* only (no structural children) ->
    // ERR_CHILD_NOT_ALLOWED for the misplaced field.
    [Fact]
    public void Field_under_required_validator_is_rejected_strict()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme",
            "children": [
              { "object.entity": {
                  "name": "Subscriber",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": ["id"] } },
                    { "field.string": {
                        "name": "email",
                        "children": [
                          { "validator.required": {
                              "name": "req",
                              "children": [
                                { "field.string": { "name": "bogus" } }
                              ] } }
                        ] } }
                  ] } }
            ] } }
        """;

        var result = LoadStrict(json);

        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_CHILD_NOT_ALLOWED);
    }

    // Lax (the default) keeps the legacy open child policy — a misplaced structural
    // child raises NO ERR_CHILD_NOT_ALLOWED. The check is strict-load only.
    [Fact]
    public void Misplaced_child_is_noop_under_lax()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme",
            "children": [
              { "object.projection": {
                  "name": "ProgramSummary",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.association": {
                        "name": "owner",
                        "@cardinality": "one",
                        "@objectRef": "Program" } }
                  ] } }
            ] } }
        """;

        var result = LoadLax(json);

        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_CHILD_NOT_ALLOWED);
    }
}
