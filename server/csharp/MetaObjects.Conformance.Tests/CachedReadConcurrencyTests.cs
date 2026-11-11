using MetaObjects;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// A frozen tree is shared across threads (a host loads metadata once and serves every request
/// from it), so the first concurrent touch of a node's memoized reads must not corrupt its cache.
/// </summary>
public class CachedReadConcurrencyTests
{
    [Fact]
    public void Concurrent_first_reads_of_a_frozen_node_do_not_corrupt_its_cache()
    {
        for (var round = 0; round < 200; round++)
        {
            var entity = new MetaObject(new TypeId("object", "entity"), "Order");
            for (var i = 0; i < 40; i++)
            {
                var f = new MetaField(new TypeId("field", "string"), $"f{i}");
                f.AddChild(new MetaRequiredValidator(new TypeId("validator", "required"), "req"));
                entity.AddChild(f);
            }
            entity.Freeze();
            var fields = entity.OwnFields();

            using var start = new ManualResetEventSlim(false);
            var workers = Enumerable.Range(0, 8).Select(w => Task.Run(() =>
            {
                start.Wait();
                foreach (var f in fields)
                {
                    _ = f.Validators();
                    _ = f.ResolvedIsArray();
                    _ = f.OwnAttrs();
                    _ = f.IsRequired;
                }
                _ = entity.Fields();
            })).ToArray();
            start.Set();
            Task.WaitAll(workers);

            Assert.All(fields, f => Assert.Single(f.Validators()));
        }
    }
}
