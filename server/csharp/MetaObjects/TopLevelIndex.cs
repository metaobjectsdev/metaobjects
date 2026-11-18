// A per-node lookup index over a root's direct children (the top-level nodes).
//
// Reference resolution, `extends` resolution and overlay targeting all ask "which top-level node
// has this key?" once per reference. Answering by scanning the child list and building each
// candidate's key is O(N) per question and O(N^2) per model; this answers from a dictionary.
//
// Semantics are those of the scans it replaces: the FIRST match in child order wins.
//
// Never stale. An index is valid for one StructureEpoch of the root (MetaData.cs), which every
// non-append change to the child list and every change to a package feeding a resolution key
// bumps. A pure append is picked up by scanning only the new tail (the first match still wins,
// since later children only add keys), so a loop that interleaves adds and lookups stays linear.
// Only a parentless node without a super is indexed (a loader root); anything else takes the
// original scan. A frozen tree is shared across threads, so the build and the read are locked.

using MetaObjects.Meta;

namespace MetaObjects;

/// <summary>What a lookup indexes: which children count and how a child is keyed.</summary>
internal sealed class TopLevelView(string id, Func<MetaData, bool> includes, Func<MetaData, string> keyOf)
{
    public string Id { get; } = id;
    public Func<MetaData, bool> Includes { get; } = includes;
    public Func<MetaData, string> KeyOf { get; } = keyOf;
}

/// <summary>The indexes built over one node's children, by view id. Also the lock for them.</summary>
internal sealed class TopLevelIndexes
{
    internal sealed class Index(int epoch)
    {
        public readonly Dictionary<string, MetaData> ByKey = new();
        public int Scanned;
        public int Epoch = epoch;
    }

    public readonly Dictionary<string, Index> ByView = new();
}

internal static class TopLevelIndex
{
    // Per thread, so tests that load models in parallel cannot disturb each other's count.
    [ThreadStatic] private static int _rebuilds;

    /// <summary>Observable for tests: how many indexes this thread (re)built from scratch.</summary>
    internal static int Rebuilds => _rebuilds;

    /// <summary>
    /// The first child of <paramref name="root"/> that <paramref name="view"/> includes whose key is
    /// <paramref name="key"/>, in child order. <paramref name="linear"/> is the original scan, used
    /// when <paramref name="root"/> is not indexable.
    /// </summary>
    internal static MetaData? FindByKey(MetaData root, TopLevelView view, string key, Func<MetaData?> linear)
    {
        if (root.Parent is not null || root.SuperData is not null) return linear();

        TopLevelIndexes holder = root.GetTopLevelIndexes();
        lock (holder)
        {
            if (!holder.ByView.TryGetValue(view.Id, out var index)
                || index.Epoch != root.StructureEpoch
                || index.Scanned > root.OwnChildCount)
            {
                index = new TopLevelIndexes.Index(root.StructureEpoch);
                holder.ByView[view.Id] = index;
                _rebuilds++;
            }
            int count = root.OwnChildCount;
            for (int i = index.Scanned; i < count; i++)
            {
                MetaData child = root.OwnChildAt(i);
                if (view.Includes(child)) index.ByKey.TryAdd(view.KeyOf(child), child);
            }
            index.Scanned = count;
            return index.ByKey.GetValueOrDefault(key);
        }
    }
}
