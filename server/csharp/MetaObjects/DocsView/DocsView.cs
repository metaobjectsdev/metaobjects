// DocsView — the docs view of a loaded model: one port-neutral document, the facts every
// documentation page reads, and what the model explorer draws (docs/features/docs-view.md).
//
// The C# port of TypeScript's buildDocsView (@metaobjectsdev/metadata, src/docs-view/build.ts),
// held to the same bytes by fixtures/explorer-conformance/. It reads the model the loader built
// and resolved, and re-derives none of it:
//
//   ids and pages   from the effective tree (Children()), walked once in declaration order;
//   inheritance     an effective child whose Parent is another node is inherited, and that
//                   parent is where it is declared;
//   references      the loader's own resolution (ResolvedTargetOf / ResolvedTargetsOf on every
//                   attribute it treats as a reference, SuperData for extends);
//   claims          @implementedBy, through the resolver the requirement gate uses.
//
// Three optional inputs add what the model does not hold, each as parsed JSON and each left out
// when null or malformed: the `verify --format json` payload, the generation manifest
// (path -> { generatedBy, sourceNode }) and the routes ([{ node, method, path }]).
//
// DETERMINISTIC: the same inputs give the same bytes (Serialize).

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.Core.Requirement;
using MetaObjects.Meta;

namespace MetaObjects;

/// <summary>The docs view of a loaded model (<c>docs/features/docs-view.md</c>).</summary>
public static class DocsView
{
    /// <summary>Bumped when a field changes meaning or is removed.</summary>
    public const string Format = "metaobjects-docs-view/1";

    private const string ExtendsAttr = "extends";
    private const string Nul = "\u0000";

    /// <summary>The file's bytes: two-space JSON and one trailing newline.</summary>
    public static string Serialize(JsonObject view) => DocsViewJson.Pretty(view) + "\n";

    /// <summary>
    /// Build the docs view. <paramref name="verify"/>, <paramref name="manifest"/> and
    /// <paramref name="routes"/> are optional; a malformed one only leaves its part out.
    /// </summary>
    public static JsonObject Build(MetaData root, JsonNode? verify = null, JsonNode? manifest = null, JsonNode? routes = null) =>
        (JsonObject)ToNode(new Builder(root).Run(Element(verify), Element(manifest), Element(routes)))!;

    private static JsonElement? Element(JsonNode? n) =>
        n is null ? null : JsonDocument.Parse(n.ToJsonString()).RootElement.Clone();

    // ------------------------------------------------------------------
    // the ordered value model the builder writes (converted once at the end, so one object may
    // appear in several places, as it does in TypeScript)
    // ------------------------------------------------------------------

    private sealed class J
    {
        public readonly List<KeyValuePair<string, object?>> Props = [];

        public J Set(string key, object? value)
        {
            int i = Props.FindIndex(p => p.Key == key);
            if (i >= 0) Props[i] = new(key, value);
            else Props.Add(new(key, value));
            return this;
        }

        public object? Get(string key) => Props.First(p => p.Key == key).Value;
        public string Str(string key) => (string)Get(key)!;
    }

    private static JsonNode? ToNode(object? v) => v switch
    {
        null => null,
        J j => ToObject(j),
        string s => JsonValue.Create(s),
        bool b => JsonValue.Create(b),
        int i => JsonValue.Create((long)i),
        long l => JsonValue.Create(l),
        double d => JsonValue.Create(d),
        JsonElement e => JsonNode.Parse(e.GetRawText()),
        System.Collections.IEnumerable list => new JsonArray(list.Cast<object?>().Select(ToNode).ToArray()),
        _ => JsonValue.Create(v.ToString()),
    };

    private static JsonObject ToObject(J j)
    {
        var o = new JsonObject();
        foreach (var (k, v) in j.Props) o.Add(k, ToNode(v));
        return o;
    }

    // ------------------------------------------------------------------
    // the walk
    // ------------------------------------------------------------------

    /// <summary>A node as walked: where it sits, and the ids and pages it gets.</summary>
    private sealed class Walked
    {
        public required MetaData Md;
        public required string Id;
        /// <summary>The id before any type qualifier: what a dotted reference spells.</summary>
        public required string Plain;
        public Walked Top = null!;
        public Walked? Parent;
        /// <summary>The direct member of Top it sits in (itself, for a direct member); null at the top.</summary>
        public Walked? Direct;
        /// <summary>The nearest requirement at or above it.</summary>
        public Walked? Requirement;
        public int Order;
        /// <summary>On the walk path that physically holds the node: the one place a reference to it resolves to.</summary>
        public bool Canonical;
        /// <summary>The node that declares it, when it is inherited through extends.</summary>
        public MetaData? DeclaredOn;
        public string Anchor = "";
        public string Path = "";
        public readonly List<Walked> Children = [];
        /// <summary>Requirement address (dotted requirement names), set on requirements.</summary>
        public string Address = "";
    }

    private sealed record Ledger(
        string QualifiedPath, string Digest, string Verdict, List<object?> Diagnostics,
        bool HasSup, string SupRef, bool SupResolves, string SupTarget);

