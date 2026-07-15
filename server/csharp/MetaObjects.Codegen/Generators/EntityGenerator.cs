// entity-generator — emits an EF Core entity class per object.entity / projection,
// plus a plain POCO for each value object an object-typed field nests.
//
// PascalCase properties (C# convention) mapped to the metadata field name as the
// DB column via [Column]; [Table] from the dbTable source (or entity name); [Key]
// (or class-level [PrimaryKey] for composites); [MaxLength]; nullability driven by
// @required + primary-identity membership. Object-typed fields on entities become
// owned-type navigation properties (the column mapping — flattened vs. jsonb — is
// configured in the DbContext); the referenced value object is emitted as a POCO.
// Enum-typed fields emit a nested C# enum + a property typed by it; EF Core
// HasConversion<string>() is wired in the DbContext.
// Object-typed fields on read-only projections (collection origins) are not mapped
// here — that is a separate projection-materialization concern.

using System.Text;
using MetaObjects.Codegen.Docs;
using MetaObjects.Meta;
using MetaObjects.Persistence.Origin;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Validator.ValidatorConstants;
using static MetaObjects.Persistence.Origin.OriginConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>
/// Generates EF Core entity/projection classes + value-object POCOs.
///
/// Open for extension (ADR-0002): the per-class emit methods are
/// <c>protected virtual</c>, and two finer-grained hooks —
/// <see cref="EmitClassHeader"/> (XML-doc + composite [PrimaryKey] + [Table] + the
/// class declaration line) and <see cref="EmitPropertyAttributes"/> (per-property
/// C# attributes appended after the framework attributes) — cover the bulk of
/// adopter customizations. The default bodies leave emitted output byte-identical.
/// </summary>
public class EntityGenerator : IGenerator
{
    public virtual string Name => "entity-generator";

    /// <summary>The C# property name for a field. Default: PascalCase the metadata
    /// (camelCase) name. Extension seam (ADR-0002) — a subclass can override to honor
    /// an explicit casing source (e.g. P3 preserves an all-caps acronym column casing
    /// like NPI/PARequired that a plain PascalCase of the field name would mangle).</summary>
    protected virtual string PropertyName(MetaField field) => CSharpNaming.Pascal(field.Name);

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        // Entities + read-only projections get the full EF mapping.
        var mapped = ctx.Entities
            .Where(o => o.IsEntity() || o.DbView is not null)
            .OrderBy(o => o.Name, StringComparer.Ordinal)
            .ToList();

        // Plain value objects targeted by an entity object-field become POCOs so the
        // owned-type navigation properties compile.
        var valueObjects = ReferencedValueObjects(mapped, ctx);

        var files = new List<EmittedFile>();

        // FR-019 — materialized shared enums (root-level abstract field.enum, non-@provided,
        // consumed by ≥1 field) are emitted ONCE in a dedicated Enums.g.cs at the entity-module
        // namespace; consuming entity fields REFERENCE them (no nested redeclaration). @provided
        // shared enums emit nothing here (referenced from configured external namespace). With no
        // shared enums in the model (the common inline case) no file is emitted — byte-identical.
        if (EmitSharedEnumsFile(ctx) is { } sharedEnums)
            files.Add(sharedEnums);

        foreach (var e in mapped)
        {
            // Abstract entities never produce a table-mapped instance class. Gated
            // by EmitAbstractShapes: off → no artifact at all; on → exactly one
            // standalone `public abstract class` shape (no EF mapping attributes).
            if (InstanceArtifacts.IsAbstract(e))
            {
                if (!ctx.Config.EmitAbstractShapes)
                    continue;
                // An abstract entity INSIDE a TPH hierarchy is a real link in the
                // inheritance chain (`abstract class X : DirectParent`) carrying its own
                // fields, so its concrete subtypes inherit the chain's members (navs,
                // interfaces). IsTphMember (not IsTphSubtype) so abstract intermediates —
                // which carry no @discriminatorValue — are included. A standalone abstract
                // (not in a TPH) stays a baseless shape.
                if (TphPlanBuilder.IsTphMember(e, ctx.Root))
                    files.Add(EmitTphSubtypeClass(e, ctx));
                else
                    files.Add(EmitAbstractShapeClass(e, ctx));
                continue;
            }
            // FR-017 TPH: a subtype of a @discriminator base is NOT a standalone table — it
            // is `class Sub : DirectParent` carrying only its own fields, folded into the
            // base's single physical table by EF as nullable columns. The C# inheritance
            // chain mirrors the metadata `extends` chain (abstract intermediates preserved).
            if (TphPlanBuilder.IsTphSubtype(e, ctx.Root))
            {
                files.Add(EmitTphSubtypeClass(e, ctx));
                continue;
            }
            files.Add(EmitMappedClass(e, ctx));
        }
        foreach (var vo in valueObjects)
            files.Add(EmitValueObjectPoco(vo, ctx));

