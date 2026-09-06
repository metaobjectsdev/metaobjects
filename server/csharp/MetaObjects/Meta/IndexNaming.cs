// IndexNaming — THE database name of an `identity.secondary` / `index.lookup`.
//
// Ported alongside typescript/packages/metadata/src/naming.ts (resolveIndexName), which
// this mirrors rule for rule.

namespace MetaObjects.Meta;

/// <summary>
/// An index's DATABASE name — for an <c>identity.secondary</c> (a unique alternate key) or
/// an <c>index.lookup</c> (a non-unique retrieval index).
///
/// <para>These nodes carry no <c>@column</c>-style physical spelling: the database name IS
/// the metamodel <c>name</c>. That is precisely why the answer must live in a function
/// rather than at each call site. In the TypeScript port it was spelled independently in
/// three places — the Drizzle emitter and migrate's expected-schema twice — and agreed only
/// by coincidence; <c>fdb4118f1</c> is what that coincidence lapsing looks like, with
/// codegen declaring <c>idx_&lt;table&gt;_&lt;col&gt;</c> while the index in the database
/// was <c>identity.name</c>.</para>
///
/// <para>This port has exactly ONE caller today — the <c>&lt;Entity&gt;Names</c> artifact —
/// because C# emits no index DDL at all (schema is TS-owned, ADR-0015). It is still a
/// shared door rather than an inline expression, for the reason the TS port learned the
/// hard way: the second caller is the one that disagrees, and it arrives without
/// announcing itself.</para>
///
/// <para>Two rules the door owns, neither of which a call site had:</para>
/// <list type="bullet">
///   <item><b>Package qualifier stripped.</b> The JVM loader spells a nested index name
///   package-qualified (<c>acme::demo::by_name</c>) where TypeScript and this port do not.
///   Doing it here makes the ports' answer one rule instead of several habits. A no-op on
///   input this port produces, which is the point.</item>
///   <item><b>An empty name is REFUSED</b>, and the gap it closes is exactly one node type
///   wide. An <c>identity.secondary</c> with an empty name is already refused by the LOADER
///   in strict and lax mode alike (identity nodes carry an FR-024 name check so a dotted
///   <c>extends</c> ref can address them). An <c>index.lookup</c> is not addressable that
///   way and carries no such check, so <c>{"index.lookup": {"name": ""}}</c> loads with zero
///   errors in both modes and reaches the emitters. Refusing at the shared door keeps this
///   out of the byte-gated registry <c>rules</c> prose a loader-side fix would need — no
///   <c>metamodelVersion</c> move, no five-port manifest change, for a defect that has
///   one.</item>
/// </list>
/// </summary>
public static class IndexNaming
{
    /// <summary>
    /// The database name of <paramref name="node"/> — an <c>identity.secondary</c> or an
    /// <c>index.lookup</c>. Throws when the name is empty (see the type summary).
    /// </summary>
    public static string ResolveIndexName(MetaData node)
    {
        var name = node.Name;
        var sep = name.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        var shortName = sep < 0 ? name : name[(sep + PACKAGE_SEPARATOR.Length)..];
        if (shortName.Length == 0)
            throw new InvalidOperationException(
                $"{node.Type}.{node.SubType} declares an empty name; an index's database name IS " +
                "its metamodel name, so there is nothing to emit. Give it a name.");
        return shortName;
    }
}