    private sealed class Builder
    {
        private readonly MetaData _root;
        private readonly List<Walked> _walked = [];
        private readonly List<Walked> _tops = [];
        private readonly Dictionary<string, Walked> _byId = new(StringComparer.Ordinal);
        private readonly Dictionary<MetaData, Walked> _canonical = new(ReferenceEqualityComparer.Instance);
        /// <summary>Plain path -> walked node: the first holder of a plain path under a top-level node that holds its plain id.</summary>
        private readonly Dictionary<string, Walked> _byPlain = new(StringComparer.Ordinal);
        private readonly List<Walked> _requirements = [];

        public Builder(MetaData root)
        {
            _root = root;
            Walk();
        }

        private static string PlainOf(MetaData md)
        {
            string pkg = NamingRefs.EffectivePackageOf(md);
            return pkg.Length == 0 ? md.Name : pkg + PACKAGE_SEPARATOR + md.Name;
        }

        private void Walk()
        {
            var topLevel = _root.Children();
            // Top-level nodes of different types may share a package and a name (an entity `Lead` and
            // an application's page `Lead`). The object keeps the plain id, since every reference in
            // the model names an object, else the first declared; each other one is qualified by type.
            var holder = new Dictionary<string, MetaData>(StringComparer.Ordinal);
            foreach (var md in topLevel)
            {
                string id = PlainOf(md);
                if (!holder.TryGetValue(id, out var held) || (held.Type != TYPE_OBJECT && md.Type == TYPE_OBJECT)) holder[id] = md;
            }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < topLevel.Count; i++) Visit(topLevel[i], i, null, "", holder, seen);
            foreach (var w in _walked) w.Path = PathOf(w);
        }

        private void Visit(MetaData md, int index, Walked? parent, string reqPrefix,
            Dictionary<string, MetaData> holder, HashSet<string> seen)
        {
            string id;
            string plain;
            if (parent is null)
            {
                plain = md.Name.Length == 0 ? $"#{index}" : PlainOf(md);
                id = plain;
                holder.TryGetValue(plain, out var held);
                if (md.Name.Length != 0 && !ReferenceEquals(held, md) && held?.Type != md.Type) id = Qualified(plain, md);
            }
            else
            {
                plain = md.Name.Length == 0 ? $"{parent.Plain}#{index}" : parent.Plain + CHILD_REF_SEPARATOR + md.Name;
                id = md.Name.Length == 0 ? $"{parent.Id}#{index}" : parent.Id + CHILD_REF_SEPARATOR + md.Name;
                // The first sibling of a name keeps the plain id: it is the one a dotted reference
                // resolves to. A later sibling of another type sharing the name is qualified by type.
                if (md.Name.Length != 0 && seen.Contains(id)) id = Qualified(id, md);
            }
            if (!seen.Add(id))
                throw new InvalidOperationException($"docs view: two nodes share the id \"{id}\" — the model names two siblings alike");
            bool isReq = md.Type == TYPE_REQUIREMENT;
            string address = isReq ? (reqPrefix.Length == 0 ? md.Name : reqPrefix + CHILD_REF_SEPARATOR + md.Name) : reqPrefix;
            bool inherited = parent is not null && !ReferenceEquals(md.Parent, parent.Md);
            var w = new Walked
            {
                Md = md,
                Id = id,
                Plain = plain,
                Parent = parent,
                Order = index,
                Canonical = parent is null || (parent.Canonical && !inherited),
                DeclaredOn = inherited ? md.Parent : null,
                Address = isReq ? address : "",
            };
            w.Top = parent is null ? w : parent.Top;
            w.Direct = parent is null ? null : parent.Parent is null ? w : parent.Direct;
            w.Requirement = isReq ? w : parent?.Requirement;
            if (ReferenceEquals(w.Direct, w)) w.Anchor = MemberAnchor(md, index);
            _walked.Add(w);
            _byId[id] = w;
            if (w.Top.Id == w.Top.Plain) _byPlain.TryAdd(plain, w);
            if (w.Canonical) _canonical[md] = w;
            if (parent is null) _tops.Add(w);
            else parent.Children.Add(w);
            if (isReq) _requirements.Add(w);
            var kids = md.Children();
            for (int i = 0; i < kids.Count; i++) Visit(kids[i], i, w, address, holder, seen);
        }

        private static string PathOf(Walked w)
        {
            if (w.Requirement is { } r)
                return $"requirements/{PackageDir(NamingRefs.EffectivePackageOf(r.Top.Md))}/{PageStem(r.Address)}.html";
            var top = w.Top;
            string qualifier = $"[{top.Md.Type}{TYPE_SUBTYPE_SEPARATOR}{top.Md.SubType}]";
            string typed = top.Id.EndsWith(qualifier, StringComparison.Ordinal) ? $".{top.Md.Type}-{top.Md.SubType}" : "";
            string page = $"model/{PackageDir(NamingRefs.EffectivePackageOf(top.Md))}/{PageStem(top.Md.Name)}{typed}.html";
            return w.Direct is null ? page : $"{page}#{w.Direct.Anchor}";
        }

