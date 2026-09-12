using MetaObjects;
using MetaObjects.Meta;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

// ADR-0055 — overlay application is a deferred pass.
//
// The cross-port behaviour (order independence, G1/G2 ordering, the resolved
// error envelope) is gated by the shared corpus. These unit tests cover the two
// things the corpus CANNOT reach from a fixture directory:
//
//   1. JsonElement lifetime. ParseJson disposes the JsonDocument as soon as
//      BuildTree returns, but a queued overlay is applied later — by the loader,
//      long after that. If the queue held a view into the disposed document
//      instead of a detached Clone(), applying it would throw
//      ObjectDisposedException. A fixture cannot exercise this, because the
//      loader's own drain happens inside one call; only holding the queue across
//      the dispose boundary by hand does.
//   2. That the parser hands the queue OUT rather than draining it, when the
//      caller asked to defer.
public class DeferredOverlayTests
{
    private static TypeRegistry Reg() => Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]);

    private const string BaseJson = """
    { "metadata.root": { "package": "acme", "children": [
        { "object.entity": { "name": "Widget", "children": [
            { "field.string": { "name": "id" } } ] } } ] } }
    """;

    // A MIXED document: one plain declaration plus an overlay of a node declared
    // in the other document — the shape the retired #160 partition could not move.
    private const string MixedJson = """
    { "metadata.root": { "package": "acme", "children": [
        { "object.entity": { "name": "Gadget", "children": [
            { "field.string": { "name": "gid" } } ] } },
        { "object.entity": { "name": "Widget", "overlay": true, "children": [
            { "field.string": { "name": "extra" } } ] } } ] } }
    """;

    [Fact]
    public void Deferring_hands_the_queue_out_instead_of_draining_it()
    {
        var result = Parser.ParseJson(
            MixedJson,
            new ParseOptions(Reg()) { DeferSuperResolution = true, DeferOverlays = true });

        // The overlay was queued, not applied and not failed.
        Assert.Empty(result.Errors);
        Assert.NotNull(result.PendingOverlays);
        PendingOverlay pending = Assert.Single(result.PendingOverlays!);
        Assert.Equal("object", pending.Type);
        Assert.Equal("Widget", pending.Name);
        // The plain sibling in the same document DID land.
        Assert.NotNull(result.Root.OwnChildByName("Gadget"));
        // Nothing was created for the overlay itself.
        Assert.Null(result.Root.OwnChildByName("Widget"));
    }

    [Fact]
    public void A_queued_overlay_applies_after_its_parse_document_is_disposed()
    {
        TypeRegistry registry = Reg();

        // Parse the base first so the accumulating root owns Widget.
        var baseResult = Parser.ParseJson(
            BaseJson,
            new ParseOptions(registry) { DeferSuperResolution = true, DeferOverlays = true });
        Assert.Empty(baseResult.Errors);
        MetaRoot root = baseResult.Root;

        // Parse the MIXED document into that root, deferring. ParseJson disposes its
        // JsonDocument before returning — so by the time we reach the next line, the
        // document backing this queue is gone.
        var mixedResult = Parser.ParseJson(
            MixedJson,
            new ParseOptions(registry)
            {
                DeferSuperResolution = true,
                DeferOverlays = true,
                IntoRoot = root,
            });
        Assert.Empty(mixedResult.Errors);
        PendingOverlay pending = Assert.Single(mixedResult.PendingOverlays!);

        // Apply it now. This is the assertion that fails with ObjectDisposedException
        // if the queue ever stops detaching the element.
        var applied = Parser.ApplyPendingOverlays([pending], registry, strict: false);

        Assert.Empty(applied.Errors);
        MetaData widget = root.OwnChildByName("Widget")!;
        Assert.Equal(["id", "extra"], widget.OwnChildren().Select(c => c.Name).ToArray());
    }

    [Fact]
    public void A_queued_overlay_with_no_target_reports_a_resolved_envelope_and_keeps_its_siblings()
    {
        TypeRegistry registry = Reg();

        // No base for Widget, ever.
        var result = Parser.ParseJson(
            MixedJson,
            new ParseOptions(registry) { DeferSuperResolution = true, DeferOverlays = true });
        PendingOverlay pending = Assert.Single(result.PendingOverlays!);

        var applied = Parser.ApplyPendingOverlays([pending], registry, strict: false);

        MetaError err = Assert.Single(applied.Errors);
        Assert.Equal(ErrorCode.ERR_OVERLAY_NO_TARGET, err.Code);
        // ADR-0009 FR5d — a reference that did not resolve.
        var resolved = Assert.IsType<ResolvedSource>(err.Envelope);
        Assert.Equal("acme::Widget", resolved.Referrer);
        Assert.Equal("object:Widget", resolved.Target);
        // The eager throw abandoned the whole source; the deferred pass does not.
        Assert.NotNull(result.Root.OwnChildByName("Gadget"));
    }
}
