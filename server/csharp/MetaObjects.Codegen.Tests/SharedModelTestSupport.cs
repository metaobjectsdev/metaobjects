// The shared-model generator publishes the metadata files its options name, so unlike every other
// generator it cannot run bare over a loaded corpus. The suites that run every registered generator (the eject
// parity ones) configure it here, through its public properties, so the same code serves the packaged type and
// an owned copy compiled from its source.
namespace MetaObjects.Codegen.Tests;

internal static class SharedModelTestSupport
{
    internal const string Name = "shared-model";

    /// <summary>Set the options of the corpus case <c>publishes-the-pinned-acme-common-artifact</c> on
    /// <paramref name="generator"/> when it is the shared-model generator (packaged or owned); any other is untouched.</summary>
    internal static IGenerator Configure(IGenerator generator)
    {
        if (generator.Name != Name) return generator;
        var corpus = Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "shared-model-conformance");
        void Set(string property, object value) =>
            generator.GetType().GetProperty(property)!.SetValue(generator, value);
        Set("ModelName", "acme-common");
        Set("Include", new[] { "acme::common::**" });
        Set("Exclude", new[] { "acme::common::Secret" });
        Set("Files", new[] { Path.Combine(corpus, "source/meta.base.json"), Path.Combine(corpus, "source/meta.customer.json") });
        Set("Version", "1.0.0");
        return generator;
    }
}