        private J Link(Walked w)
        {
            string label = ReferenceEquals(w.Requirement, w)
                ? (Str(w.Md.Attr(DOC_ATTR_TITLE)) is { Length: > 0 } t ? t : w.Md.Name)
                : ReferenceEquals(w, w.Top)
                    ? w.Md.Name
                    : w.Top.Md.Name + w.Id[w.Top.Id.Length..];
            return new J().Set("label", label).Set("id", w.Id).Set("path", w.Path)
                .Set("kind", $"{w.Md.Type}{TYPE_SUBTYPE_SEPARATOR}{w.Md.SubType}").Set("unresolved", false);
        }

        private J LinkTo(MetaData? md, string text) =>
            md is not null && _canonical.TryGetValue(md, out var w) ? Link(w) : Unresolved(text);

        /// <summary>The link a reference value lands on: the owner's row for the member its dotted
        /// tail names (the owner's own row of an inherited member, as a claim lands), else the owner
        /// the loader bound.</summary>
        private J RefLink(MetaData? owner, string value)
        {
            if (owner is null) return Unresolved(value);
            var (_, tail) = NamingRefs.SplitChildTail(value);
            Walked? row = tail.Length == 0 ? null : _byPlain.GetValueOrDefault(owner.ResolutionKey() + tail);
            return row is not null ? Link(row) : LinkTo(owner, value);
        }

        // --------------------------------------------------------------
        // the build
        // --------------------------------------------------------------

