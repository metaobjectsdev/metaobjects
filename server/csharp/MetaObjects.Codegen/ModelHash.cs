// ADR-0064 — the hash tree of a LOADED model: one hash per root-level node, one per package, one
// for the model. A node is hashed in its canonical EFFECTIVE form (the serializer the conformance
// runner uses for expected-effective fixtures): `extends` and overlays applied, attributes in a
// fixed order, no source positions. So reformatting a metadata file, reordering it, or moving an
// object to another file of the same package does not change a hash, and an edit to an abstract
// parent changes the hash of every node that inherits from it.
//
// The tree is exposed (not just the model hash) so a later per-object or per-package key can
// reuse the node and package hashes.

using System.Security.Cryptography;
using System.Text;
using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>The node, package and model hashes of a loaded model.</summary>
public sealed class ModelHash
{
    /// <summary>One root-level node: its effective package, its type and name, and its hash.</summary>
    public sealed record Node(string Package, string Type, string Name, string Hash);

    public IReadOnlyList<Node> Nodes { get; }

    /// <summary>Per package: sha-256 over the sorted <c>type:name:hash</c> lines of its nodes.</summary>
    public IReadOnlyDictionary<string, string> Packages { get; }

    /// <summary>sha-256 over the sorted <c>package:hash</c> lines of the packages.</summary>
    public string Model { get; }

    private ModelHash(IReadOnlyList<Node> nodes, IReadOnlyDictionary<string, string> packages, string model)
    {
        Nodes = nodes;
        Packages = packages;
        Model = model;
    }

    private static string Sha(string text) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    public static ModelHash Of(MetaRoot root)
    {
        var nodes = new List<Node>();
        // The root has no super, so its children are the root-level nodes, whole.
        foreach (var child in root.Children())
        {
            if (child.Type == MetaObjects.Shared.BaseTypes.TYPE_ATTR) continue;
            // The effective package is part of the identity: the serialized body omits a package
            // the node only inherits from its file.
            var pkg = child.Package ?? child.FileDefaultPackage ?? root.Package ?? "";
            var body = SerializerJson.CanonicalSerializeEffective(child);
            nodes.Add(new Node(pkg, child.Type + "." + child.SubType, child.Name, Sha(pkg + "\n" + body)));
        }
        var packages = nodes.GroupBy(n => n.Package, StringComparer.Ordinal)
            .ToDictionary(
                g => g.Key,
                g => Sha(string.Join("\n", g.Select(n => $"{n.Type}:{n.Name}:{n.Hash}").Order(StringComparer.Ordinal))),
                StringComparer.Ordinal);
        var model = Sha(string.Join("\n", packages.Select(p => $"{p.Key}:{p.Value}").Order(StringComparer.Ordinal)));
        return new ModelHash(nodes, packages, model);
    }
}
