using System;
using System.Collections.Generic;
using System.Linq;
using MetaObjects.Codegen.Generators;
using MetaObjects.Meta;

namespace MetaObjects.Codegen.TemplateCodegen;

/// <summary>
/// The three built-in walk scopes (SP-1 §3.1): <c>perEntity</c>, <c>perPackage</c>,
/// <c>perModel</c>. Each yields the neutral data dict for its unit and names the
/// file via <see cref="OutputPattern"/>. Same vocabulary as the other ports.
/// </summary>
public static class ScopeWalk
{
    public const string PerEntity = "perEntity";
    public const string PerPackage = "perPackage";
    public const string PerModel = "perModel";

    public static readonly IReadOnlyList<string> Scopes = new[] { PerEntity, PerPackage, PerModel };

    public static Func<MetaRoot, IEnumerable<TemplateWalkResult>> ForScope(string scope, string outputPattern)
    {
        if (!Scopes.Contains(scope))
            throw new ArgumentException(
                $"unknown template scope '{scope}' (expected {string.Join(" | ", Scopes)})");
        return root =>
        {
            var objects = root.Objects();
            var concrete = objects.Where(TemplateData.IsConcrete).ToList();
            switch (scope)
            {
                case PerEntity:
                    return concrete.Select(o => new TemplateWalkResult(
                        TemplateData.Entity(o),
                        OutputPattern.Expand(outputPattern, TemplateData.BareName(o), TemplateData.PackageOf(o))))
                        .ToList();
                case PerPackage:
                    var byPkg = new SortedDictionary<string, List<MetaObject>>(StringComparer.Ordinal);
                    foreach (var o in concrete)
                    {
                        if (!byPkg.TryGetValue(TemplateData.PackageOf(o), out var list))
                            byPkg[TemplateData.PackageOf(o)] = list = new List<MetaObject>();
                        list.Add(o);
                    }
                    return byPkg.Select(kv => new TemplateWalkResult(
                        TemplateData.Package(kv.Key, kv.Value),
                        OutputPattern.Expand(outputPattern, null, kv.Key))).ToList();
                case PerModel:
                    return new[]
                    {
                        new TemplateWalkResult(
                            TemplateData.Model(objects),
                            OutputPattern.Expand(outputPattern, null, null)),
                    };
                default:
                    throw new ArgumentException(
                        $"unknown template scope '{scope}' (expected {string.Join(" | ", Scopes)})");
            }
        };
    }
}