        public J Run(JsonElement? verifyIn, JsonElement? manifest, JsonElement? routesIn)
        {
            var ledger = LedgerRows(verifyIn);
            bool hasVerify = ledger is not null;
            JsonElement? verify = verifyIn is { ValueKind: JsonValueKind.Object } ? verifyIn : null;

            // ── Requirements: claims first, since nodes and members list them. ──
            var claimsOn = new Dictionary<Walked, List<J>>(ReferenceEqualityComparer.Instance);
            var reqLinks = new Dictionary<Walked, List<J>>(ReferenceEqualityComparer.Instance);
            var reqTargets = new Dictionary<Walked, List<Walked>>(ReferenceEqualityComparer.Instance);
            foreach (var r in _requirements)
            {
                var req = (MetaRequirement)r.Md;
                string referrerPkg = RequirementCheck.EffectivePackage(req);
                var links = new List<J>();
                var targets = new List<Walked>();
                foreach (var reference in req.ImplementedBy)
                {
                    var split = RequirementClaims.SplitMemberRef(reference);
                    var node = RequirementClaims.ResolveClaimTarget(_root, split.Owner, referrerPkg);
                    var member = node is not null && split.Path.Count > 0 ? RequirementClaims.ResolveMember(node, split.Path) : node;
                    string key = node is null ? ""
                        : split.Path.Count == 0 ? node.ResolutionKey()
                        : node.ResolutionKey() + CHILD_REF_SEPARATOR + string.Join(CHILD_REF_SEPARATOR, split.Path);
                    Walked? w = member is not null ? _byPlain.GetValueOrDefault(key) : null;
                    if (w is null)
                    {
                        links.Add(ReqLink(reference, false, Unresolved(reference)));
                        continue;
                    }
                    links.Add(ReqLink(reference, true, Link(w)));
                    targets.Add(w);
                    var claim = new J()
                        .Set("requirement", Link(r))
                        .Set("member", ReferenceEquals(w, w.Top) ? "" : MemberPath(w))
                        .Set("status", req.Status ?? "")
                        .Set("level", req.Level);
                    // The claim is on the top-level node and on every member down to the one it names.
                    for (Walked? x = w; x is not null; x = x.Parent) Add(claimsOn, x, claim);
                }
                reqLinks[r] = links;
                reqTargets[r] = targets;
            }

            // ── Files and routes. ──
            var filesOf = new Dictionary<Walked, Dictionary<string, List<string>>>(ReferenceEqualityComparer.Instance);
            bool hasManifest = manifest is { ValueKind: JsonValueKind.Object };
            if (hasManifest)
            {
                foreach (var e in manifest!.Value.EnumerateObject())
                {
                    if (e.Value.ValueKind != JsonValueKind.Object) continue;
                    string? sourceNode = StringOrNull(e.Value, "sourceNode");
                    if (sourceNode is null || !_byPlain.TryGetValue(sourceNode, out var w)) continue;
                    if (!filesOf.TryGetValue(w.Top, out var by)) filesOf[w.Top] = by = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                    Add(by, StringOrNull(e.Value, "generatedBy") ?? "", e.Name);
                }
            }
            var routesOf = new Dictionary<Walked, Dictionary<string, J>>(ReferenceEqualityComparer.Instance);
            bool hasRoutes = routesIn is { ValueKind: JsonValueKind.Array };
            if (hasRoutes)
            {
                foreach (var el in routesIn!.Value.EnumerateArray())
                {
                    if (el.ValueKind != JsonValueKind.Object) continue;
                    string? node = StringOrNull(el, "node");
                    string? method = StringOrNull(el, "method");
                    string? path = StringOrNull(el, "path");
                    if (node is null || method is null || path is null || !_byPlain.TryGetValue(node, out var w)) continue;
                    // JavaScript's toUpperCase, locale-independent.
                    string upper = method.ToUpperInvariant();
                    if (!routesOf.TryGetValue(w.Top, out var m)) routesOf[w.Top] = m = new Dictionary<string, J>(StringComparer.Ordinal);
                    m[path + Nul + upper] = new J().Set("method", upper).Set("path", path);
                }
            }

            // ── Advisories. ──
            var advisories = new List<J>();
            if (hasVerify && verify is { } v
                && v.TryGetProperty("requirements", out var reqsEl) && reqsEl.ValueKind == JsonValueKind.Object
                && reqsEl.TryGetProperty("rows", out var rows) && rows.ValueKind == JsonValueKind.Array)
            {
                foreach (var d in rows.EnumerateArray())
                {
                    if (d.ValueKind != JsonValueKind.Object) continue;
                    string node = StringOrNull(d, "node") ?? "";
                    J? subject = node.Length == 0 ? null : _byPlain.TryGetValue(node, out var w) ? Link(w.Top) : Unresolved(node);
                    advisories.Add(new J()
                        .Set("code", StringOrNull(d, "code") ?? "")
                        .Set("path", StringOrNull(d, "path") ?? "")
                        .Set("subject", subject)
                        .Set("severity", StringOrNull(d, "severity") ?? "")
                        .Set("source", StringOrNull(d, "source") ?? "")
                        .Set("message", StringOrNull(d, "message") ?? ""));
                }
            }
            var unclaimedIds = new HashSet<string>(
                advisories.Where(a => a.Str("code") == RequirementCheck.WARN_REQUIREMENT_OBJECT_UNCLAIMED && a.Get("subject") is J)
                    .Select(a => ((J)a.Get("subject")!).Str("id")),
                StringComparer.Ordinal);

            // ── Members and references. ──
            var refsFrom = new Dictionary<Walked, List<J>>(ReferenceEqualityComparer.Instance);
            J Member(Walked w)
            {
                var (attrs, refs) = AttrsOf(w.Md);
                J? ext = ExtendsLink(w.Md);
                var own = new List<J>();
                if (ext is not null && !(bool)ext.Get("unresolved")!) own.Add(Ref(ExtendsAttr, Link(w), ext));
                foreach (var (attr, target) in refs) own.Add(Ref(attr, Link(w), target));
                refsFrom[w] = own;
                return new J()
                    .Set("id", w.Id)
                    .Set("name", w.Md.Name)
                    .Set("type", w.Md.Type)
                    .Set("subType", w.Md.SubType)
                    .Set("order", w.Order)
                    .Set("anchor", w.Anchor)
                    .Set("path", w.Path)
                    .Set("abstract", w.Md.IsAbstract)
                    .Set("isArray", w.Md.ResolvedIsArray())
                    .Set("extends", ext)
                    .Set("declaredOn", w.DeclaredOn is not null ? LinkTo(w.DeclaredOn, w.DeclaredOn.Name) : null)
                    .Set("attrs", attrs)
                    .Set("refs", own)
                    .Set("claims", claimsOn.GetValueOrDefault(w) ?? [])
                    .Set("memberGroups", GroupMembers(w.Children.Select(Member).ToList()));
            }

            var nodes = new List<J>();
            var nodeRefs = new Dictionary<Walked, List<J>>(ReferenceEqualityComparer.Instance);
            foreach (var t in _tops)
            {
                var (attrs, refs) = AttrsOf(t.Md);
                J? ext = ExtendsLink(t.Md);
                var memberGroups = GroupMembers(t.Children.Select(Member).ToList());
                var all = new List<J>();
                if (ext is not null && !(bool)ext.Get("unresolved")!) all.Add(Ref(ExtendsAttr, null, ext));
                foreach (var (attr, target) in refs) all.Add(Ref(attr, null, target));
                void Below(Walked w)
                {
                    foreach (var c in w.Children)
                    {
                        all.AddRange(refsFrom.GetValueOrDefault(c) ?? []);
                        Below(c);
                    }
                }
                Below(t);
                nodeRefs[t] = all;
                var files = (filesOf.GetValueOrDefault(t) ?? new())
                    .OrderBy(g => g.Key, StringComparer.Ordinal)
                    .Select(g => new J().Set("generatedBy", g.Key).Set("paths", g.Value.OrderBy(p => p, StringComparer.Ordinal).ToList()))
                    .ToList();
                int fileCount = (filesOf.GetValueOrDefault(t) ?? new()).Sum(g => g.Value.Count);
                var routes = (routesOf.GetValueOrDefault(t) ?? new()).OrderBy(e => e.Key, StringComparer.Ordinal).Select(e => e.Value).ToList();
                var claims = claimsOn.GetValueOrDefault(t) ?? [];
                nodes.Add(new J()
                    .Set("id", t.Id)
                    .Set("name", t.Md.Name)
                    .Set("package", NamingRefs.EffectivePackageOf(t.Md))
                    .Set("type", t.Md.Type)
                    .Set("subType", t.Md.SubType)
                    .Set("order", t.Order)
                    .Set("path", t.Path)
                    .Set("title", Str(t.Md.Attr(DOC_ATTR_TITLE)))
                    .Set("description", Str(t.Md.Attr(DOC_ATTR_DESCRIPTION)))
                    .Set("summary", Str(t.Md.Attr(DOC_ATTR_SUMMARY)))
                    .Set("abstract", t.Md.IsAbstract)
                    .Set("extends", ext)
                    .Set("attrs", attrs)
                    .Set("memberGroups", memberGroups)
                    .Set("refs", all)
                    .Set("referencedBy", new List<J>())
                    .Set("claims", claims)
                    .Set("files", files)
                    .Set("routes", routes)
                    .Set("unclaimed", unclaimedIds.Contains(t.Id))
                    .Set("counts", new J()
                        .Set("members", t.Children.Count)
                        .Set("refs", all.Count)
                        .Set("referencedBy", 0)
                        .Set("claims", claims.Count)
                        .Set("files", fileCount)
                        .Set("routes", routes.Count)));
            }

            // referencedBy: every reference into a top-level node (or a member of it) from another one.
            var nodeById = nodes.ToDictionary(n => n.Str("id"), StringComparer.Ordinal);
            var incoming = new Dictionary<string, Dictionary<string, J>>(StringComparer.Ordinal);
            foreach (var t in _tops)
            {
                foreach (var r in nodeRefs.GetValueOrDefault(t) ?? [])
                {
                    var target = (J)r.Get("target")!;
                    if (!_byId.TryGetValue(target.Str("id"), out var tw) || ReferenceEquals(tw.Top, t)) continue;
                    var via = r.Get("via") as J;
                    var referrer = new J().Set("attr", r.Get("attr")).Set("from", Link(t)).Set("via", via).Set("target", target);
                    string key = string.Join(Nul, t.Id, r.Str("attr"), via?.Str("id") ?? "", target.Str("id"));
                    if (!incoming.TryGetValue(tw.Top.Id, out var m)) incoming[tw.Top.Id] = m = new Dictionary<string, J>(StringComparer.Ordinal);
                    m[key] = referrer;
                }
            }
            foreach (var (id, m) in incoming)
            {
                if (!nodeById.TryGetValue(id, out var n)) continue;
                var by = m.OrderBy(e => e.Key, StringComparer.Ordinal).Select(e => e.Value).ToList();
                n.Set("referencedBy", by);
                ((J)n.Get("counts")!).Set("referencedBy", by.Count);
            }
            nodes.Sort((a, c) => string.CompareOrdinal(a.Str("id"), c.Str("id")));

            // ── The requirement list, flat, in document order. ──
            var reqChildren = new Dictionary<Walked, List<Walked>>(ReferenceEqualityComparer.Instance);
            static Walked? ReqParent(Walked r) => r.Parent?.Requirement;
            foreach (var r in _requirements)
                if (ReqParent(r) is { } p) Add(reqChildren, p, r);
            void Subtree(Walked r, List<Walked> outList)
            {
                outList.Add(r);
                foreach (var c in reqChildren.GetValueOrDefault(r) ?? []) Subtree(c, outList);
            }
            string QualifiedPathOf(Walked x)
            {
                string p = RequirementCheck.EffectivePackage(x.Md);
                return p.Length == 0 ? x.Address : p + PACKAGE_SEPARATOR + x.Address;
            }
            var requirements = new List<J>();
            foreach (var r in _requirements)
            {
                var req = (MetaRequirement)r.Md;
                string pkg = RequirementCheck.EffectivePackage(req);
                string qualifiedPath = pkg.Length == 0 ? r.Address : pkg + PACKAGE_SEPARATOR + r.Address;
                Ledger? row = null;
                if (ledger is not null && ledger.TryGetValue(qualifiedPath, out var q) && q.Count > 0) row = q.Dequeue();
                var chain = new List<Walked>();
                for (var p = ReqParent(r); p is not null; p = ReqParent(p)) chain.Insert(0, p);
                var sub = new List<Walked>();
                Subtree(r, sub);
                var linked = sub.Where(x =>
                {
                    var xr = (MetaRequirement)x.Md;
                    int? level = xr.Level;
                    return (level ?? 0) >= REQUIREMENT_LEVEL_OBJECT || (level is null && xr.ImplementedBy.Count > 0);
                }).ToList();
                List<Walked> counted = linked.Count > 0 ? linked : [r];
                var statuses = counted.Select(x => ((MetaRequirement)x.Md).Status ?? "").Where(s => s.Length != 0).ToList();
                var targetTops = new SortedDictionary<string, Walked>(StringComparer.Ordinal);
                foreach (var x in sub)
                    foreach (var w in reqTargets.GetValueOrDefault(x) ?? []) targetTops.TryAdd(w.Top.Id, w.Top);
                var children = reqChildren.GetValueOrDefault(r) ?? [];
                J? supersededBy = null;
                if (row is { HasSup: true })
                {
                    Walked? supTarget = row.SupTarget.Length == 0 ? null : _requirements.FirstOrDefault(x => QualifiedPathOf(x) == row.SupTarget);
                    supersededBy = ReqLink(row.SupRef, row.SupResolves, supTarget is not null ? Link(supTarget) : Unresolved(row.SupRef));
                }
                requirements.Add(new J()
                    .Set("id", r.Id)
                    .Set("name", r.Md.Name)
                    .Set("label", Link(r).Str("label"))
                    .Set("path", r.Path)
                    .Set("address", r.Address)
                    .Set("package", pkg)
                    .Set("qualifiedPath", qualifiedPath)
                    .Set("subType", r.Md.SubType)
                    .Set("level", req.Level)
                    .Set("status", req.Status ?? "")
                    .Set("disposition", req.Disposition ?? "")
                    .Set("statement", Str(req.Attr(REQUIREMENT_ATTR_STATEMENT)))
                    .Set("counterexample", Str(req.Attr(REQUIREMENT_ATTR_COUNTEREXAMPLE)))
                    .Set("title", Str(req.Attr(DOC_ATTR_TITLE)))
                    .Set("description", Str(req.Attr(DOC_ATTR_DESCRIPTION)))
                    .Set("trackedBy", req.TrackedBy.ToList())
                    .Set("depth", chain.Count)
                    .Set("parent", chain.Count > 0 ? Link(chain[^1]) : null)
                    .Set("breadcrumbs", chain.Select(Link).ToList())
                    .Set("children", children.Select(Link).ToList())
                    .Set("implementedBy", reqLinks.GetValueOrDefault(r) ?? [])
                    .Set("supersededBy", supersededBy)
                    .Set("inLedger", row is not null)
                    .Set("verdict", row?.Verdict ?? "")
                    .Set("digest", row?.Digest ?? "")
                    .Set("diagnostics", row?.Diagnostics ?? [])
                    .Set("rollup", StatusCounts(statuses))
                    .Set("rollupTotal", statuses.Count)
                    .Set("belowCount", sub.Count - 1)
                    .Set("childCount", children.Count)
                    .Set("targets", targetTops.Values.Select(Link).ToList())
                    .Set("targetCount", targetTops.Count));
            }

            // ── Packages, counts, slices. ──
            var pkgNames = nodes.Select(n => n.Str("package")).Distinct().OrderBy(s => s, StringComparer.Ordinal).ToList();
            var packages = new List<J>();
            foreach (var name in pkgNames)
            {
                var inPkg = nodes.Where(n => n.Str("package") == name).ToList();
                var groups = new SortedDictionary<string, J>(StringComparer.Ordinal);
                foreach (var n in inPkg)
                {
                    string key = n.Str("type") + TYPE_SUBTYPE_SEPARATOR + n.Str("subType");
                    if (!groups.TryGetValue(key, out var g))
                        groups[key] = g = new J().Set("type", n.Str("type")).Set("subType", n.Str("subType")).Set("count", 0).Set("nodes", new List<J>());
                    g.Set("count", (int)g.Get("count")! + 1);
                    ((List<J>)g.Get("nodes")!).Add(Link(_byId[n.Str("id")]));
                }
                packages.Add(new J().Set("name", name).Set("count", inPkg.Count).Set("groups", groups.Values.ToList()));
            }

            JsonElement? vc = verify is { } vv && vv.TryGetProperty("requirementCounts", out var rc) && rc.ValueKind == JsonValueKind.Object ? rc : null;
            object Num(string k) => vc is { } c && c.TryGetProperty(k, out var x) && x.ValueKind == JsonValueKind.Number ? x : 0;
            var allFiles = new HashSet<string>(StringComparer.Ordinal);
            int routeCount = 0;
            foreach (var n in nodes)
            {
                foreach (var g in (List<J>)n.Get("files")!) foreach (var p in (List<string>)g.Get("paths")!) allFiles.Add(p);
                routeCount += ((List<J>)n.Get("routes")!).Count;
            }
            var counts = new J()
                .Set("nodes", nodes.Count)
                .Set("packages", packages.Count)
                .Set("requirements", requirements.Count)
                .Set("functional", requirements.Count(r => r.Str("subType") == REQUIREMENT_SUBTYPE_FUNCTIONAL))
                .Set("architectural", requirements.Count(r => r.Str("subType") == REQUIREMENT_SUBTYPE_ARCHITECTURAL))
                .Set("byStatus", StatusCounts(requirements.Select(r => r.Str("status")).ToList()))
                .Set("claims", requirements.Sum(r => ((List<J>)r.Get("implementedBy")!).Count(l => (bool)l.Get("resolves")!)))
                .Set("files", allFiles.Count)
                .Set("routes", routeCount)
                .Set("undecided", Num("undecided"))
                .Set("coverageMeasured", Num("entitiesTotal") is JsonElement)
                .Set("entitiesClaimed", Num("entitiesClaimed"))
                .Set("entitiesTotal", Num("entitiesTotal"));

            return new J()
                .Set("format", Format)
                .Set("sources", new J().Set("requirements", hasVerify).Set("files", hasManifest).Set("routes", hasRoutes))
                .Set("counts", counts)
                .Set("packages", packages)
                .Set("nodes", nodes)
                .Set("requirements", requirements)
                .Set("advisories", advisories)
                .Set("slices", Slices(nodes, requirements));
        }

