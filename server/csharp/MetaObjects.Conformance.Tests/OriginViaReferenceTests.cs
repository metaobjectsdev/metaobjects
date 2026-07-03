// OriginViaReferenceTests — FR-024 @via-over-a-reference-only-FK unit tests.
//
// Mirrors the TS/Python reference-hop tests:
//   server/python/tests/unit/test_validation_origin_paths.py
//     (_build_reference_via_tree / test_valid_passthrough_via_reference_no_error /
//      test_invalid_passthrough_via_bad_reference)
//
// FR-024: a projection passthrough's @via path may name an identity.reference
// (a forward-FK, no relationship) as a navigable many-to-one hop. The reference
// IS the FK, so naming it navigates its edge without a redundant relationship.*.

using System.Linq;
using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class OriginViaReferenceTests
{
    private static MetaObject Obj(string subType, string name) => new(new TypeId(TYPE_OBJECT, subType), name);
    private static MetaField Fld(string subType, string name) => new(new TypeId(TYPE_FIELD, subType), name);

    /// Build a tree whose projection passthrough joins via an identity.reference
    /// (a reference-only FK, no relationship) — FR-024 @via-over-reference.
    ///   - Program (id, title)
    ///   - Enrollment (id, programId, identity.reference ref_program → Program)
    ///   - EnrollmentView (extends Enrollment) passthrough Program.title @via <via>
    private static MetaRoot BuildReferenceViaTree(string via)
    {
        var root = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");

        var program = Obj(OBJECT_SUBTYPE_ENTITY, "Program");
        program.AddChild(Fld("long", "id"));
        program.AddChild(Fld("string", "title"));
        root.AddChild(program);

        var enrollment = Obj(OBJECT_SUBTYPE_ENTITY, "Enrollment");
        enrollment.AddChild(Fld("long", "id"));
        enrollment.AddChild(Fld("long", "programId"));
        var reference = new MetaIdentity(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_REFERENCE), "ref_program");
        reference.SetAttr(IDENTITY_ATTR_FIELDS, "programId");
        reference.SetAttr(IDENTITY_REFERENCE_ATTR_REFERENCES, "Program");
        enrollment.AddChild(reference);
        root.AddChild(enrollment);

        var view = Obj(OBJECT_SUBTYPE_ENTITY, "EnrollmentView");
        view.SetSuper("Enrollment");
        view.SetSuperResolved(enrollment);
        var field = Fld("string", "program_title");
        var origin = new MetaPassthroughOrigin(new TypeId(TYPE_ORIGIN, ORIGIN_SUBTYPE_PASSTHROUGH), "");
        origin.SetAttr(ORIGIN_PASSTHROUGH_ATTR_FROM, "Program.title");
        origin.SetAttr(ORIGIN_PASSTHROUGH_ATTR_VIA, via);
        field.AddChild(origin);
        view.AddChild(field);
        root.AddChild(view);

        return root;
    }

    /// ERR_INVALID_ORIGIN messages that mention the @via path (ignores other passes).
    private static string[] ViaErrors(MetaData root)
        => ValidationPasses.ValidateOriginPaths(root)
            .Where(e => e.Code == ErrorCode.ERR_INVALID_ORIGIN && e.Message.Contains("@via"))
            .Select(e => e.Message)
            .ToArray();

    [Fact]
    public void Passthrough_via_reference_only_fk_is_accepted()
    {
        // @via naming an identity.reference (reference-only FK) resolves — no origin error.
        var root = BuildReferenceViaTree(via: "Enrollment.ref_program");
        Assert.Empty(ViaErrors(root));
    }

    [Fact]
    public void Passthrough_via_bogus_segment_yields_no_relationship_or_reference_error()
    {
        // @via naming neither a relationship nor a reference → ERR_INVALID_ORIGIN
        // with the "no such relationship or reference" phrasing (FR-024).
        var root = BuildReferenceViaTree(via: "Enrollment.bogus");
        var msgs = ViaErrors(root);
        Assert.Contains(msgs, m => m.Contains("bogus") && m.Contains("no such relationship or reference"));
    }
}
