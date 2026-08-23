// dbcontext-generator — emits a single EF Core DbContext: a DbSet per persisted
// object (tables + read-only projections) plus an OnModelCreating that maps each
// projection to its view (.ToView / .HasNoKey) and configures owned types for
// object-typed entity fields (@storage flattened → per-property column names;
// jsonb / subdocument / absent → a single json column via .ToJson), and uses
// .PrimitiveCollection() for scalar/enum array fields (EF Core 8 API).

using System.Text;
using MetaObjects.Codegen.Docs;
using MetaObjects.Meta;
using MetaObjects.Persistence.Db;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Relationship.RelationshipConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>
/// Generates one <c>AppDbContext</c> over the entities + projections.
///
/// Open for extension (ADR-0002): <see cref="Name"/> + <see cref="Generate"/> are
/// <c>public virtual</c>, and the file body is assembled through three
/// <c>protected virtual</c> seams — <see cref="EmitUsings"/> (header + usings +
/// namespace + class/ctor open), <see cref="EmitDbSetDeclarations"/> (the
/// <c>DbSet</c> properties), and <see cref="EmitOnModelCreatingBody"/> (the
/// <c>OnModelCreating</c> block). The default bodies reproduce the inline emission
/// exactly, so the default output is byte-identical.
/// </summary>
public class DbContextGenerator : IGenerator
{
    public virtual string Name => "dbcontext-generator";

    /// <summary>
    /// True iff this object gets a DbSet on the generated AppDbContext: a persisted
    /// entity/projection (<c>IsEntity() || DbView != null</c>) that emits instance
    /// artifacts (not abstract) and is NOT a TPH subtype (subtypes share the base's
    /// table, reached via <c>.OfType&lt;Sub&gt;()</c>). Single source of truth shared by
    /// the generator loop AND the api-docs builder (so docs never claim a suppressed DbSet).
    /// </summary>
    public static bool AppliesTo(MetaObject obj, MetaRoot root) =>
        (obj.IsEntity() || obj.DbView is not null)
        && InstanceArtifacts.EmitsInstanceArtifacts(obj)
        && !TphPlanBuilder.IsTphSubtype(obj, root);

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        // FR-017 TPH: a concrete subtype shares the base's single table — it gets NO
        // DbSet and no per-subtype model config; the hierarchy is reached via the base
        // DbSet (`.OfType<Sub>()`). Filter subtypes out of the emitted set entirely.
        var objects = ctx.Entities
            .Where(o => AppliesTo(o, ctx.Root))
            .OrderBy(o => o.Name, StringComparer.Ordinal)
            .ToList();
        if (objects.Count == 0) return [];

        // OnModelCreating body lines (8-space indented), in a stable order.
        var modelLines = new List<string>();