        private List<J> Slices(List<J> nodes, List<J> requirements)
        {
            var slices = new List<J>();
            static List<string> Sorted(IEnumerable<string> s) => s.Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();
            foreach (var pkg in Sorted(nodes.Select(n => n.Str("package"))))
                slices.Add(Slice("package", pkg, Sorted(nodes.Where(n => n.Str("package") == pkg).Select(n => n.Str("id")))));
            // A requirement with requirements below it: the subtree, each node it claims, and the
            // top-level node holding a claimed member.
            var byId = requirements.ToDictionary(r => r.Str("id"), StringComparer.Ordinal);
            foreach (var r in requirements)
            {
                if ((int)r.Get("childCount")! == 0) continue;
                var ids = new List<string>();
                void Visit(J x)
                {
                    ids.Add(x.Str("id"));
                    foreach (var l in (List<J>)x.Get("implementedBy")!)
                    {
                        if (!(bool)l.Get("resolves")!) continue;
                        string tid = ((J)l.Get("target")!).Str("id");
                        ids.Add(tid);
                        if (_byId.TryGetValue(tid, out var w)) ids.Add(w.Top.Id);
                    }
                    foreach (var c in (List<J>)x.Get("children")!)
                        if (byId.TryGetValue(c.Str("id"), out var child)) Visit(child);
                }
                Visit(r);
                slices.Add(Slice("requirement", r.Str("id"), Sorted(ids)));
            }
            // A template: itself and what its own attributes reference.
            foreach (var n in nodes)
            {
                if (n.Str("type") != TYPE_TEMPLATE) continue;
                var ids = new List<string> { n.Str("id") };
                foreach (var r in (List<J>)n.Get("refs")!)
                {
                    if (r.Get("via") is not null) continue;
                    string tid = ((J)r.Get("target")!).Str("id");
                    ids.Add(_byId.TryGetValue(tid, out var w) ? w.Top.Id : tid);
                }
                slices.Add(Slice("prompt", n.Str("id"), Sorted(ids)));
            }
            slices.Sort((a, c) => string.CompareOrdinal(a.Str("id"), c.Str("id")));
            return slices;
        }

