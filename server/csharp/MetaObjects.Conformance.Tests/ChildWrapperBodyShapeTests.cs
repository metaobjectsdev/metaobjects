using System.Linq;
using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// A child wrapper's BODY must be an object, and an unregistered child key is an unknown
/// TYPE rather than a missing subType.
/// <para>
/// The conformance corpus runs the loader STRICT, so
/// <c>fixtures/conformance/error-child-not-object</c> and
/// <c>.../error-unknown-bare-child-type</c> prove the rule only on that path. Lax is the path
/// that matters for the defect these fixtures were written for: under the old code a
/// non-object child body was a WARNING here, so the child was dropped and the load succeeded
/// — a declared field simply not there, and generated output missing its column.
/// </para>
/// <para>
/// Gated here rather than left to the corpus so a future refactor cannot quietly re-gate the
/// rule on strict and keep every fixture green.
/// </para>
/// </summary>
public class ChildWrapperBodyShapeTests
{
    private static LoadResult Load(string child, bool strict)
    {
        var json = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [ "
            + "{ \"object.entity\": { \"name\": \"Account\", \"children\": [ "
            + "  { \"field.long\": { \"name\": \"id\" } }, "
            + child + ", "
            + "  { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"id\"] } } "
            + "] } } ] } }";
        var loader = new MetaDataLoader(
            Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]), strict: strict);
        return loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "t.json"),
        });
    }

    public static TheoryData<bool> Modes => new() { true, false };

    // --- the body ---

    [Theory]
    [MemberData(nameof(Modes))]
    public void A_registered_type_with_a_non_object_body_is_refused(bool strict)
    {
        foreach (var body in new[] { "\"label\"", "[\"label\"]", "null", "7", "true" })
        {
            var result = Load($"{{ \"field.string\": {body} }}", strict);
            Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_CHILD_NOT_OBJECT);
        }
    }

    /// <summary>
    /// The key is judged BEFORE the body. <c>$comment</c> is not a node, so telling the
    /// author to give it a node body would send them to wrap prose that was never a node.
    /// </summary>
    [Theory]
    [MemberData(nameof(Modes))]
    public void An_unknown_key_with_a_non_object_body_is_an_unknown_type(bool strict)
    {
        var result = Load("{ \"$comment\": \"prose\" }", strict);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_TYPE);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_CHILD_NOT_OBJECT);
    }

    [Fact]
    public void The_refused_child_is_absent_and_its_valid_siblings_are_present()
    {
        var result = Load("{ \"field.string\": \"label\" }", strict: false);
        var entity = result.Root.Children().Single(c => c.Name == "Account");
        var names = entity.Children().Select(c => c.Name).ToList();
        Assert.Contains("id", names);
        Assert.DoesNotContain("label", names);
    }

    /// <summary>
    /// The ATTR door is a separate branch, so the rule needs asserting on it separately.
    /// Python's is a separate FUNCTION, and fixing only the structural door left it
    /// answering ERR_MISSING_REQUIRED_ATTR — the consequence of coercing the body to an
    /// empty map, not the cause.
    /// </summary>
    [Theory]
    [MemberData(nameof(Modes))]
    public void An_attr_child_with_a_non_object_body_is_refused(bool strict)
    {
        var result = Load(
            "{ \"field.string\": { \"name\": \"s\", \"children\": [ "
            + "{ \"attr.string\": \"a note\" } ] } }", strict);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_CHILD_NOT_OBJECT);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_MISSING_REQUIRED_ATTR);
    }

    // --- the key ---

    /// <summary>
    /// The root door has carried the registration-first guard; the child door did not, so
    /// <c>madeup</c> was answered with "write the full <c>madeup.&lt;subType&gt;</c>" —
    /// advice about a type that does not exist.
    /// </summary>
    [Theory]
    [MemberData(nameof(Modes))]
    public void An_unregistered_bare_child_key_is_an_unknown_type(bool strict)
    {
        var result = Load("{ \"madeup\": { \"name\": \"label\" } }", strict);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_TYPE);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_MISSING_SUBTYPE);
    }

    /// <summary>
    /// The control the guard must not swallow: <c>identity</c> IS registered and declares no
    /// default subType, so it keeps ERR_MISSING_SUBTYPE — that advice is correct for it.
    /// </summary>
    [Fact]
    public void A_registered_type_with_no_declared_default_still_reports_missing_subtype()
    {
        var result = Load("{ \"identity\": { \"name\": \"alt\" } }", strict: false);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_MISSING_SUBTYPE);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_TYPE);
    }

    [Fact]
    public void The_unknown_type_error_names_the_type_without_a_trailing_dot()
    {
        var result = Load("{ \"madeup\": { \"name\": \"label\" } }", strict: false);
        var err = result.Errors.First(e => e.Code == ErrorCode.ERR_UNKNOWN_TYPE);
        Assert.Contains("\"madeup\"", err.Message);
        Assert.DoesNotContain("\"madeup.\"", err.Message);
    }
}