        // #294 — entities serving as an M:N junction have BOTH their FK sides configured
        // by UsingEntityConfig below (that call is what establishes those relationships).
        // Emitting a standalone HasOne/WithMany for the same junction column would
        // configure the same foreign key a second time, so the per-reference pass skips
        // them. Self-joins are excluded here because their navigation is [NotMapped]
        // (route-traversed) and therefore gets NO UsingEntity call — the junction's own
        // references are the only thing that can carry its actions.
        var m2mJunctions = new HashSet<string>(
            objects.Where(o => o.IsEntity())
                .SelectMany(o => M2MNavigationBuilder.For(o, ctx.Root))
                .Where(n => !n.IsSelfJoin)
                .Select(n => n.Junction.Name),
            StringComparer.Ordinal);
        foreach (var p in objects.Where(o => o.IsReadOnlyProjection()))
        {
            var name = CSharpNaming.Pascal(p.Name);
            var noKey = p.PrimaryIdentity() is null ? ".HasNoKey()" : string.Empty;
            modelLines.Add($"        modelBuilder.Entity<{name}>(){noKey}.ToView(\"{p.DbView}\");");
            // Enum-typed projection columns persist as their string symbol in the view
            // (string-backed enums, CHECK-constrained varchar/text). Without an explicit
            // string conversion EF defaults to the int-ordinal mapping and reads the text
            // column as Int32 at materialization — an InvalidCastException. Mirror the
            // entity-side HasConversion<string>() so a projection that passes an enum
            // through (e.g. ProgramView.status over v_program) round-trips.
            // An int-backed enum (@intValueMap) column in the view holds the declared INTEGER,
            // so it takes the same custom converter pair the table side gets — reading it as
            // a string would fail materialization exactly as the ordinal default does here.
            foreach (var f in p.Fields().Where(f => f.SubType == FIELD_SUBTYPE_ENUM && !f.ResolvedIsArray()))
                modelLines.Add($"        modelBuilder.Entity<{name}>().Property(x => x.{CSharpNaming.Pascal(f.Name)}).{EnumConversionCall(name, p, f, ctx.Config)};");
        }
        foreach (var e in objects.Where(o => o.IsEntity() && !o.IsReadOnlyProjection()))
        {
            var owner = CSharpNaming.Pascal(e.Name);
            // #214 — for a write-through entity these config lines target the WRITE (table)
            // class, which omits the derived (origin.*) fields; so must the config, or it
            // would reference properties the write class does not declare (a compile error).
            // The derived fields' EF mapping lives on the read model (registered below).
            IEnumerable<MetaField> configFields = e.IsWriteThrough()
                ? e.Fields().Where(f => !f.IsDerived())
                : e.Fields();
            // #214 [0] — the per-field EF TYPE converters (owned-VO / enum / primitive
            // collection / decimal precision / timestamp column type / field.uri / field.inet /
            // @dbColumnType) over the write entity's derived-EXCLUDED field set. The SAME helper
            // configures a write-through entity's <Entity>View read model (all fields) below, so
            // the read model gets the identical type converters (else EF Core fails model
            // finalization on a field.uri / @dbColumnType:uuid column). jsonbObjectsOnly:false —
            // the write entity carries flattened VOs too (its per-column spread is mapped here).
            EmitFieldTypeConfig(owner, e, configFields, ctx, modelLines, jsonbObjectsOnly: false);

            // FR-037 R1 — both non-readWrite modes are excluded from UPDATE, which EF
            // expresses the same way: SetAfterSaveBehavior(Ignore). They differ on INSERT,
            // and that difference lives in the PROPERTY, not here:
            //   readOnly  — private setter (EntityGenerator), so application code cannot
            //               supply a value on insert either; the DB / trigger / default owns it.
            //   writeOnce — public setter, so the caller sets it exactly once on insert;
            //               frozen from then on.
            foreach (var f in configFields.Where(f => !f.ResolvedIsArray()
                                                      && f.Mutability != MUTABILITY_READ_WRITE))
            {
                var prop = CSharpNaming.Pascal(f.Name);
                modelLines.Add(
                    $"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).Metadata.SetAfterSaveBehavior(PropertySaveBehavior.Ignore);");
            }

            // FR-018 M:N — wire a hetero (source != target) navigation as an EF skip
            // navigation through the explicit junction entity:
            //   HasMany(x => x.<Nav>).WithMany().UsingEntity<Through>(
            //       l => l.HasOne<Target>().WithMany().HasForeignKey("<TargetFkProp>"),
            //       r => r.HasOne<Source>().WithMany().HasForeignKey("<SourceFkProp>"));
            // Self-joins (directed/symmetric) are [NotMapped] (route-traversed) — see
            // EntityGenerator.M2mNavProperty — so they are skipped here.
            foreach (var nav in M2MNavigationBuilder.For(e, ctx.Root).Where(n => !n.IsSelfJoin))
                modelLines.Add(UsingEntityConfig(nav, ctx));

            // FR-017 TPH — single-table inheritance mapping. The base maps its concrete
            // subtypes onto the shared table via the discriminator property:
            //   HasDiscriminator(e => e.<DiscProp>).HasValue<Sub>(<EnumType>.<Value>)...
            // The discriminator property is the entity's @discriminator field (an enum);
            // its HasConversion<string>() (emitted by the enum loop above) stores the
            // symbol as text, matching the TS-owned TEXT column. EF folds every subtype's
            // own columns into the base table as nullable.
            var tph = TphPlanBuilder.For(e, ctx.Root);
            if (tph is not null)
                modelLines.Add(HasDiscriminatorConfig(owner, e, tph));

            // ADR-0047 / #294 — explicit 1:N relationship configuration, with the
            // referential action INLINE on the call that establishes the foreign key.
            // Without this EF Core sees no relationship at all for a plain reference (the
            // generated class carries a bare scalar FK property and no navigation), so
            // every DeleteBehavior fell back to EF's own convention regardless of what the
            // metadata — or the database — said. A junction's sides are owned by
            // UsingEntityConfig; see the m2mJunctions note above.
            if (!m2mJunctions.Contains(e.Name))
                EmitReferenceConfig(owner, e, tph, ctx, modelLines);
        }

        // #214 (FR-024 §7) — register the write-through read model against its replica view.
        // It is a SECOND CLR type (the write entity maps the table above); reads route here.
        // Keyed (its primary identity) so a create/update can re-read the row by PK — no
        // .HasNoKey(). String-backed enum columns need the same HasConversion<string>() the
        // table side gets, or EF reads the text column as an int ordinal at materialization.
        foreach (var wt in objects.Where(o => o.IsEntity() && o.IsWriteThrough()))
        {
            var view = CSharpNaming.ViewModelClassName(wt);
            modelLines.Add($"        modelBuilder.Entity<{view}>().ToView(\"{wt.ReplicaViewName}\");");
            // #214 [0] — the read model exposes ALL fields (incl. the derived origin.* fields),
            // so it needs the SAME per-field TYPE converters the write entity gets, or EF Core
            // fails model finalization (a field.uri / @dbColumnType:uuid / decimal-precision /
            // timestamp / jsonb-VO column on the view → the DbContext can't build → every
            // endpoint 500s). The WRITE-ONLY configs (@readOnly SetAfterSaveBehavior, M:N
            // UsingEntity, TPH HasDiscriminator) do NOT apply — a view is never written.
            // jsonbObjectsOnly:true restricts the owned-VO config to the non-flattened
            // (single-jsonb-column) VO columns the <Entity>View class actually declares
            // (a flattened VO is out of scope on the write-through view; #214 note).
            EmitFieldTypeConfig(view, wt, wt.Fields(), ctx, modelLines, jsonbObjectsOnly: true);
        }

        // FR-013 — PropertySaveBehavior (used by the @readOnly SetAfterSaveBehavior config)
        // lives in Microsoft.EntityFrameworkCore.Metadata. Emit that using only when a
        // read-only field is present so models without one stay byte-identical.
        var needsMetadataUsing = objects
            .Where(o => o.IsEntity() && !o.IsReadOnlyProjection())
            .Any(o => o.Fields().Any(f => !f.ResolvedIsArray()
                                          && f.Mutability != MUTABILITY_READ_WRITE));