        private static J Slice(string kind, string anchor, List<string> ids) =>
            new J().Set("id", $"{kind}:{anchor}").Set("kind", kind).Set("anchor", anchor).Set("nodes", ids);

        private J? ExtendsLink(MetaData md)
        {
            if (md.SuperData is null && md.SuperRef is null) return null;
            return LinkTo(md.SuperData, md.AuthoredSuperRef ?? md.SuperRef ?? "");
        }

        /// <summary>A node's effective attributes, by name, each value linked where the loader resolved it.</summary>
        private (List<J> Attrs, List<(string Attr, J Target)> Refs) AttrsOf(MetaData md)
        {
            var attrs = new List<J>();
            var refs = new List<(string, J)>();
            var map = md.Attrs();
            foreach (var name in map.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                object? value = CanonicalValue(map[name]);
                bool isRef = NamingRefs.IsRefBearingAttr(md, name);
                MetaData? declarer = isRef ? DeclaringLayer(md, name) : null;
                var values = new List<J>();
                if (value is string s)
                {
                    J? link = isRef ? RefLink(declarer?.ResolvedTargetOf(name), s) : null;
                    values.Add(new J().Set("text", s).Set("link", link));
                    if (link is not null && !(bool)link.Get("unresolved")!) refs.Add((name, link));
                }
                else if (value is List<object?> list && list.All(x => x is string))
                {
                    var owners = declarer?.ResolvedTargetsOf(name);
                    for (int i = 0; i < list.Count; i++)
                    {
                        string item = (string)list[i]!;
                        MetaData? owner = owners is not null && i < owners.Count ? owners[i] : null;
                        J? link = isRef ? RefLink(owner, item) : null;
                        values.Add(new J().Set("text", item).Set("link", link));
                        if (link is not null && !(bool)link.Get("unresolved")!) refs.Add((name, link));
                    }
                }
                else
                {
                    values.Add(new J().Set("text", DocsViewJson.Compact(ToNode(value))).Set("link", null));
                }
                attrs.Add(new J().Set("name", name).Set("value", value).Set("values", values));
            }
            return (attrs, refs);
        }
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    private static void Add<TK, TV>(Dictionary<TK, List<TV>> map, TK key, TV value) where TK : notnull
    {
        if (!map.TryGetValue(key, out var list)) map[key] = list = [];
        list.Add(value);
    }