        // ADR-0038 — reverse-relationship navigation as explicit FK finders. For each
        // concrete, table-mapped entity holding ≥1 FK (identity.reference), emit a
        // <Entity>Queries static class with a single + batched finder per FK over the
        // generated DbSet (framework-free, single-query LINQ). NOT a lazy collection.
        // TPH subtypes are folded into the base's DbSet, so finders hang off the base
        // entity's set — skip subtype-level emission (the base carries the FKs it owns).
        foreach (var e in mapped)
        {
            if (InstanceArtifacts.IsAbstract(e)) continue;
            if (TphPlanBuilder.IsTphSubtype(e, ctx.Root)) continue;
            if (e.IsReadOnlyProjection()) continue;            // projections are read-only views; no FK finders
            if (ReverseFinderBuilder.Generate(e, ctx) is { } queries)
                files.Add(queries);
        }
        return files;
    }

    // EF Core entity (table) or projection (view) class.
    protected virtual EmittedFile EmitMappedClass(MetaObject entity, GenContext ctx)
    {
        var className = CSharpNaming.Pascal(entity.Name);
        var pk = entity.PrimaryIdentity();
        var pkFields = pk?.Fields ?? [];
        // Read-only projections map to a view (configured in the DbContext via
        // .ToView); they carry no [Table]. Tables / write-through carry [Table].
        var isProjection = entity.IsReadOnlyProjection();

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects entity-generator. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System;");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine("using System.ComponentModel.DataAnnotations;");
        sb.AppendLine("using System.ComponentModel.DataAnnotations.Schema;");
        // A @dbColumnType:jsonb field surfaces as a System.Text.Json.JsonDocument (issue #98).
        if (CSharpNaming.RequiresSystemTextJson(entity))
            sb.AppendLine("using System.Text.Json;");
        // ADR-0036 Wave 3 — a field.inet surfaces as System.Net.IPAddress.
        if (CSharpNaming.RequiresSystemNet(entity))
            sb.AppendLine("using System.Net;");
        // A composite PK emits a class-level [PrimaryKey(...)] which lives in the
        // Microsoft.EntityFrameworkCore namespace (not a DataAnnotations attribute) —
        // import it so the emitted class compiles standalone, without relying on the
        // host project's ImplicitUsings.
        if (pkFields.Count > 1)
            sb.AppendLine("using Microsoft.EntityFrameworkCore;");
        // FR-021 — usings for OTHER packages this entity references (object navs + TPH base).
        foreach (var ns in PackageBindingResolver.CrossPackageReferencedNamespaces(entity, ctx.Root, ctx.Config))
            sb.AppendLine($"using {ns};");
        EmitFileUsings(sb, entity, ctx);
        sb.AppendLine();
        sb.AppendLine($"namespace {PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(entity), entity.Name, fallbackContext: entity.Name)};");
        sb.AppendLine();

        EmitClassHeader(sb, entity, className, isProjection, pkFields, ctx);
        sb.AppendLine("{");

        // Nested enum declarations (before the class properties, as C# enum members
        // must be declared before they are referenced by property types).
        var enumDecls = CollectEnumDecls(entity);

        // Members in declared order: scalar columns + enum-typed props + (entities only) owned-type navs.
        // When this entity extends an emitted base class (DirectMappedParent), the base carries
        // the inherited fields — emit ONLY this entity's own fields and let C# inheritance supply
        // the rest (mirrors the metadata `extends` chain; the PK lives on the declaring base).
        var inheritedNames = DirectMappedParent(entity, ctx.Config) is { } mp
            ? new HashSet<string>(mp.Fields().Select(f => f.Name), StringComparer.Ordinal)
            : new HashSet<string>(StringComparer.Ordinal);
        var members = new List<string>();
        var strategy = ctx.Config.ColumnNamingStrategy;
        foreach (var field in entity.Fields())
        {
            if (inheritedNames.Contains(field.Name)) continue; // inherited via the C# base chain
            string? member = null;
            if (CSharpNaming.ScalarFor(field.SubType) is not null)
            {
                member = ScalarProperty(entity, field, pkFields, withAttributes: true, strategy,
                    AggregateResultScalar(field, ctx));
            }
            else if (field.SubType == FIELD_SUBTYPE_ENUM)
            {
                member = EnumProperty(entity, field, ctx.Config, strategy);
            }
            else if (field.SubType == FIELD_SUBTYPE_OBJECT)
            {
                // Owned-type navigation only on entities; projection collection
                // origins are materialized elsewhere.
                if (isProjection)
                {
                    ctx.Warn($"{Name}: skipping object-typed field \"{entity.Name}.{field.Name}\" on projection (collection materialization not emitted here).");
                    continue;
                }
                member = ObjectNavProperty(entity, field, ctx);
            }
            else if (field.SubType == FIELD_SUBTYPE_MAP)
            {
                member = MapProperty(entity, field, ctx);
            }
            if (member is null) continue;
            member = ApplyPropertyAttributes(member, entity, field, ctx);
            members.Add(XmlDocBuilder.Prepend(member, field, "    "));
        }

        // FR-018 M:N navigation collections (entities only; the EF UsingEntity
        // wiring + the REST traversal route are emitted by the DbContext + routes
        // generators). One ICollection<Target> per @cardinality:"many" + @through
        // relationship — for a self-join the member is named after the relationship.
        if (!isProjection)
            foreach (var nav in M2MNavigationBuilder.For(entity, ctx.Root))
                members.Add(M2mNavProperty(nav));

        if (enumDecls.Count > 0)
        {
            sb.Append(string.Join("\n", enumDecls));
            sb.AppendLine();
        }
        sb.Append(string.Join("\n", members));
        sb.AppendLine();
        EmitClassBodyTrailer(sb, entity, ctx);
        sb.AppendLine("}");
        return new EmittedFile($"{className}.g.cs", sb.ToString());
    }

    // Extension hook — owns the per-class header for a mapped entity/projection: the
    // XML doc comment, a composite class-level [PrimaryKey(...)], the [Table(...)] (on
    // tables/write-through only, never a read-only projection view), and the
    // `public [abstract] class <name>` declaration line. The default body reproduces
    // exactly the inline emission, so the default output is byte-identical. Override to
    // emit a `partial` class, add a marker interface, attach extra class-level
    // attributes, etc. (ADR-0002, open-closed). Implementations MUST NOT emit the
    // trailing `{` — the caller does.
    protected virtual void EmitClassHeader(
        StringBuilder sb, MetaObject entity, string className, bool isProjection,
        IReadOnlyList<string> pkFields, GenContext ctx)
    {
        // XML doc + [Obsolete] FIRST — XML doc-extraction tools (docfx,
        // Sandcastle, IDE hover-doc) require the doc comment to immediately
        // precede the declaration, before any attributes.
        XmlDocBuilder.AppendTo(sb, entity);
        // Composite primary key -> class-level [PrimaryKey(...)] (EF Core 7+).
        if (pkFields.Count > 1)
        {
            var names = string.Join(", ", pkFields.Select(f => $"nameof({CSharpNaming.Pascal(f)})"));
            sb.AppendLine($"[PrimaryKey({names})]");
        }
        if (!isProjection)
            sb.AppendLine($"[Table(\"{CSharpNaming.Table(entity)}\")]");
        // The `public [abstract] class <Name>[ : Base]` declaration line itself is routed
        // through the single overridable seam shared by all four emitted class kinds, so an
        // adopter's `partial`/marker-interface override applies uniformly. The EF mapping
        // attrs ([Table]/[PrimaryKey]) above stay here — they are mapped-entity-only.
        EmitClassDeclarationLine(sb, entity, className, ClassDeclarationKind.MappedEntity, ctx);
    }

    // The four emitted class kinds — the declaration-line seam dispatches on this so an
    // override can tailor (or uniformly customize) each kind's `public ... class <Name>` line.
    protected enum ClassDeclarationKind
    {
        MappedEntity,   // EF-mapped table/view entity or read-only projection
        TphSubtype,     // FR-017 TPH subtype: `class <Sub> : <Base>`
        AbstractShape,  // standalone `public abstract class` shape for an abstract entity
        ValueObject,    // plain owned value-object POCO
    }

    // Extension hook — emits ONLY the `public [abstract] class <Name>[ : Base]` declaration
    // line (no EF mapping attributes; those stay in EmitClassHeader for mapped entities).
    // This is the single seam every emitted class kind routes its declaration line through,
    // so an adopter override (e.g. emit `partial`, add a marker interface) applies uniformly
    // to mapped entities, TPH subtypes, abstract shapes, and value-object POCOs. The default
    // body reproduces exactly the inline emission per kind, so default output is byte-identical.
    // Implementations MUST NOT emit the trailing `{` — the caller does. (ADR-0002, open-closed.)
    protected virtual void EmitClassDeclarationLine(
        StringBuilder sb, MetaObject entity, string className, ClassDeclarationKind kind, GenContext ctx)
    {
        switch (kind)
        {
            case ClassDeclarationKind.MappedEntity:
                // FR-017 TPH: the discriminator base is emitted `abstract` — every row is a
                // concrete subtype (no plain-base rows exist), so EF Core must not require a
                // base discriminator value. A concrete base with a discriminator but no
                // HasValue<Base>(...) fails model validation ("has a discriminator property,
                // but does not have a discriminator value configured").
                var classKeyword = TphPlanBuilder.IsTphDiscriminatorBase(entity, ctx.Root) ? "abstract class" : "class";
                sb.AppendLine($"public {classKeyword} {className}");
                break;
            case ClassDeclarationKind.TphSubtype:
                // Extend the DIRECT metadata parent (abstract intermediate or root), not the
                // discriminator root — preserves the inheritance chain. Abstract intermediates
                // are emitted `abstract class`.
                var baseClass = CSharpNaming.Pascal(DirectTphParent(entity).Name);
                var tphKeyword = InstanceArtifacts.IsAbstract(entity) ? "abstract class" : "class";
                sb.AppendLine($"public {tphKeyword} {className} : {baseClass}");
                break;
            case ClassDeclarationKind.AbstractShape:
                sb.AppendLine($"public abstract class {className}");
                break;
            case ClassDeclarationKind.ValueObject:
                sb.AppendLine($"public class {className}");
                break;
        }
    }

    // A M:N navigation collection property on the source entity. The collection is
    // the relationship name PascalCased; its element type is the target entity.
    //
    // Hetero (source != target) is wired as an EF skip-navigation through the
    // junction (DbContext UsingEntity<Through>). A self-join (directed or symmetric)
    // is NOT an EF many-to-many: a self-referencing M:N over an explicit junction is
    // not cleanly expressible, and a symmetric relation is union-on-read (no EF
    // relationship at all). Those navs are [NotMapped] — the REST route + runtime
    // resolver traverse the junction explicitly (the cross-port contract is the
    // route behavior, not EF eager-loading).
    protected static string M2mNavProperty(M2MNavigation nav)
    {
        var target = CSharpNaming.Pascal(nav.Target.Name);
        var prop = CSharpNaming.Pascal(nav.Name);
        var notMapped = nav.IsSelfJoin ? "    [NotMapped]\n" : "";
        return $"{notMapped}    public ICollection<{target}> {prop} {{ get; set; }} = new List<{target}>();";
    }

    // FR-017 TPH subtype class: `public class <Sub> : <Base>` carrying ONLY its
    // subtype-only fields (those not already on the base). All are emitted NULLABLE
    // and WITHOUT [Key]/[Required] — they map to nullable columns in the base's single
    // physical table (a row of another subtype stores NULL there), so even an
    // @required subtype field is nullable at the column level. The subtype carries NO
    // [Table] (it shares the base's table) and no PK ([Key] lives on the base).
    protected virtual EmittedFile EmitTphSubtypeClass(MetaObject entity, GenContext ctx)
    {
        var className = CSharpNaming.Pascal(entity.Name);
        // Own fields only — the rest are inherited through the C# base chain (which mirrors
        // the metadata `extends` chain), so exclude everything the DIRECT parent already carries.
        var baseFieldNames = new HashSet<string>(
            DirectTphParent(entity).Fields().Select(f => f.Name), StringComparer.Ordinal);
        var strategy = ctx.Config.ColumnNamingStrategy;

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects entity-generator (TPH subtype). Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System;");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine("using System.ComponentModel.DataAnnotations;");
        sb.AppendLine("using System.ComponentModel.DataAnnotations.Schema;");
        // FR-021 — usings for OTHER packages this entity references (object navs + TPH base).
        foreach (var ns in PackageBindingResolver.CrossPackageReferencedNamespaces(entity, ctx.Root, ctx.Config))
            sb.AppendLine($"using {ns};");
        EmitFileUsings(sb, entity, ctx);
        sb.AppendLine();
        sb.AppendLine($"namespace {PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(entity), entity.Name, fallbackContext: entity.Name)};");
        sb.AppendLine();

        XmlDocBuilder.AppendTo(sb, entity);
        EmitClassDeclarationLine(sb, entity, className, ClassDeclarationKind.TphSubtype, ctx);
        sb.AppendLine("{");

        // Subtype-only enum declarations (an enum field declared on the subtype, not the base).
        var ownEnumDecls = new List<string>();
        var seenEnum = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in entity.Fields())
        {
            if (baseFieldNames.Contains(field.Name)) continue;
            if (field.SubType != FIELD_SUBTYPE_ENUM) continue;
            if (Fr019SharedEnum.SharedEnumForField(field) is not null) continue; // FR-019 shared/provided → referenced
            var values = field.EffectiveEnumValues;
            if (values is null || values.Count == 0) continue;
            var typeName = CSharpNaming.EnumTypeName(entity, field);
            if (!seenEnum.Add(typeName)) continue;
            ownEnumDecls.Add($"    public enum {typeName} {{ {string.Join(", ", values)} }}");
        }

        var members = new List<string>();
        foreach (var field in entity.Fields())
        {
            if (baseFieldNames.Contains(field.Name)) continue; // inherited from the base
            string? member = null;
            if (CSharpNaming.ScalarFor(field.SubType) is not null)
                member = TphSubtypeScalarProperty(entity, field, strategy);
            else if (field.SubType == FIELD_SUBTYPE_ENUM)
                member = TphSubtypeEnumProperty(entity, field, ctx.Config, strategy);
            else if (field.SubType == FIELD_SUBTYPE_OBJECT)
                member = ObjectNavProperty(entity, field, ctx);
            else if (field.SubType == FIELD_SUBTYPE_MAP)
                member = MapProperty(entity, field, ctx);
            if (member is null) continue;
            member = ApplyPropertyAttributes(member, entity, field, ctx);
            members.Add(XmlDocBuilder.Prepend(member, field, "    "));
        }

        if (ownEnumDecls.Count > 0)
        {
            sb.Append(string.Join("\n", ownEnumDecls));
            sb.AppendLine();
        }
        sb.Append(string.Join("\n", members));
        sb.AppendLine();
        EmitClassBodyTrailer(sb, entity, ctx);
        sb.AppendLine("}");
        return new EmittedFile($"{className}.g.cs", sb.ToString());
    }

    // A subtype-only scalar property: [Column]-mapped, with the field's validator
    // attributes (length/numeric/regex) but NEVER [Key]/[Required]. CLR nullability
    // follows @required (a logically-required subtype field is non-null in CLR);
    // EF Core auto-nullables the underlying COLUMN for TPH-derived properties regardless
    // of CLR nullability (a row of another subtype stores NULL there), so a non-null CLR
    // type maps to a nullable column correctly — and matches adopters whose marker
    // interfaces declare these members non-null. Arrays keep the List<T> shape.
    protected virtual string TphSubtypeScalarProperty(MetaObject entity, MetaField field, ColumnNamingStrategy strategy)
    {
        // ScalarForField resolves the ADR-0036 Wave 2 conditional field.timestamp binding.
        var baseType = CSharpNaming.ScalarForField(field)!;
        var propName = PropertyName(field);

        if (field.ResolvedIsArray()) // ADR-0039: resolving — array-ness inheritable via extends
        {
            var arr = new StringBuilder();
            arr.AppendLine($"    [Column(\"{CSharpNaming.Column(field, strategy)}\")]");
            AppendArrayValidatorAttributes(arr, field);
            arr.Append($"    public ICollection<{baseType}> {propName} {{ get; set; }} = new List<{baseType}>();");
            return arr.ToString();
        }

        var sb = new StringBuilder();
        sb.AppendLine($"    [Column(\"{CSharpNaming.Column(field, strategy)}\")]");
        if (baseType == "string")
            AppendStringValidatorAttributes(sb, field);
        else
            AppendNumericValidatorAttributes(sb, field);
        var nullable = CSharpNaming.IsRequired(entity, field) ? "" : "?";
        sb.Append($"    public {baseType}{nullable} {propName} {{ get; set; }}");
        return sb.ToString();
    }

    // A subtype-only enum property: [Column]-mapped (no [Required]). CLR nullability
    // follows @required (see TphSubtypeScalarProperty); the column is auto-nullable.
    protected virtual string TphSubtypeEnumProperty(MetaObject entity, MetaField field, GenConfig config, ColumnNamingStrategy strategy)
    {
        var typeName = EnumPropertyTypeName(entity, field, config);
        var propName = PropertyName(field);
        var colAttr = $"    [Column(\"{CSharpNaming.Column(field, strategy)}\")]\n";
        if (field.ResolvedIsArray()) // ADR-0039: resolving — array-ness inheritable via extends
            return $"{colAttr}    public ICollection<{typeName}> {propName} {{ get; set; }} = new List<{typeName}>();";
        var nullable = CSharpNaming.IsRequired(entity, field) ? "" : "?";
        return $"{colAttr}    public {typeName}{nullable} {propName} {{ get; set; }}";
    }

    // The directly-extended entity (the metadata `extends` target) of a TPH subtype — the
    // immediate parent in the inheritance chain (abstract intermediate or the root). Falls
    // back to the discriminator root if no super is resolved (shouldn't happen for a subtype).
    protected static MetaObject DirectTphParent(MetaObject subtype) =>
        subtype.SuperData as MetaObject ?? TphBaseOf(subtype);

    // The directly-extended entity to emit as a C# base class for a NON-TPH entity (mapped
    // entity or abstract shape). The metadata `extends` chain becomes the C# inheritance
    // chain: `class Physician : BaseAuditableEntity`, `abstract class BaseAuditableEntity :
    // BaseEntity`. Returns the immediate `extends` target when it is an emitted entity — an
    // abstract base (only when EmitAbstractShapes is on, since the base must exist as a type)
    // or a concrete parent. Null when there is no such parent: the entity then flattens its
    // (un-emitted) abstract ancestors' fields as before. TPH members use DirectTphParent.
    protected static MetaObject? DirectMappedParent(MetaObject entity, GenConfig config)
    {
        if (entity.SuperData is not MetaObject sup || !sup.IsEntity()) return null;
        if (InstanceArtifacts.IsAbstract(sup)) return config.EmitAbstractShapes ? sup : null;
        return sup;
    }

    // The nearest @discriminator-bearing ancestor of a TPH subtype (its TPH base).
    protected static MetaObject TphBaseOf(MetaObject subtype)
    {
        MetaData? cursor = subtype.SuperData;
        // ADR-0039: super-chain walk — OwnAttr at each level locates the nearest ancestor that
        // itself DECLARES @discriminator (the TPH base). Sanctioned super-resolution pattern.
        while (cursor is not null)
        {
            if (cursor.OwnAttr(MetaObjects.Core.Object.ObjectConstants.OBJECT_ATTR_DISCRIMINATOR) is string v
                && v.Length > 0 && cursor is MetaObject mo)
                return mo;
            cursor = cursor.SuperData;
        }
        // Unreachable: IsTphSubtype guarantees a discriminator ancestor exists.
        throw new InvalidOperationException($"TPH subtype \"{subtype.Name}\" has no @discriminator base.");
    }

    // Standalone shape class for an ABSTRACT entity (emitted only when
    // GenConfig.EmitAbstractShapes is true). An abstract entity contributes shape
    // via inheritance, not as a table — so this carries NO EF mapping attributes
    // ([Table]/[Key]/[Column]/[MaxLength]/[Required]) and is emitted as
    // `public abstract class`. C# concrete entities flatten inherited fields (they
    // do not reference the base), so the shape is standalone — never a base type.
    protected virtual EmittedFile EmitAbstractShapeClass(MetaObject entity, GenContext ctx)
    {
        var className = CSharpNaming.Pascal(entity.Name);

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects entity-generator (abstract shape). Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System;");
        sb.AppendLine("using System.Collections.Generic;");
        // A @dbColumnType:jsonb field surfaces as a System.Text.Json.JsonDocument (issue #98).
        if (CSharpNaming.RequiresSystemTextJson(entity))
            sb.AppendLine("using System.Text.Json;");
        // ADR-0036 Wave 3 — a field.inet surfaces as System.Net.IPAddress.
        if (CSharpNaming.RequiresSystemNet(entity))
            sb.AppendLine("using System.Net;");
        // FR-021 — usings for OTHER packages this entity references (object navs + TPH base).
        foreach (var ns in PackageBindingResolver.CrossPackageReferencedNamespaces(entity, ctx.Root, ctx.Config))
            sb.AppendLine($"using {ns};");
        EmitFileUsings(sb, entity, ctx);
        sb.AppendLine();
        sb.AppendLine($"namespace {PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(entity), entity.Name, fallbackContext: entity.Name)};");
        sb.AppendLine();

        XmlDocBuilder.AppendTo(sb, entity);
        EmitClassDeclarationLine(sb, entity, className, ClassDeclarationKind.AbstractShape, ctx);
        sb.AppendLine("{");

        var enumDecls = CollectEnumDecls(entity);

        // Body: scalar + enum + object-nav members, all WITHOUT EF mapping attributes
        // (a shape, not a table). When this abstract base extends another emitted base
        // (e.g. BaseAuditableEntity : BaseEntity), emit only its OWN fields — the rest come
        // through the C# base chain (mirrors the metadata `extends` chain).
        var inheritedNames = DirectMappedParent(entity, ctx.Config) is { } amp
            ? new HashSet<string>(amp.Fields().Select(f => f.Name), StringComparer.Ordinal)
            : new HashSet<string>(StringComparer.Ordinal);
        var members = new List<string>();
        foreach (var field in entity.Fields())
        {
            if (inheritedNames.Contains(field.Name)) continue; // inherited via the C# base chain
            string? member = null;
            if (CSharpNaming.ScalarFor(field.SubType) is not null)
                member = ScalarProperty(entity, field, [], withAttributes: false);
            else if (field.SubType == FIELD_SUBTYPE_ENUM)
                member = EnumProperty(entity, field, ctx.Config, ColumnNamingStrategy.Literal, withAttributes: false);
            else if (field.SubType == FIELD_SUBTYPE_OBJECT && ObjectNavProperty(entity, field, ctx) is { } nav)
                member = nav;
            if (member is null) continue;
            member = ApplyPropertyAttributes(member, entity, field, ctx);
            members.Add(XmlDocBuilder.Prepend(member, field, "    "));
        }

        if (enumDecls.Count > 0)
        {
            sb.Append(string.Join("\n", enumDecls));
            sb.AppendLine();
        }
        sb.Append(string.Join("\n", members));
        sb.AppendLine();
        EmitClassBodyTrailer(sb, entity, ctx);
        sb.AppendLine("}");
        return new EmittedFile($"{className}.g.cs", sb.ToString());
    }

    // Plain POCO for a value object nested by an owned-type navigation. No [Table] /
    // [Key]; column names are set in the DbContext's OwnsOne config (flattened) or are
    // opaque JSON property names (jsonb), so the POCO carries no mapping attributes.
    protected virtual EmittedFile EmitValueObjectPoco(MetaObject vo, GenContext ctx)
    {
        var className = CSharpNaming.Pascal(vo.Name);
        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects entity-generator (owned value object). Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System;");
        sb.AppendLine("using System.Collections.Generic;");
        // A VO's own members carry validation DataAnnotations ([Required]/[MaxLength]/etc.)
        // so a nested value-object is validated in FULL on POST/PATCH (Program D).
        sb.AppendLine("using System.ComponentModel.DataAnnotations;");
        // A value-object field with an explicit @column emits [Column(...)] — same as the entity
        // paths, so it needs the Schema namespace too (was omitted here → CS0246 on Column).
        sb.AppendLine("using System.ComponentModel.DataAnnotations.Schema;");
        // [JsonPropertyName] pins each VO member's jsonb element name (+ wire name) to the
        // metadata field name (camelCase). EF Core 8 owned-JSON (.ToJson) honors it, so the
        // stored jsonb keys match the shared seed + the wire contract cross-port (Program D).
        sb.AppendLine("using System.Text.Json.Serialization;");
        // A @dbColumnType:jsonb field surfaces as a System.Text.Json.JsonDocument (issue #98).
        if (CSharpNaming.RequiresSystemTextJson(vo))
            sb.AppendLine("using System.Text.Json;");
        // ADR-0036 Wave 3 — a field.inet surfaces as System.Net.IPAddress.
        if (CSharpNaming.RequiresSystemNet(vo))
            sb.AppendLine("using System.Net;");
        // FR-021 — usings for OTHER packages this value-object references (object navs + super).
        foreach (var ns in PackageBindingResolver.CrossPackageReferencedNamespaces(vo, ctx.Root, ctx.Config))
            sb.AppendLine($"using {ns};");
        EmitFileUsings(sb, vo, ctx);
        sb.AppendLine();
        sb.AppendLine($"namespace {PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(vo), vo.Name, fallbackContext: vo.Name)};");
        sb.AppendLine();
        XmlDocBuilder.AppendTo(sb, vo);
        EmitClassDeclarationLine(sb, vo, className, ClassDeclarationKind.ValueObject, ctx);
        sb.AppendLine("{");

        var enumDeclsVo = CollectEnumDecls(vo);

        var members = new List<string>();
        foreach (var field in vo.Fields())
        {
            string? member = null;
            if (CSharpNaming.ScalarFor(field.SubType) is not null)
                // VO POCO members carry NO EF-mapping attrs but DO carry validation
                // DataAnnotations (the VO is validated in full on POST/PATCH; Program D).
                member = ScalarProperty(vo, field, [], withAttributes: false, withValidationAttributes: true);
            else if (field.SubType == FIELD_SUBTYPE_ENUM)
                member = EnumProperty(vo, field, ctx.Config, ctx.Config.ColumnNamingStrategy);
            else if (field.SubType == FIELD_SUBTYPE_OBJECT && ObjectNavProperty(vo, field, ctx) is { } nav)
                member = nav;
            else if (field.SubType == FIELD_SUBTYPE_MAP)
                member = MapProperty(vo, field, ctx, withAttributes: false);
            if (member is null) continue;
            // Pin the jsonb element name (+ wire name) to the metadata field name so the
            // stored owned-JSON keys match the shared seed + the cross-port wire contract.
            member = $"    [JsonPropertyName(\"{field.Name}\")]\n" + member;
            member = ApplyPropertyAttributes(member, vo, field, ctx);
            members.Add(XmlDocBuilder.Prepend(member, field, "    "));
        }

        if (enumDeclsVo.Count > 0)
        {
            sb.Append(string.Join("\n", enumDeclsVo));
            sb.AppendLine();
        }
        sb.Append(string.Join("\n", members));
        sb.AppendLine();
        EmitClassBodyTrailer(sb, vo, ctx);
        sb.AppendLine("}");
        return new EmittedFile($"{className}.g.cs", sb.ToString());
    }

    // Collects nested C# enum declarations for all enum-subtype fields on an object,
    // deduplicating by type name so two fields that extend the same abstract enum emit
    // only one declaration (prevents CS0102 "already contains a definition for '<Name>'").
    //
    // FR-019: a field resolving to a SHARED (root-level abstract field.enum) enum is
    // SKIPPED here — that type is materialized once in Enums.g.cs (or, when @provided,
    // not at all) and merely REFERENCED. Inline enums (no root-abstract super) keep their
    // per-object nested declaration exactly as before (byte-identical default).
    protected static List<string> CollectEnumDecls(MetaObject owner)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var decls = new List<string>();
        foreach (var field in owner.Fields())
        {
            if (field.SubType != FIELD_SUBTYPE_ENUM) continue;
            if (Fr019SharedEnum.SharedEnumForField(field) is not null) continue; // shared/provided → referenced, not nested
            var values = field.EffectiveEnumValues;
            if (values is null || values.Count == 0) continue;
            var typeName = CSharpNaming.EnumTypeName(owner, field);
            if (!seen.Add(typeName)) continue;   // skip duplicate type names
            var members = string.Join(", ", values);
            decls.Add($"    public enum {typeName} {{ {members} }}");
        }
        return decls;
    }

    // FR-019 — the C# enum type a property of <field> is typed by:
    //   • shared (root-level abstract, non-@provided) → the bare materialized type name
    //     (same generated namespace as the entity).
    //   • @provided → <cfg.ProvidedEnumNamespace>.<Name> (codegen error if unset).
    //   • inline (the common case) → the per-object nested <Entity><Field> type name.
    private static string EnumPropertyTypeName(MetaObject owner, MetaField field, GenConfig config)
    {
        if (Fr019SharedEnum.SharedEnumForField(field) is { } shared)
            return Fr019SharedEnum.SharedEnumTypeReference(shared, config);
        return CSharpNaming.EnumTypeName(owner, field);
    }

    // FR-019 — the materialized shared-enums file (Enums.g.cs), emitted ONCE per run when
    // the model has ≥1 consumed, non-@provided root-level abstract field.enum. Returns null
    // (no file) otherwise — so a model with only inline enums is byte-identical to pre-FR-019.
    // Referencing a @provided enum with no ProvidedEnumNamespace configured throws here too
    // (the collect walk constructs each consuming reference's type), surfacing the config gap
    // as a codegen-time error before any file is written.
    protected virtual EmittedFile? EmitSharedEnumsFile(GenContext ctx)
    {
        // Surface a missing ProvidedEnumNamespace for any consumed @provided enum as a
        // codegen-time error (ADR-0026), even though @provided emits no file content.
        foreach (var shared in Fr019SharedEnum.CollectSharedEnums(ctx.Root))
            if (shared.Provided)
                _ = Fr019SharedEnum.SharedEnumTypeReference(shared, ctx.Config);

        var materialized = Fr019SharedEnum.MaterializedSharedEnums(ctx.Root);
        if (materialized.Count == 0) return null;

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects entity-generator (FR-019 shared enums). Do not edit by hand.");
        sb.AppendLine("// One declaration per reused package-level field.enum; consuming entities reference these.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine();
        // Shared enums file is a single artifact holding enums from MULTIPLE packages —
        // it can't live in a per-package namespace. Lands at the default Namespace.
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        foreach (var e in materialized)
            sb.AppendLine($"public enum {e.Name} {{ {string.Join(", ", e.Values)} }}");
        return new EmittedFile("Enums.g.cs", sb.ToString());
    }

    // Extension hook — invoked once per emitted property, AFTER the framework
    // attributes ([Key]/[Column]/[Required]/[MaxLength]/validators) and immediately
    // BEFORE the `public <type> <Prop> { get; ... }` line. The default body is empty
    // (no-op), so default output is byte-identical. Override to append per-property C#
    // attributes (e.g. `[ContainsPhi]`, `[ReportingField(...)]`) keyed off the field's
    // metadata. Each line written should carry the 4-space property indent.
    protected virtual void EmitPropertyAttributes(
        StringBuilder sb, MetaObject owner, MetaField field, GenContext ctx)
    {
        // No-op by default.
    }

    // Extension hook — invoked once per emitted file, AFTER the framework `using`
    // directives and BEFORE the blank line + `namespace`. The default body is empty
    // (no-op), so default output is byte-identical. Override to add adopter `using`
    // directives the emitted properties/attributes depend on (e.g. a namespace housing
    // a custom marker interface or per-property attribute). Each line written should be
    // a complete `using ...;` directive.
    protected virtual void EmitFileUsings(StringBuilder sb, MetaObject entity, GenContext ctx)
    {
        // No-op by default.
    }

    // Extension hook — invoked once per emitted file at the END of the class body,
    // immediately before the closing `}`. The default body is empty (no-op), so default
    // output is byte-identical. Override to append adopter members (extra methods,
    // partial-method hooks, computed properties) inside the generated class. Each line
    // written should carry the 4-space class-body indent.
    protected virtual void EmitClassBodyTrailer(StringBuilder sb, MetaObject entity, GenContext ctx)
    {
        // No-op by default.
    }

    // Splices the EmitPropertyAttributes hook output into an already-built member
    // string, immediately before its `    public ` declaration line (after the
    // framework attributes). When the hook is the default no-op the member is returned
    // unchanged, keeping default output byte-identical.
    private string ApplyPropertyAttributes(string member, MetaObject owner, MetaField field, GenContext ctx)
    {
        var hook = new StringBuilder();
        EmitPropertyAttributes(hook, owner, field, ctx);
        if (hook.Length == 0) return member;

        const string decl = "    public ";
        var idx = member.LastIndexOf(decl, StringComparison.Ordinal);
        if (idx < 0) return member; // no recognizable property line — leave untouched
        return member[..idx] + hook + member[idx..];
    }

    // A property for an enum-subtype field. The property type is the nested enum name.
    // When the field is an array, emit List<EnumType> with an empty-list initializer;
    // the List is never nullable (the column stores a jsonb array, always present).
    // withAttributes adds the EF [Column] mapping; abstract shape classes pass false
    // (shapes carry no EF mapping).
    protected virtual string EnumProperty(
        MetaObject entity, MetaField field, GenConfig config, ColumnNamingStrategy strategy, bool withAttributes = true)
    {
        // FR-019 — a shared/provided enum is referenced (materialized once / external);
        // an inline enum keeps the per-object nested <Entity><Field> type name.
        var typeName = EnumPropertyTypeName(entity, field, config);
        var propName = PropertyName(field);
        var colAttr = withAttributes ? $"    [Column(\"{CSharpNaming.Column(field, strategy)}\")]\n" : "";
        if (field.ResolvedIsArray()) // ADR-0039: resolving — array-ness inheritable via extends
            return $"{colAttr}    public ICollection<{typeName}> {propName} {{ get; set; }} = new List<{typeName}>();";
        var required = CSharpNaming.IsRequired(entity, field);
        var type = required ? typeName : typeName + "?";
        return $"{colAttr}    public {type} {propName} {{ get; set; }}";
    }

    // A scalar property. withAttributes adds the EF-mapping annotations ([Key] for a
    // single-column PK, [Column]); value-object POCOs omit them (column mapping is
    // fluent/JSON, not annotation-driven). withValidationAttributes controls the
    // DataAnnotations validation attrs ([Required]/[StringLength]/[MinLength]/
    // [MaxLength]/[Range]/[RegularExpression]) INDEPENDENTLY — a VO POCO carries these
    // (its members are validated on POST/PATCH — Program D) even though it carries NO
    // EF-mapping attrs; an attribute-free abstract shape carries neither. When null,
    // validation attrs follow withAttributes (mapped entities emit both, byte-identical
    // to before).
    //
    // When the field is an array (isArray: true), emit List<T> with an empty-list
    // initializer instead of a scalar T property. Arrays are always non-nullable
    // (the jsonb column holds the list; the list itself is never null in C#).
    protected virtual string ScalarProperty(
        MetaObject owner, MetaField field, IReadOnlyList<string> pkFields,
        bool withAttributes, ColumnNamingStrategy strategy = ColumnNamingStrategy.Literal,
        string? baseTypeOverride = null, bool? withValidationAttributes = null)
    {
        var emitValidation = withValidationAttributes ?? withAttributes;
        // A @dbColumnType:jsonb open-bag shifts the CLR property to a parsed JSON value
        // (JsonDocument) — issue #98 — taking precedence over the logical scalar. A uuid
        // override keeps the logical CLR type (converted at the DB seam). ScalarForField
        // resolves the ADR-0036 Wave 2 conditional field.timestamp binding (default
        // DateTimeOffset / @localTime:true DateTime).
        var baseType = CSharpNaming.DbColumnTypeClrOverride(field)
            ?? baseTypeOverride ?? CSharpNaming.ScalarForField(field)!;
        var propName = PropertyName(field);

        // Array fields: emit List<T> with an empty-list initializer and only a [Column]
        // attribute — [Key]/[MaxLength]/[Required] are not meaningful for a List<T> jsonb
        // column (arrays are never PKs, and the list itself is never null in C#).
        if (field.ResolvedIsArray()) // ADR-0039: resolving — array-ness inheritable via extends
        {
            var arr = new StringBuilder();
            if (withAttributes)
                arr.AppendLine($"    [Column(\"{CSharpNaming.Column(field, strategy)}\")]");
            // validator.array @min/@max → element-count bounds on the collection.
            if (emitValidation)
                AppendArrayValidatorAttributes(arr, field);
            arr.Append($"    public ICollection<{baseType}> {propName} {{ get; set; }} = new List<{baseType}>();");
            return arr.ToString();
        }

        var required = CSharpNaming.IsRequired(owner, field);
        var isValue = CSharpNaming.IsValueType(baseType);

        var sb = new StringBuilder();
        // EF-mapping attributes ([Key]/[Column]) — mapped entities only; a VO POCO's
        // JSON member mapping is fluent (.ToJson), so it carries none of these.
        if (withAttributes)
        {
            if (pkFields.Count == 1 && pkFields[0] == field.Name)
                sb.AppendLine("    [Key]");
            sb.AppendLine($"    [Column(\"{CSharpNaming.Column(field, strategy)}\")]");
        }
        // Validation DataAnnotations — mapped entities AND value-object POCOs (a VO's
        // own members are validated on POST/PATCH; Program D), never an attribute-free
        // abstract shape.
        if (emitValidation)
        {
            if (baseType == "string")
            {
                // FR-036 A1 — a @required string is NON-EMPTY, but whitespace-only is ACCEPTED
                // (owner ruling). The default [Required] TRIMS a string (rejecting whitespace);
                // instead allow empty strings at [Required] and enforce non-empty via a length
                // floor of 1, folded into the length validator (see AppendStringValidatorAttributes)
                // so a validator.length @min is not double-emitted.
                if (required)
                    sb.AppendLine("    [Required(AllowEmptyStrings = true)]");
                AppendStringValidatorAttributes(sb, field, requiredMinFloor: required ? 1 : 0);
            }
            else
            {
                AppendNumericValidatorAttributes(sb, field);
                if (required && !isValue)
                    sb.AppendLine("    [Required]");
            }
        }

        var type = required ? baseType : baseType + "?";
        // A literal-safe @default (bool / integer / floating / string) emits a property
        // initializer (e.g. `= false;`), taking precedence over the `= default!;` filler
        // for required reference types. @default is a cross-port metadata concept.
        var defaultInit = DefaultInitializer(field, baseType);
        var init = defaultInit.Length > 0
            ? defaultInit
            : (required && !isValue ? " = default!;" : string.Empty);
        // FR-013 — a @readOnly scalar is read-after-insert-only: EF materializes it on
        // read via a private setter; application code cannot write it, and the
        // DbContext excludes the column from INSERT / UPDATE (SetAfterSaveBehavior.Ignore).
        var setter = field.ReadOnly ? "get; private set;" : "get; set;";
        sb.Append($"    public {type} {propName} {{ {setter} }}{init}");
        return sb.ToString();
    }

    // String length + pattern DataAnnotations for a string scalar, combining the field
    // @maxLength attr with validator.length (@min/@max) and validator.regex (@pattern).
    //
    // Length: when both a validator.length @min AND a maximum (@maxLength or validator.length
    // @max) apply, emit a single [StringLength(max, MinimumLength = min)] — the form
    // TryValidateObject enforces on BOTH ends. Validator-@min-only → [MinLength]; max-only →
    // [MaxLength] (preserving the existing @maxLength semantics).
    //
    // FR-036 A3 — when @maxLength AND validator.length @max both apply, the effective max is
    // the STRICTEST (min of the two), not one-wins.
    //
    // FR-036 A1 — <paramref name="requiredMinFloor"/> is the non-empty floor for a @required
    // string (1). It combines with any validator.length @min as max(floor, @min): when a
    // validator @min is present the floor folds into it; when it is not, the floor becomes a
    // standalone [MinLength] alongside the [MaxLength] (so the max attribute is undisturbed).
    protected static void AppendStringValidatorAttributes(
        StringBuilder sb, MetaField field, long requiredMinFloor = 0)
    {
        // ADR-0036 Wave 3 — @stringFormat narrows a plain string to a closed validated
        // format. The canonical matcher per format lives HERE (codegen), never author
        // validator.regex (cross-language regex engines diverge). The field stays a plain
        // string: email → [EmailAddress]; hostname → the canonical RFC-1123 [RegularExpression].
        // ADR-0039: resolving — @stringFormat may be inherited via extends (TS reads field.attr).
        switch (field.Attr(FIELD_ATTR_STRING_FORMAT) as string)
        {
            case STRING_FORMAT_EMAIL:
                sb.AppendLine("    [EmailAddress]");
                break;
            case STRING_FORMAT_HOSTNAME:
                sb.AppendLine($"    [RegularExpression(@\"{CSharpNaming.HostnameRegex}\")]");
                break;
        }

        long? validatorMin = null;
        long? max = field.MaxLength;
        foreach (var v in field.Validators())
        {
            if (v.SubType == VALIDATOR_SUBTYPE_LENGTH)
            {
                if (v.Min is long lmin)
                    validatorMin = validatorMin is long curMin ? System.Math.Max(curMin, lmin) : lmin;
                // FR-036 A3 — strictest-wins: effective max = min(@maxLength, validator.length @max).
                if (v.Max is long lmax)
                    max = max is long curMax ? System.Math.Min(curMax, lmax) : lmax;
            }
            else if (v.SubType == VALIDATOR_SUBTYPE_REGEX
                     && v is MetaRegexValidator { Pattern: { } pattern })
            {
                // FR-036 Pin-2 — ALWAYS anchor the emitted pattern as a FULL match ^(?:…)$.
                // .NET's RegularExpressionAttribute is valid only when the match starts at
                // index 0 AND spans the whole value; for an UNanchored ordered-alternation
                // whose earlier branch is a prefix of a later one (e.g. (a|ab) vs "ab") the
                // engine matches the shorter branch ("a", length 1 ≠ 2) and REJECTS a string
                // the anchored TS/Python (^(?:…)$) and Java/Kotlin (Matcher.matches) ports
                // ACCEPT. Wrapping forces the engine to backtrack to a full match. Redundant
                // on an already-anchored authored pattern (^(?:^…$)$ matches identically).
                sb.AppendLine($"    [RegularExpression(\"^(?:{EscapeAttrString(pattern)})$\")]");
            }
        }

        // FR-036 A1 — fold the @required non-empty floor into the min (max(floor, @min)).
        long? min = validatorMin;
        if (requiredMinFloor > 0)
            min = min is long m ? System.Math.Max(m, requiredMinFloor) : requiredMinFloor;

        if (min is long mn && max is long mx)
        {
            // A validator.length @min + a max → a single [StringLength] gating both ends.
            // A pure required-floor min (no validator @min) keeps [MaxLength] and adds a
            // standalone [MinLength], leaving the max attribute unchanged.
            if (validatorMin is not null)
                sb.AppendLine($"    [StringLength({mx}, MinimumLength = {mn})]");
            else
            {
                sb.AppendLine($"    [MaxLength({mx})]");
                sb.AppendLine($"    [MinLength({mn})]");
            }
        }
        else if (min is long mn2)
            sb.AppendLine($"    [MinLength({mn2})]");
        else if (max is long mx2)
            sb.AppendLine($"    [MaxLength({mx2})]");
    }

    // Numeric value bounds for a non-string scalar: validator.numeric (@min/@max) →
    // [Range(min, max)]. Both bounds present in the canonical corpus; when only one is
    // declared the other defaults to the type's extreme so the single bound still gates.
    protected static void AppendNumericValidatorAttributes(StringBuilder sb, MetaField field)
    {
        foreach (var v in field.Validators())
        {
            if (v.SubType != VALIDATOR_SUBTYPE_NUMERIC) continue;
            if (v.Min is null && v.Max is null) continue;
            long lo = v.Min ?? long.MinValue;
            long hi = v.Max ?? long.MaxValue;
            sb.AppendLine($"    [Range({lo}, {hi})]");
            return;
        }
    }

    // Element-count bounds for an array field: validator.array (@min/@max) →
    // [MinLength(min)] + [MaxLength(max)] on the List<T> property.
    protected static void AppendArrayValidatorAttributes(StringBuilder sb, MetaField field)
    {
        foreach (var v in field.Validators())
        {
            if (v.SubType != VALIDATOR_SUBTYPE_ARRAY) continue;
            if (v.Min is long amin) sb.AppendLine($"    [MinLength({amin})]");
            if (v.Max is long amax) sb.AppendLine($"    [MaxLength({amax})]");
            return;
        }
    }

    // A C# property-initializer (` = <literal>;`) for a field's @default, or "" when
    // there is no @default or the type isn't literal-safe. Scoped to bool / integer /
    // floating / string (+ their nullable wrappers — the `?` is on the property type,
    // not the initializer). enum / temporal / uuid / object defaults are NOT emitted as
    // initializers here. The literal carries the right C# suffix (L / f / m) so it
    // compiles for long / float / decimal targets.
    protected static string DefaultInitializer(MetaField field, string baseType)
    {
        var raw = field.Default;
        if (raw is null) return string.Empty;
        switch (baseType)
        {
            case "bool":
                var b = raw is bool bv
                    ? bv
                    : string.Equals(raw.ToString(), "true", StringComparison.OrdinalIgnoreCase);
                return b ? " = true;" : " = false;";
            case "string":
                return $" = \"{EscapeAttrString(raw.ToString() ?? string.Empty)}\";";
            case "int":
            case "short":
            case "byte":
                return NumericLiteral(raw) is { } i ? $" = {i};" : string.Empty;
            case "long":
                return NumericLiteral(raw) is { } l ? $" = {l}L;" : string.Empty;
            case "double":
                return NumericLiteral(raw) is { } d ? $" = {d};" : string.Empty;
            case "float":
                return NumericLiteral(raw) is { } f ? $" = {f}f;" : string.Empty;
            case "decimal":
                return NumericLiteral(raw) is { } m ? $" = {m}m;" : string.Empty;
            default:
                return string.Empty;
        }
    }

    // The invariant string form of a numeric default, or null if it isn't a clean
    // number (so a malformed @default never injects garbage into the initializer).
    // Preserves the authored digits (e.g. "5.50") rather than round-tripping.
    private static string? NumericLiteral(object raw)
    {
        var s = raw.ToString();
        if (string.IsNullOrEmpty(s)) return null;
        return decimal.TryParse(s, System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out _) ? s : null;
    }

    // Escapes a regex pattern for embedding in a C# string-literal attribute argument.
    protected static string EscapeAttrString(string s) =>
        s.Replace("\\", "\\\\").Replace("\"", "\\\"");

    // An owned-type navigation property for an object-typed field. Returns null (with
    // a warning) when the @objectRef can't be resolved.
    protected string? ObjectNavProperty(MetaObject owner, MetaField field, GenContext ctx)
    {
        if (field.ObjectRef is not { } oref || ctx.Root.FindObject(CSharpNaming.StripPkg(oref)) is not { } target)
        {
            ctx.Warn($"{Name}: object-typed field \"{owner.Name}.{field.Name}\" has an unresolved @objectRef \"{field.ObjectRef}\" — skipped.");
            return null;
        }
        var typeName = CSharpNaming.Pascal(target.Name);
        var propName = PropertyName(field);
        var required = CSharpNaming.IsRequired(owner, field);
        // An object-typed field with @isArray:true is a COLLECTION of the value object
        // (EF maps it via .OwnsMany(...).ToJson(...)), not a single nullable ref. A REQUIRED
        // array is a non-null collection with an empty-list initializer (never null). A
        // NON-required array is a NULLABLE collection with NO initializer, so an absent value
        // stays a NULL jsonb column (distinct from an explicit empty `[]`) — mirroring the
        // single-VO nullability below. A non-null empty-list default would erase that
        // null-vs-empty distinction (EF re-serializes the empty list to `[]` on write).
        if (field.ResolvedIsArray()) // ADR-0039: resolving — array-ness inheritable via extends
            return required
                ? $"    public ICollection<{typeName}> {propName} {{ get; set; }} = new List<{typeName}>();"
                : $"    public ICollection<{typeName}>? {propName} {{ get; set; }}";
        return required
            ? $"    public {typeName} {propName} {{ get; set; }} = default!;"
            : $"    public {typeName}? {propName} {{ get; set; }}";
    }

    // A property for a field.map (an open-keyed map). Emits a single
    // Dictionary<string, V> property stored in one json column — the map analog of
    // ObjectNavProperty's single-jsonb-column object field. Keys are always strings;
    // V is a value-object (@objectRef) or a scalar (@valueType, defaulting to string).
    // isArray does not apply (a map is never wrapped in a collection-of-maps), so the
    // property is a non-null dictionary with an empty-dictionary initializer (matching
    // the array/enum-array convention — the dictionary itself is never null in C#).
    // When @objectRef names a value object, the resolved VO becomes a referenced POCO
    // via the normal ReferencedValueObjects walk. withAttributes adds the EF [Column]
    // mapping; value-object POCOs (no EF mapping) pass false.
    protected string MapProperty(MetaObject owner, MetaField field, GenContext ctx, bool withAttributes = true)
    {
        var valueType = CSharpNaming.MapValueType(field);
        var propName = PropertyName(field);
        var colAttr = withAttributes ? $"    [Column(\"{CSharpNaming.Column(field, ctx.Config.ColumnNamingStrategy)}\")]\n" : "";
        return $"{colAttr}    public Dictionary<string, {valueType}> {propName} {{ get; set; }} = new();";
    }

    // The CLR scalar type for a projection field whose value is a MIN/MAX aggregate:
    // the result type of MIN(col)/MAX(col) in SQL is the aggregated column's own type,
    // NOT the (often-widened) field.* declaration. e.g. MIN over an INTEGER column is
    // INTEGER — so the projection property must materialize as `int`, which the read
    // path then surfaces as a JSON number (vs. a BIGINT → string). COUNT/SUM widen to
    // BIGINT and AVG to NUMERIC, both already matched by the declared field.* type, so
    // only MIN/MAX need the source-type narrowing. Returns null (use the declared type)
    // for non-aggregate fields, non-MIN/MAX aggregates, or an unresolvable @of target.
    protected static string? AggregateResultScalar(MetaField field, GenContext ctx)
    {
        var agg = field.Children().OfType<MetaAggregateOrigin>().FirstOrDefault();
        if (agg?.Agg is not (AGGREGATE_FN_MIN or AGGREGATE_FN_MAX)) return null;
        // @of is a dotted "Entity.field" reference to the aggregated column.
        if (agg.Of is not { } of) return null;
        var dot = of.LastIndexOf('.');
        if (dot <= 0 || dot == of.Length - 1) return null;
        var sourceObj = ctx.Root.FindObject(CSharpNaming.StripPkg(of[..dot]));
        var sourceField = sourceObj?.FindField(of[(dot + 1)..]);
        return sourceField is null ? null : CSharpNaming.ScalarForField(sourceField);
    }

    // True for the fields that reference a value-object by @objectRef and so contribute
    // a VO to the referenced-POCO closure: a field.object (a single nested VO) OR a
    // field.map with @objectRef (a Dictionary<string, VO>). A scalar-valued field.map
    // (@valueType) references no VO.
    private static bool ReferencesValueObject(MetaField f) =>
        (f.SubType == FIELD_SUBTYPE_OBJECT || f.SubType == FIELD_SUBTYPE_MAP) && f.ObjectRef is not null;

    // Transitive closure of plain value objects reachable through entity object-fields.
    protected static List<MetaObject> ReferencedValueObjects(IReadOnlyList<MetaObject> mapped, GenContext ctx)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<MetaObject>();
        var queue = new Queue<MetaObject>();

        // Seed from entity object-/map-fields (projections handled separately).
        foreach (var e in mapped.Where(o => o.IsEntity() && !o.IsReadOnlyProjection()))
            foreach (var f in e.Fields().Where(ReferencesValueObject))
                Enqueue(f.ObjectRef);

        // FR-015: a callable's args value object is referenced via source.rdb @parameterRef
        // (not by any entity object-field), so the field-walk above never reaches it. Seed it
        // too, or the CallableGenerator wrapper (which takes the args VO as a parameter) won't
        // compile. All mapped objects are eligible — a callable entity is in `mapped`.
        foreach (var e in mapped)
            foreach (var src in e.Sources())
                if (src.ParameterRef is { } pref)
                    Enqueue(pref);

        while (queue.Count > 0)
        {
            var vo = queue.Dequeue();
            result.Add(vo);
            foreach (var f in vo.Fields().Where(ReferencesValueObject))
                Enqueue(f.ObjectRef);
        }
        return result.OrderBy(o => o.Name, StringComparer.Ordinal).ToList();

        void Enqueue(string? objectRef)
        {
            if (objectRef is null) return;
            var target = ctx.Root.FindObject(CSharpNaming.StripPkg(objectRef));
            // Only plain value objects (no source) become POCOs; entities/projections
            // are already in `mapped`.
            if (target is null || !target.IsValue() || target.DbView is not null) return;
            if (seen.Add(target.Name)) queue.Enqueue(target);
        }
    }
}