        var sb = new StringBuilder();
        EmitUsings(sb, needsMetadataUsing, ctx);
        EmitDbSetDeclarations(sb, objects, ctx);
        EmitOnModelCreatingBody(sb, modelLines, ctx);
        if (NeedsUnmappedEnumHelper(objects)) EmitUnmappedEnumHelper(sb);
        sb.AppendLine("}");
        return [new EmittedFile("AppDbContext.g.cs", sb.ToString())];
    }

    /// <summary>
    /// Extension hook — emits the file header, usings, namespace, and the opening of
    /// the <c>public class AppDbContext : DbContext</c> declaration through its primary
    /// constructor (leaving the class body open for <see cref="EmitDbSetDeclarations"/>
    /// + <see cref="EmitOnModelCreatingBody"/>; the caller emits the closing <c>}</c>).
    /// <paramref name="needsMetadataUsing"/> is true when a <c>@readOnly</c> field
    /// requires the <c>Microsoft.EntityFrameworkCore.Metadata</c> import. The default
    /// body reproduces the inline emission, so default output is byte-identical.
    /// Override to add usings, a base interface, or class-level attributes.
    /// </summary>
    protected virtual void EmitUsings(StringBuilder sb, bool needsMetadataUsing, GenContext ctx)
    {
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects dbcontext-generator. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using Microsoft.EntityFrameworkCore;");
        if (needsMetadataUsing)
            sb.AppendLine("using Microsoft.EntityFrameworkCore.Metadata;");
        // Package-binding — pull in every per-package namespace the model uses. The DbContext
        // references EVERY entity by short name (DbSet<X>, modelBuilder.Entity<X>()),
        // so it needs a `using` for each distinct namespace the entities resolve to.
        var dbCtxNs = ctx.Config.Namespace;
        var refNamespaces = ctx.Entities
            .Where(o => o.IsEntity() || o.DbView is not null)
            .Select(o => PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(o), o.Name))
            .Where(ns => !string.IsNullOrEmpty(ns) && ns != dbCtxNs)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(ns => ns, StringComparer.Ordinal);
        foreach (var ns in refNamespaces)
            sb.AppendLine($"using {ns};");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.AppendLine("public class AppDbContext : DbContext");
        sb.AppendLine("{");
        sb.AppendLine("    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }");
        sb.AppendLine();
    }

    /// <summary>
    /// Extension hook — emits one <c>public DbSet&lt;Entity&gt; Plural { get; set; }</c>
    /// (with its XML doc) per persisted object/projection, in the order computed by
    /// <see cref="Generate"/>. The default body reproduces the inline emission, so
    /// default output is byte-identical.
    /// </summary>
    protected virtual void EmitDbSetDeclarations(StringBuilder sb, IReadOnlyList<MetaObject> objects, GenContext ctx)
    {
        foreach (var o in objects)
        {
            var name = CSharpNaming.Pascal(o.Name);
            XmlDocBuilder.AppendTo(sb, o, indent: "    ");
            sb.AppendLine($"    public DbSet<{name}> {CSharpNaming.Pluralize(name)} {{ get; set; }} = default!;");
            // #214 — a write-through entity additionally exposes a read-model DbSet mapped to
            // its replica view (reads route here; the derived fields live on the view row).
            if (o.IsWriteThrough())
            {
                var view = CSharpNaming.ViewModelClassName(o);
                sb.AppendLine($"    /// <summary>Read-model view for write-through entity {name} (reads route here; carries the derived fields).</summary>");
                sb.AppendLine($"    public DbSet<{view}> {CSharpNaming.ViewDbSetName(o)} {{ get; set; }} = default!;");
            }
        }
    }

    /// <summary>
    /// Extension hook — emits the <c>OnModelCreating</c> override carrying the
    /// precomputed <paramref name="modelLines"/> (owned-type / enum-conversion /
    /// precision / TPH / M:N config), in stable order. When there are no model lines
    /// the block is omitted entirely. The default body reproduces the inline emission,
    /// so default output is byte-identical.
    /// </summary>
    protected virtual void EmitOnModelCreatingBody(StringBuilder sb, IReadOnlyList<string> modelLines, GenContext ctx)
    {
        if (modelLines.Count == 0) return;
        sb.AppendLine();
        sb.AppendLine("    protected override void OnModelCreating(ModelBuilder modelBuilder)");
        sb.AppendLine("    {");
        foreach (var line in modelLines) sb.AppendLine(line);
        sb.AppendLine("    }");
    }

    // R6 Plan 2b — EF mapping for a @dbColumnType physical-override field. The CLR
    // property type is unchanged (the logical field's native binding); only the DB
    // column type — and, for uuid, a string↔Guid value converter — is configured so
    // the native column round-trips. Pairing legality is already loader-validated.
    //
    //   uuid              (on field.string)    → native `uuid` column + string↔Guid
    //                                            converter. The read side renders the
    //                                            Guid lowercase-canonical (Guid.ToString("D"))
    //                                            so the wire form is enforced by the port,
    //                                            not assumed from the DB.
    //   jsonb             (on field.string)    → native `jsonb` column; Npgsql maps the
    //                                            raw JSON text ↔ string directly.
    // (ADR-0036 Wave 2: the retired timestamp_with_tz override is gone — timezone-awareness
    //  is the field.timestamp default, opted out of via @localTime; handled above.)
    private static string? DbColumnTypeConfig(string owner, MetaField f)
    {
        var prop = CSharpNaming.Pascal(f.Name);
        var lhs = $"        modelBuilder.Entity<{owner}>().Property(x => x.{prop})";
        return f.DbColumnType switch
        {
            // `v!` is safe even for a nullable `string?` property: EF Core skips
            // value-converter invocation for null (null↔NULL), so Guid.Parse(null)
            // never runs.
            // System.Guid FULLY QUALIFIED — the AppDbContext carries no `using System;`
            // (see the field.uri note above); an unqualified `Guid.Parse` in OnModelCreating
            // would only compile under a host's ImplicitUsings.
            DbConstants.DB_COLUMN_TYPE_UUID =>
                lhs + ".HasColumnType(\"uuid\").HasConversion(v => System.Guid.Parse(v!), g => g.ToString(\"D\"));",
            DbConstants.DB_COLUMN_TYPE_JSONB =>
                lhs + ".HasColumnType(\"jsonb\");",
            _ => null,
        };
    }

    // FR-017 — EF TPH single-table inheritance config for a discriminator base. The
    // discriminator property is the base's @discriminator field (PascalCased); the
    // HasValue clauses bind each concrete subtype to its @discriminatorValue. When the
    // discriminator field is an enum (the canonical shape) the HasValue argument is the
    // enum literal (<EnumType>.<Value>), which round-trips through the enum's
    // HasConversion<string>() as the text symbol; otherwise the raw string value.
    private static string HasDiscriminatorConfig(string owner, MetaObject baseEntity, TphPlan tph)
    {
        var discField = baseEntity.FindField(tph.DiscriminatorField);
        var discProp = CSharpNaming.Pascal(tph.DiscriminatorField);
        var isEnum = discField is not null && discField.SubType == FIELD_SUBTYPE_ENUM;
        // The enum type is nested in the base class, so qualify it (<Base>.<EnumType>)
        // when referenced from the DbContext (a sibling type).
        var enumType = discField is not null && isEnum
            ? $"{owner}.{CSharpNaming.EnumTypeName(baseEntity, discField)}" : null;

        var sb = new StringBuilder();
        sb.Append($"        modelBuilder.Entity<{owner}>().HasDiscriminator(e => e.{discProp})");
        foreach (var st in tph.Subtypes)
        {
            var subCls = CSharpNaming.Pascal(st.Entity.Name);
            var valueLit = isEnum ? $"{enumType}.{st.Value}" : $"\"{st.Value}\"";
            sb.Append($".HasValue<{subCls}>({valueLit})");
        }
        sb.Append(';');
        return sb.ToString();
    }

    /// <summary>
    /// ADR-0047 / #294 — emit one explicit EF relationship per enforced
    /// <c>identity.reference</c>, so EF Core actually HAS the foreign key the metadata
    /// declares and the referential action can ride on the establishing call:
    ///
    /// <code>
    /// modelBuilder.Entity&lt;Week&gt;().HasOne&lt;Program&gt;().WithMany()
    ///     .HasForeignKey(nameof(Week.ProgramId)).OnDelete(DeleteBehavior.Cascade);
    /// </code>
    ///
    /// <para>Inline, never a post-hoc <c>GetForeignKeys().Single(...)</c> mutation: TPH
    /// relationship reconciliation runs AFTER <c>OnModelCreating</c> returns and can
    /// replace the FK metadata object, so a later mutation is silently discarded for a
    /// base+subtype dual-declared FK (#294's repro). Configuring the relationship as it
    /// is established is durable by construction.</para>
    ///
    /// <para><c>WithMany()</c> is left inverse-less: the port emits no reverse collection
    /// navigations at all (ADR-0038 replaced them with explicit FK finders), so there is
    /// no navigation to name on either side.</para>
    ///
    /// <para>TPH: the base's own pass covers the shared table's references. A concrete
    /// subtype may additionally declare its OWN reference (folded into the base's single
    /// table), so each subtype contributes only what it declares itself — and only when
    /// the base did not already configure the same FK columns, which is exactly the
    /// base+subtype dual declaration that made the adopter's mutation unreliable.</para>
    /// </summary>
    private void EmitReferenceConfig(
        string owner, MetaObject entity, TphPlan? tph, GenContext ctx, List<string> modelLines)
    {
        var emitted = new HashSet<string>(StringComparer.Ordinal);

        foreach (var reference in entity.ReferenceIdentities().Where(r => r.Enforce))
            if (ReferenceConfig(owner, entity, reference, ctx) is { } line)
            {
                modelLines.Add(line);
                emitted.Add(FkKey(reference));
            }

        if (tph is null) return;
        foreach (var st in tph.Subtypes)
        {
            // ADR-0039 sanctioned own-accessor case: the base's resolving pass above
            // already emitted every inherited reference. Reading the subtype RESOLVED
            // would re-emit each of them once per subtype — the duplicate configuration
            // this fix exists to avoid.
            foreach (var reference in st.Entity.OwnIdentities()
                         .OfType<MetaReferenceIdentity>().Where(r => r.Enforce))
            {
                if (!emitted.Add(FkKey(reference))) continue;
                if (ReferenceConfig(CSharpNaming.Pascal(st.Entity.Name), st.Entity, reference, ctx) is { } line)
                    modelLines.Add(line);
            }
        }
    }

    /// <summary>
    /// Identity of the physical foreign key a reference defines: its ordered FK field
    /// names. A TPH subtype re-declaring its base's reference (to add an inverse, or just
    /// restating it) produces the same key, so the shared column is configured once.
    /// </summary>
    private static string FkKey(MetaReferenceIdentity reference) =>
        string.Join(",", ReferentialActions.ReadIdentityFields(reference));

    /// <summary>
    /// The relationship-configuration line for one reference, or <c>null</c> when it
    /// cannot be expressed: an unresolvable / non-persisted target, or an FK field the
    /// emitted class does not declare. Silent by design — a dangling <c>@references</c>
    /// is already a load error, and the other cases are shapes this generator
    /// deliberately does not map.
    /// </summary>
    private string? ReferenceConfig(
        string owner, MetaObject entity, MetaReferenceIdentity reference, GenContext ctx)
    {
        if (reference.TargetEntity is not { } targetName) return null;
        // ADR-0042: a bare @references resolves in the DECLARING owner's package.
        var target = NamingRefs.ResolveObjectRef(
            ctx.Root, targetName,
            NamingRefs.EffectivePackage(reference.Parent ?? entity)) as MetaObject;
        if (target is null || !target.IsEntity() || !InstanceArtifacts.EmitsInstanceArtifacts(target))
            return null;

        var fkFields = ReferentialActions.ReadIdentityFields(reference);
        if (fkFields.Count == 0) return null;

        var props = new List<string>(fkFields.Count);
        foreach (var name in fkFields)
        {
            // #214 — a write-through entity's WRITE class omits the derived (origin.*)
            // fields, so naming one here would reference a property the class does not
            // declare (a compile error in the generated file).
            if (entity.Fields().FirstOrDefault(f => f.Name == name) is not { } field) return null;
            if (entity.IsWriteThrough() && field.IsDerived()) return null;
            props.Add($"nameof({owner}.{CSharpNaming.Pascal(name)})");
        }

        var actions = ReferentialActions.Resolve(entity, reference);
        return $"        modelBuilder.Entity<{owner}>().HasOne<{CSharpNaming.Pascal(target.Name)}>()"
             + $".WithMany().HasForeignKey({string.Join(", ", props)})"
             + $"{OnDeleteCall(entity, fkFields, actions.OnDelete, ctx)};";
    }

    /// <summary>
    /// The <c>.OnDelete(...)</c> suffix for a resolved action, or <c>""</c> for none.
    ///
    /// <para><c>no-action</c> resolves to null upstream (it IS the database default), so
    /// it correctly emits no clause and leaves EF's convention in place.</para>
    ///
    /// <para><c>@onUpdate</c> has no EF Core representation — <c>DeleteBehavior</c> covers
    /// deletes only. It stays a DDL-level fact, emitted by the TS-owned migration
    /// engine (ADR-0015), and is deliberately not surfaced here.</para>
    ///
    /// <para>SET NULL requires every FK property to be nullable; EF fails MODEL VALIDATION
    /// otherwise, which would take down the whole DbContext rather than one relationship.
    /// A resolved set-null over a <c>@required</c> FK therefore warns and emits no clause.
    /// The inferred case is already dropped by the tier-3 guard in
    /// <see cref="ReferentialActions"/>, so reaching here means the action was declared
    /// explicitly — a model the TS migrate engine also rejects (SetNullNotNullableError).</para>
    /// </summary>
    private string OnDeleteCall(
        MetaObject entity, IReadOnlyList<string> fkFields, string? onDelete, GenContext ctx)
    {
        if (onDelete is null) return string.Empty;

        if (onDelete == ACTION_SET_NULL)
        {
            var required = fkFields
                .Where(n => entity.Fields().FirstOrDefault(f => f.Name == n) is { IsRequired: true })
                .ToList();
            if (required.Count > 0)
            {
                ctx.Warn($"{Name}: \"{entity.Name}\" resolves ON DELETE SET NULL over required " +
                         $"field(s) {string.Join(", ", required)} — SET NULL cannot fire on a NOT NULL " +
                         "column, so no DeleteBehavior is configured for that foreign key.");
                return string.Empty;
            }
        }

        return onDelete switch
        {
            ACTION_CASCADE => ".OnDelete(DeleteBehavior.Cascade)",
            ACTION_SET_NULL => ".OnDelete(DeleteBehavior.SetNull)",
            ACTION_RESTRICT => ".OnDelete(DeleteBehavior.Restrict)",
            _ => string.Empty,
        };
    }

    /// <summary>
    /// The <c>.OnDelete(...)</c> suffix for one side of an M:N junction, resolved from the
    /// junction's OWN <c>identity.reference</c> for that FK column (ADR-0047 names an M:N
    /// junction's FK sides as a reference-level case). Empty when the junction declares no
    /// matching enforced reference.
    /// </summary>
    private string JunctionSideOnDelete(MetaObject junction, string fkField, GenContext ctx)
    {
        var reference = junction.ReferenceIdentities().FirstOrDefault(r =>
            r.Enforce && ReferentialActions.ReadIdentityFields(r) is [var only] && only == fkField);
        if (reference is null) return string.Empty;
        return OnDeleteCall(junction, [fkField], ReferentialActions.Resolve(junction, reference).OnDelete, ctx);
    }

    // FR-018 — EF skip-navigation config for a hetero M:N navigation through its
    // explicit junction entity. The junction's FK PROPERTIES are the PascalCased
    // junction FK field names (the EntityGenerator emits them as scalar properties on
    // the junction class), derived from the junction's two identity.reference children.
    //
    //   HasMany(x => x.<Nav>).WithMany().UsingEntity<Through>(
    //       l => l.HasOne<Target>().WithMany().HasForeignKey(nameof(Through.<TargetFkProp>)),
    //       r => r.HasOne<Source>().WithMany().HasForeignKey(nameof(Through.<SourceFkProp>)));
    //
    // `WithMany()` is left inverse-less (no reciprocal collection on the target) — the
    // contract is one-directional traversal from the source, and the route does the
    // explicit join regardless.
    // ADR-0047 / #294 — each side additionally carries its referential action inline,
    // resolved from the junction's own identity.reference for that column. This call is
    // what establishes the junction's foreign keys, so it is where the action belongs;
    // the per-reference pass skips junction entities for exactly that reason.
    private string UsingEntityConfig(M2MNavigation nav, GenContext ctx)
    {
        var source = CSharpNaming.Pascal(nav.Source.Name);
        var target = CSharpNaming.Pascal(nav.Target.Name);
        var through = CSharpNaming.Pascal(nav.Junction.Name);
        var navProp = CSharpNaming.Pascal(nav.Name);
        var sourceFkProp = CSharpNaming.Pascal(nav.SourceField);
        var targetFkProp = CSharpNaming.Pascal(nav.TargetField);
        var targetOnDelete = JunctionSideOnDelete(nav.Junction, nav.TargetField, ctx);
        var sourceOnDelete = JunctionSideOnDelete(nav.Junction, nav.SourceField, ctx);
        return
            $"        modelBuilder.Entity<{source}>().HasMany(x => x.{navProp}).WithMany().UsingEntity<{through}>(" +
            $"l => l.HasOne<{target}>().WithMany().HasForeignKey(nameof({through}.{targetFkProp})){targetOnDelete}, " +
            $"r => r.HasOne<{source}>().WithMany().HasForeignKey(nameof({through}.{sourceFkProp})){sourceOnDelete});";
    }

    /// <summary>
    /// The declared symbol→int map (<c>@intValueMap</c>) for an int-backed
    /// <c>field.enum</c>, or <c>null</c> when the enum is string-backed.
    /// </summary>
    /// <remarks>
    /// ADR-0039 RESOLVING (<c>Attr</c>, not <c>OwnAttr</c>): the map is <c>@values</c>'
    /// numeric half — a logical property of the enum vocabulary that inherits through
    /// <c>extends</c> — so a field extending a shared abstract enum is int-backed too.
    /// The loader's validation reads it own-only, which is correct there: it validates
    /// what a declaration itself declares.
    /// </remarks>
    private static IReadOnlyDictionary<string, object?>? IntValueMapOf(MetaField f) =>
        f.Attr(FIELD_ATTR_INT_VALUE_MAP) as IReadOnlyDictionary<string, object?>;

    /// <summary>Name of the generated fail-fast helper the read converters end in.</summary>
    private const string UnmappedEnumHelperName = "UnmappedEnumValue";

    /// <summary>
    /// Emits the fail-fast helper every int-backed enum's provider→model converter ends
    /// in. Emitted only when at least one such converter was generated, so a model with
    /// no <c>@intValueMap</c> produces byte-identical output.
    /// </summary>
    private static void EmitUnmappedEnumHelper(StringBuilder sb)
    {
        sb.AppendLine();
        sb.AppendLine("    /// <summary>");
        sb.AppendLine("    /// An int-backed field.enum column held a value that maps to no member: the");
        sb.AppendLine("    /// database holds data the model says is impossible (a hand-written INSERT, or a");
        sb.AppendLine("    /// member removed without a migration). Materializing the last member instead");
        sb.AppendLine("    /// would hand the caller a wrong-but-valid value, silently.");
        sb.AppendLine("    /// </summary>");
        sb.AppendLine($"    private static T {UnmappedEnumHelperName}<T>(int stored, string field) =>");
        // Fully qualified: the generated file's usings are a fixed set (EmitUsings), and
        // adding `using System;` there would change byte-identical output for every model.
        sb.AppendLine("        throw new System.InvalidOperationException(");
        sb.AppendLine("            $\"field.enum '{field}' read stored value {stored} with no member in \" +");
        sb.AppendLine("            \"@intValueMap — the database holds a value the model does not describe.\");");
    }

    /// <summary>
    /// True when any emitted converter will reference <see cref="UnmappedEnumHelperName"/>
    /// — i.e. the model carries at least one int-backed <c>field.enum</c>. Mirrors the
    /// fields <see cref="EmitFieldTypeConfig"/> configures (enum fields of every emitted
    /// object, plus a write-through entity's read-model view over the same field set).
    /// </summary>
    private static bool NeedsUnmappedEnumHelper(IEnumerable<MetaObject> objects) =>
        objects.Any(o => o.Fields().Any(f =>
            f.SubType == FIELD_SUBTYPE_ENUM && IntValueMapOf(f) is not null));

    /// <summary>
    /// The complete <c>HasConversion</c> call for an enum property: the generic
    /// <c>HasConversion&lt;string&gt;()</c> for a string-backed enum, or
    /// <c>HasConversion(model→provider, provider→model)</c> built from
    /// <c>@intValueMap</c> for an int-backed one.
    /// </summary>
    /// <remarks>
    /// <para>The mapping is emitted as a TERNARY CHAIN rather than a <c>switch</c>
    /// expression because EF converts these lambdas to EXPRESSION TREES, and a switch
    /// expression is not legal in one (CS8155). A conditional is.</para>
    /// <para>The provider→model chain gives EVERY member its own branch and ends in a
    /// call to the generated <c>UnmappedEnumValue&lt;T&gt;</c> helper, so a stored int
    /// with no member THROWS rather than silently materializing as the last member —
    /// matching all four sibling ports. CS8188 bans a throw-EXPRESSION inside an
    /// expression tree, but a method CALL is legal there and the throw itself happens in
    /// the helper's ordinary body. Only the read side needs this: the model→provider
    /// chain is exhaustive over the enum by construction, since <c>@intValueMap</c>'s
    /// keys are loader-validated to match <c>@values</c> exactly.</para>
    /// </remarks>
    private static string EnumConversionCall(string owner, MetaObject entity, MetaField f, GenConfig config)
    {
        var intMap = IntValueMapOf(f);
        if (intMap is null) return "HasConversion<string>()";

        var members = f.EffectiveEnumValues ?? new List<string>();
        if (members.Count == 0) return "HasConversion<string>()";

        // FR-019: a SHARED (root-level abstract) or @provided enum is NOT nested inside the
        // entity class — EntityGenerator references it instead (see its EnumPropertyTypeName)
        // — so it must be named unqualified here. Qualifying it as {owner}.{Name} emits
        // CS0426 ("the type name does not exist in the type"), which is not an edge case:
        // ERR_ENUM_EXTENDS_VALUES_CONFLICT makes declaring @intValueMap on the CONSUMING
        // field a load error, so hanging it on the shared declaration is the only legal way
        // to int-back a shared enum. String-backed shared enums never showed this because
        // HasConversion<string>() names no type at all.
        var type = Fr019SharedEnum.SharedEnumForField(f) is { } shared
            ? Fr019SharedEnum.SharedEnumTypeReference(shared, config)
            : $"{owner}.{CSharpNaming.EnumTypeName(entity, f)}";
        // Read the ints THROUGH the map, keyed by member, so @values stays the SSOT and a
        // member with no mapping cannot silently vanish from the conversion.
        var ints = new List<string>(members.Count);
        foreach (var m in members)
        {
            if (!intMap.TryGetValue(m, out var raw) || raw is null)
                throw new InvalidOperationException(
                    $"field.enum '{f.Name}' @{FIELD_ATTR_INT_VALUE_MAP} has no integer for member '{m}' — " +
                    "cannot build the EF value conversion.");
            ints.Add(Convert.ToInt64(raw).ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        var toProvider = new System.Text.StringBuilder("v => ");
        var fromProvider = new System.Text.StringBuilder("v => ");
        for (var i = 0; i < members.Count - 1; i++)
            toProvider.Append($"v == {type}.{members[i]} ? {ints[i]} : ");
        toProvider.Append(ints[^1]);
        // Every member gets its own branch here (no last-member fallthrough) so the
        // final else can reject an int the model does not describe.
        for (var i = 0; i < members.Count; i++)
            fromProvider.Append($"v == {ints[i]} ? {type}.{members[i]} : ");
        fromProvider.Append($"{UnmappedEnumHelperName}<{type}>(v, \"{f.Name}\")");

        return $"HasConversion({toProvider}, {fromProvider})";
    }

    // #214 [0] — the per-field EF TYPE-converter emission, factored out so the SAME set of
    // converters configures BOTH the write entity (its derived-EXCLUDED field set) AND a
    // write-through entity's <Entity>View read model (ALL fields, incl. the derived origin.*
    // fields the replica view exposes). Emits, over modelBuilder.Entity<<paramref
    // name="className"/>>(): owned-VO (OwnsOne/OwnsMany.ToJson or flattened per-column names);
    // enum string-conversion (scalar HasConversion<string> + array PrimitiveCollection element
    // conversion — else enum arrays persist as int ordinals); scalar PrimitiveCollection (EF
    // Core 8 API — .ToJson does not exist on PropertyBuilder<List<T>>); field.decimal
    // .HasPrecision (SP-A, precision-exact NUMERIC vs EF's default decimal(18,2)); field.timestamp
    // .HasColumnType (ADR-0036 Wave 2 — timestamptz default / `timestamp without time zone` under
    // @localTime, REQUIRED else Npgsql rejects a Kind=Unspecified DateTime); field.uri (Uri↔text
    // converter) / field.inet (native `inet`) (ADR-0036 Wave 3); and @dbColumnType uuid/jsonb
    // physical overrides (R6 Plan 2b). The WRITE-ONLY configs (@readOnly SetAfterSaveBehavior,
    // M:N UsingEntity, TPH HasDiscriminator) stay on the caller — a read-only view is never
    // written. <paramref name="jsonbObjectsOnly"/> restricts the owned-VO loop to non-flattened
    // (single-jsonb-column) VO fields — the read model declares only those (a flattened VO's
    // per-column spread is out of scope on the view; #214 note), so the emitted config never
    // references a property the <Entity>View class does not declare.
    private void EmitFieldTypeConfig(
        string className, MetaObject entity, IEnumerable<MetaField> fields,
        GenContext ctx, List<string> modelLines, bool jsonbObjectsOnly)
    {
        var fieldList = fields as IReadOnlyList<MetaField> ?? fields.ToList();

        foreach (var f in fieldList.Where(f => f.SubType == FIELD_SUBTYPE_OBJECT
                     && (!jsonbObjectsOnly || f.Storage != STORAGE_FLATTENED)))
            if (OwnedTypeConfig(className, entity, f, ctx) is { } cfg) modelLines.Add(cfg);

        foreach (var f in fieldList.Where(f => f.SubType == FIELD_SUBTYPE_ENUM))
        {
            var prop = CSharpNaming.Pascal(f.Name);
            // An int-backed enum (@intValueMap) persists the declared INTEGER instead of the
            // member symbol, so it needs a custom converter pair rather than HasConversion<string>().
            // The generated C# `enum` declaration is byte-identical either way — int-backing is a
            // persistence concern, invisible in the entity's API.
            var conversion = EnumConversionCall(className, entity, f, ctx.Config);
            // ADR-0039: resolving — array-ness inheritable via extends. Array-of-enum uses the
            // EF Core 8 primitive collection with a per-element conversion so members persist as
            // symbols (["DRAFT"]) — or as their declared ints — not as int ordinals ([0]).
            if (f.ResolvedIsArray())
                modelLines.Add($"        modelBuilder.Entity<{className}>().PrimitiveCollection(x => x.{prop}).ElementType().{conversion};");
            else
                modelLines.Add($"        modelBuilder.Entity<{className}>().Property(x => x.{prop}).{conversion};");
        }

        foreach (var f in fieldList.Where(f => f.ResolvedIsArray() && CSharpNaming.ScalarFor(f.SubType) is not null))
        {
            var prop = CSharpNaming.Pascal(f.Name);
            modelLines.Add($"        modelBuilder.Entity<{className}>().PrimitiveCollection(x => x.{prop});");
        }

        foreach (var f in fieldList.Where(f =>
                     !f.ResolvedIsArray() && f.SubType == FIELD_SUBTYPE_DECIMAL && f.Precision is not null))
        {
            var prop = CSharpNaming.Pascal(f.Name);
            modelLines.Add(f.Scale is long sc
                ? $"        modelBuilder.Entity<{className}>().Property(x => x.{prop}).HasPrecision({f.Precision}, {sc});"
                : $"        modelBuilder.Entity<{className}>().Property(x => x.{prop}).HasPrecision({f.Precision});");
        }

        foreach (var f in fieldList.Where(f => !f.ResolvedIsArray() && f.SubType == FIELD_SUBTYPE_TIMESTAMP))
        {
            var prop = CSharpNaming.Pascal(f.Name);
            var colType = CSharpNaming.IsLocalTime(f)
                ? "timestamp without time zone"
                : "timestamp with time zone";
            modelLines.Add($"        modelBuilder.Entity<{className}>().Property(x => x.{prop}).HasColumnType(\"{colType}\");");
        }

        // #234: a @lenient field.uri / field.inet is a plain string mapped to a plain `text`
        // column (EF's string default) — no System.Uri HasConversion, no native `inet` type.
        foreach (var f in fieldList.Where(f => !f.ResolvedIsArray()
                     && f.SubType == FIELD_SUBTYPE_URI && !CSharpNaming.IsLenientNet(f)))
        {
            var prop = CSharpNaming.Pascal(f.Name);
            // System.Uri is FULLY QUALIFIED: the emitted AppDbContext carries no `using System;`
            // (unlike the entity files), so an unqualified `new Uri(v)` in OnModelCreating fails
            // to compile except under a host's ImplicitUsings — the generated context must be
            // self-contained (this is also on the #214 write-through read-model path now).
            modelLines.Add(
                $"        modelBuilder.Entity<{className}>().Property(x => x.{prop}).HasColumnType(\"text\").HasConversion(v => v!.ToString(), v => new System.Uri(v));");
        }

        foreach (var f in fieldList.Where(f => !f.ResolvedIsArray()
                     && f.SubType == FIELD_SUBTYPE_INET && !CSharpNaming.IsLenientNet(f)))
        {
            var prop = CSharpNaming.Pascal(f.Name);
            modelLines.Add(
                $"        modelBuilder.Entity<{className}>().Property(x => x.{prop}).HasColumnType(\"inet\");");
        }

        foreach (var f in fieldList.Where(f => !f.ResolvedIsArray() && f.DbColumnType is not null))
            if (DbColumnTypeConfig(className, f) is { } cfg) modelLines.Add(cfg);
    }

    // Owned-type config for an object-typed entity field. @storage flattened maps each
    // nested scalar to "{parentCol}_{nestedCol}"; every other storage collapses to one
    // json column (.ToJson) — matching the TS-owned schema DDL. null (with a warning)
    // when @objectRef can't be resolved. <paramref name="owner"/> is the emitted CLR class
    // name (the write entity, or a write-through entity's <Entity>View read model — #214).
    //
    // KNOWN GAP: a @required non-flattened object field gets a NOT NULL jsonb column in
    // the TS-owned schema DDL, but .ToJson here does not mark the owned navigation
    // required, so EF models it nullable — a gen↔schema nullability mismatch. Deferred
    // until the exact EF Core required-owned-JSON mapping can be validated against a
    // live provider.
    private string? OwnedTypeConfig(string owner, MetaObject entity, MetaField field, GenContext ctx)
    {
        if (field.ObjectRef is not { } oref || ctx.Root.FindObject(CSharpNaming.StripPkg(oref)) is not { } vo)
        {
            ctx.Warn($"{Name}: object-typed field \"{entity.Name}.{field.Name}\" has an unresolved @objectRef \"{field.ObjectRef}\" — no owned-type config emitted.");
            return null;
        }
        var strategy = ctx.Config.ColumnNamingStrategy;
        var nav = CSharpNaming.Pascal(field.Name);
        var parentCol = CSharpNaming.Column(field, strategy);

        // An @isArray object field is a COLLECTION of the value object (the EntityGenerator
        // emits it as ICollection<VO>), so EF must map it with .OwnsMany(...).ToJson(...) —
        // .OwnsOne over a collection compiles but fails at EF model finalization ("must be a
        // non-interface reference type to be used as an entity type"). An array is always a
        // single JSON column (flattening N objects onto fixed columns is nonsensical), so it
        // never takes the flattened branch below. ResolvedIsArray per ADR-0039 (array-ness is
        // inheritable via extends).
        if (field.ResolvedIsArray())
            return $"        modelBuilder.Entity<{owner}>().OwnsMany(x => x.{nav}, b => b.ToJson(\"{parentCol}\"));";

        if (field.Storage != STORAGE_FLATTENED)
            return $"        modelBuilder.Entity<{owner}>().OwnsOne(x => x.{nav}, b => b.ToJson(\"{parentCol}\"));";

        // Flattened-column prefix for each nested scalar. Defaults to "{parentCol}_"
        // (EF's owned-type convention). An explicit @embeddedColumnPrefix overrides it —
        // including "" for un-prefixed columns (the prefix is owner-specific, so it lives
        // on the owner's object-field, not on the shared value object).
        var prefix = field.Attr("embeddedColumnPrefix") as string ?? $"{parentCol}_";

        var sb = new StringBuilder();
        sb.AppendLine($"        modelBuilder.Entity<{owner}>().OwnsOne(x => x.{nav}, b =>");
        sb.AppendLine("        {");
        foreach (var nf in vo.Fields().Where(n => CSharpNaming.ScalarFor(n.SubType) is not null))
        {
            var nestedCol = $"{prefix}{CSharpNaming.Column(nf, strategy)}";
            sb.AppendLine($"            b.Property(p => p.{CSharpNaming.Pascal(nf.Name)}).HasColumnName(\"{nestedCol}\");");
        }
        sb.Append("        });");
        return sb.ToString();
    }
}