    /// <summary>The layer that declares <paramref name="name"/> for <paramref name="md"/>: its own,
    /// else the nearest extends ancestor's — where the loader recorded what the reference resolved to.</summary>
    private static MetaData? DeclaringLayer(MetaData md, string name)
    {
        var seen = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);
        for (MetaData? n = md; n is not null && seen.Add(n); n = n.SuperData)
        {
            // ADR-0039: own — locating the layer that declares the attr, walking the super chain.
            if (n.OwnHasAttr(name)) return n;
        }
        return null;
    }

    /// <summary>An attribute value in the view's model, every object's keys in code-unit order, as
    /// the canonical serializer writes them: a map attribute's key order must not depend on a
    /// port's map type.</summary>
    private static object? CanonicalValue(object? v) => v switch
    {
        null => null,
        string or bool or long or double => v,
        int i => (long)i,
        float f => (double)f,
        IReadOnlyDictionary<string, object?> map => map.Keys.OrderBy(k => k, StringComparer.Ordinal)
            .Aggregate(new J(), (j, k) => j.Set(k, CanonicalValue(map[k]))),
        IReadOnlyList<string> strings => strings.Cast<object?>().ToList(),
        System.Collections.IEnumerable list when v is not string => list.Cast<object?>().Select(CanonicalValue).ToList(),
        _ => v.ToString(),
    };

    private static string Str(object? v) => v as string ?? "";

    private static string Qualified(string id, MetaData md) => $"{id}[{md.Type}{TYPE_SUBTYPE_SEPARATOR}{md.SubType}]";

    /// <summary>A direct member's anchor: <c>m-&lt;name&gt;</c> for a field, <c>m-&lt;type&gt;-&lt;name&gt;</c>
    /// for anything else, <c>m-&lt;type&gt;-&lt;order&gt;</c> for one with no name.</summary>
    private static string MemberAnchor(MetaData md, int order)
    {
        if (md.Name.Length == 0) return $"m-{md.Type}-{order}";
        return md.Type == TYPE_FIELD ? $"m-{md.Name}" : $"m-{md.Type}-{md.Name}";
    }

    /// <summary>A member's id after its top-level node's: <c>email</c>, <c>items.price</c>, or <c>#3</c> with no name.</summary>
    private static string MemberPath(Walked w)
    {
        string rest = w.Id[w.Top.Id.Length..];
        return rest.StartsWith(CHILD_REF_SEPARATOR, StringComparison.Ordinal) ? rest[CHILD_REF_SEPARATOR.Length..] : rest;
    }

    /// <summary>The directory of a package's pages; <c>-root</c> for the empty package.</summary>
    private static string PackageDir(string pkg) =>
        pkg.Length == 0 ? "-root" : string.Join("/", pkg.Split(PACKAGE_SEPARATOR));

    /// <summary>A page's file stem: the name, unless it would take the package page's <c>index.html</c>.</summary>
    private static string PageStem(string name) =>
        name.ToLowerInvariant() == "index" ? name + ".node" : name;

    private static J Unresolved(string text) =>
        new J().Set("label", text).Set("id", "").Set("path", "").Set("kind", "").Set("unresolved", true);

    private static J ReqLink(string reference, bool resolves, J target) =>
        new J().Set("ref", reference).Set("resolves", resolves).Set("target", target);

    private static J Ref(string attr, J? via, J target) =>
        new J().Set("attr", attr).Set("via", via).Set("target", target);

    private static List<J> GroupMembers(List<J> members)
    {
        var groups = new List<J>();
        var byType = new Dictionary<string, J>(StringComparer.Ordinal);
        foreach (var m in members)
        {
            string type = m.Str("type");
            if (!byType.TryGetValue(type, out var g))
            {
                byType[type] = g = new J().Set("type", type).Set("count", 0).Set("members", new List<J>());
                groups.Add(g);
            }
            g.Set("count", (int)g.Get("count")! + 1);
            ((List<J>)g.Get("members")!).Add(m);
        }
        return groups;
    }

    private static List<J> StatusCounts(List<string> statuses) =>
        REQUIREMENT_STATUSES.Select(status => new J().Set("status", status).Set("count", statuses.Count(s => s == status))).ToList();

    private static Dictionary<string, Queue<Ledger>>? LedgerRows(JsonElement? verify)
    {
        if (verify is not { ValueKind: JsonValueKind.Object } v
            || !v.TryGetProperty("requirementLedger", out var led) || led.ValueKind != JsonValueKind.Array) return null;
        var outMap = new Dictionary<string, Queue<Ledger>>(StringComparer.Ordinal);
        foreach (var raw in led.EnumerateArray())
        {
            if (raw.ValueKind != JsonValueKind.Object) continue;
            string? qp = StringOrNull(raw, "qualifiedPath");
            if (qp is null) continue;
            var diags = new List<object?>();
            if (raw.TryGetProperty("diagnostics", out var ds) && ds.ValueKind == JsonValueKind.Array)
            {
                foreach (var d in ds.EnumerateArray())
                {
                    if (d.ValueKind != JsonValueKind.Object) continue;
                    diags.Add(new J()
                        .Set("code", StringOrNull(d, "code") ?? "")
                        .Set("severity", StringOrNull(d, "severity") ?? "")
                        .Set("source", StringOrNull(d, "source") ?? "")
                        .Set("message", StringOrNull(d, "message") ?? ""));
                }
            }
            bool hasSup = raw.TryGetProperty("supersededBy", out var sup) && sup.ValueKind == JsonValueKind.Object && StringOrNull(sup, "ref") is not null;
            var row = new Ledger(qp, StringOrNull(raw, "digest") ?? "", StringOrNull(raw, "verdict") ?? "", diags,
                hasSup,
                hasSup ? StringOrNull(sup, "ref") ?? "" : "",
                hasSup && sup.TryGetProperty("resolves", out var res) && res.ValueKind == JsonValueKind.True,
                hasSup ? StringOrNull(sup, "target") ?? "" : "");
            if (!outMap.TryGetValue(qp, out var q)) outMap[qp] = q = new Queue<Ledger>();
            q.Enqueue(row);
        }
        return outMap;
    }

    private static string? StringOrNull(JsonElement o, string key) =>
        o.TryGetProperty(key, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
}
