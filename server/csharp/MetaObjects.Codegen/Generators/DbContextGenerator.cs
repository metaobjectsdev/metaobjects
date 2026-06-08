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

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        // FR-017 TPH: a concrete subtype shares the base's single table — it gets NO
        // DbSet and no per-subtype model config; the hierarchy is reached via the base
        // DbSet (`.OfType<Sub>()`). Filter subtypes out of the emitted set entirely.
        var objects = ctx.Entities
            .Where(o => (o.IsEntity() || o.DbView is not null) && InstanceArtifacts.EmitsInstanceArtifacts(o))
            .Where(o => !TphPlanBuilder.IsTphSubtype(o, ctx.Root))
            .OrderBy(o => o.Name, StringComparer.Ordinal)
            .ToList();
        if (objects.Count == 0) return [];

        // OnModelCreating body lines (8-space indented), in a stable order.
        var modelLines = new List<string>();
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
            foreach (var f in p.Fields().Where(f => f.SubType == FIELD_SUBTYPE_ENUM && !f.IsArray))
                modelLines.Add($"        modelBuilder.Entity<{name}>().Property(x => x.{CSharpNaming.Pascal(f.Name)}).HasConversion<string>();");
        }
        foreach (var e in objects.Where(o => o.IsEntity() && !o.IsReadOnlyProjection()))
        {
            var owner = CSharpNaming.Pascal(e.Name);
            foreach (var f in e.Fields().Where(f => f.SubType == FIELD_SUBTYPE_OBJECT))
                if (OwnedTypeConfig(e, f, ctx) is { } cfg) modelLines.Add(cfg);
            foreach (var f in e.Fields().Where(f => f.SubType == FIELD_SUBTYPE_ENUM))
            {
                var prop = CSharpNaming.Pascal(f.Name);
                if (f.IsArray)
                {
                    // Array-of-enum: EF Core 8 primitive collection with per-element string conversion
                    // so enum values persist as string symbols (e.g. ["DRAFT","ARCHIVED"]), consistent
                    // with the scalar enum path (.HasConversion<string>()). Without .ElementType()
                    // .HasConversion<string>() elements would persist as int ordinals ([0,2]).
                    modelLines.Add($"        modelBuilder.Entity<{owner}>().PrimitiveCollection(x => x.{prop}).ElementType().HasConversion<string>();");
                }
                else
                {
                    modelLines.Add($"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).HasConversion<string>();");
                }
            }
            // Scalar arrays (scalar subtypes, non-enum): EF Core 8 .PrimitiveCollection() API.
            // .Property(...).ToJson() does not exist on PropertyBuilder<List<T>> (CS1061).
            foreach (var f in e.Fields().Where(f => f.IsArray && CSharpNaming.ScalarFor(f.SubType) is not null))
            {
                var prop = CSharpNaming.Pascal(f.Name);
                modelLines.Add($"        modelBuilder.Entity<{owner}>().PrimitiveCollection(x => x.{prop});");
            }
            // SP-A — field.decimal precision/scale. The CLR property is System.Decimal;
            // EF Core .HasPrecision(p, s) maps it onto the NUMERIC(p,s) column so the
            // model agrees with the TS-owned schema DDL and the value round-trips
            // precision-exact (vs. EF's default decimal(18,2) coercion).
            foreach (var f in e.Fields().Where(f =>
                         !f.IsArray && f.SubType == FIELD_SUBTYPE_DECIMAL && f.Precision is not null))
            {
                var prop = CSharpNaming.Pascal(f.Name);
                modelLines.Add(f.Scale is long sc
                    ? $"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).HasPrecision({f.Precision}, {sc});"
                    : $"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).HasPrecision({f.Precision});");
            }
            // field.timestamp maps to a plain `timestamp without time zone` column
            // (the cross-port contract: @dbColumnType:timestamp_with_tz opts INTO
            // timestamptz). Npgsql's DbDateTime provider default is timestamptz, which
            // rejects a Kind=Unspecified DateTime on WRITE — so without this explicit
            // mapping a create/update over a `field.timestamp` column throws at runtime
            // (DbUpdateException: "Cannot write DateTime with Kind=Unspecified to
            // PostgreSQL type 'timestamp with time zone'"). The @dbColumnType path below
            // owns the timestamptz opt-in, so only emit this for plain timestamps.
            foreach (var f in e.Fields().Where(f =>
                         !f.IsArray && f.SubType == FIELD_SUBTYPE_TIMESTAMP && f.DbColumnType is null))
            {
                var prop = CSharpNaming.Pascal(f.Name);
                modelLines.Add($"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).HasColumnType(\"timestamp without time zone\");");
            }
            // R6 Plan 2b — @dbColumnType physical overrides. The logical field stays its
            // native CLR type (a @dbColumnType:uuid string is still C# string); EF must be
            // told the provider column type (and, for uuid, a string↔Guid value converter)
            // so the native uuid / jsonb / timestamptz column round-trips into that property.
            foreach (var f in e.Fields().Where(f => !f.IsArray && f.DbColumnType is not null))
                if (DbColumnTypeConfig(owner, f) is { } cfg) modelLines.Add(cfg);

            // FR-013 — a @readOnly field is read-after-insert-only. The property carries a
            // private setter (EntityGenerator), and EF must skip the column on writes:
            // SetAfterSaveBehavior(Ignore) excludes it from UPDATE, and ValueGeneratedOnAdd
            // (paired below) lets the DB / trigger / default own the value on INSERT.
            foreach (var f in e.Fields().Where(f => !f.IsArray && f.ReadOnly))
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
                modelLines.Add(UsingEntityConfig(nav));

            // FR-017 TPH — single-table inheritance mapping. The base maps its concrete
            // subtypes onto the shared table via the discriminator property:
            //   HasDiscriminator(e => e.<DiscProp>).HasValue<Sub>(<EnumType>.<Value>)...
            // The discriminator property is the entity's @discriminator field (an enum);
            // its HasConversion<string>() (emitted by the enum loop above) stores the
            // symbol as text, matching the TS-owned TEXT column. EF folds every subtype's
            // own columns into the base table as nullable.
            if (TphPlanBuilder.For(e, ctx.Root) is { } tph)
                modelLines.Add(HasDiscriminatorConfig(owner, e, tph));
        }

        // FR-013 — PropertySaveBehavior (used by the @readOnly SetAfterSaveBehavior config)
        // lives in Microsoft.EntityFrameworkCore.Metadata. Emit that using only when a
        // read-only field is present so models without one stay byte-identical.
        var needsMetadataUsing = objects
            .Where(o => o.IsEntity() && !o.IsReadOnlyProjection())
            .Any(o => o.Fields().Any(f => !f.IsArray && f.ReadOnly));

        var sb = new StringBuilder();
        EmitUsings(sb, needsMetadataUsing, ctx);
        EmitDbSetDeclarations(sb, objects, ctx);
        EmitOnModelCreatingBody(sb, modelLines, ctx);
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
        // FR-021 — pull in every per-package namespace the model uses. The DbContext
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
    //   timestamp_with_tz (on field.timestamp) → `timestamp with time zone` column.
    private static string? DbColumnTypeConfig(string owner, MetaField f)
    {
        var prop = CSharpNaming.Pascal(f.Name);
        var lhs = $"        modelBuilder.Entity<{owner}>().Property(x => x.{prop})";
        return f.DbColumnType switch
        {
            // `v!` is safe even for a nullable `string?` property: EF Core skips
            // value-converter invocation for null (null↔NULL), so Guid.Parse(null)
            // never runs.
            DbConstants.DB_COLUMN_TYPE_UUID =>
                lhs + ".HasColumnType(\"uuid\").HasConversion(v => Guid.Parse(v!), g => g.ToString(\"D\"));",
            DbConstants.DB_COLUMN_TYPE_JSONB =>
                lhs + ".HasColumnType(\"jsonb\");",
            DbConstants.DB_COLUMN_TYPE_TIMESTAMP_TZ =>
                lhs + ".HasColumnType(\"timestamp with time zone\");",
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
    private static string UsingEntityConfig(M2MNavigation nav)
    {
        var source = CSharpNaming.Pascal(nav.Source.Name);
        var target = CSharpNaming.Pascal(nav.Target.Name);
        var through = CSharpNaming.Pascal(nav.Junction.Name);
        var navProp = CSharpNaming.Pascal(nav.Name);
        var sourceFkProp = CSharpNaming.Pascal(nav.SourceField);
        var targetFkProp = CSharpNaming.Pascal(nav.TargetField);
        return
            $"        modelBuilder.Entity<{source}>().HasMany(x => x.{navProp}).WithMany().UsingEntity<{through}>(" +
            $"l => l.HasOne<{target}>().WithMany().HasForeignKey(nameof({through}.{targetFkProp})), " +
            $"r => r.HasOne<{source}>().WithMany().HasForeignKey(nameof({through}.{sourceFkProp})));";
    }

    // Owned-type config for an object-typed entity field. @storage flattened maps each
    // nested scalar to "{parentCol}_{nestedCol}"; every other storage collapses to one
    // json column (.ToJson) — matching the TS-owned schema DDL. null (with a warning)
    // when @objectRef can't be resolved.
    //
    // KNOWN GAP: a @required non-flattened object field gets a NOT NULL jsonb column in
    // the TS-owned schema DDL, but .ToJson here does not mark the owned navigation
    // required, so EF models it nullable — a gen↔schema nullability mismatch. Deferred
    // until the exact EF Core required-owned-JSON mapping can be validated against a
    // live provider.
    private string? OwnedTypeConfig(MetaObject entity, MetaField field, GenContext ctx)
    {
        if (field.ObjectRef is not { } oref || ctx.Root.FindObject(CSharpNaming.StripPkg(oref)) is not { } vo)
        {
            ctx.Warn($"{Name}: object-typed field \"{entity.Name}.{field.Name}\" has an unresolved @objectRef \"{field.ObjectRef}\" — no owned-type config emitted.");
            return null;
        }
        var strategy = ctx.Config.ColumnNamingStrategy;
        var owner = CSharpNaming.Pascal(entity.Name);
        var nav = CSharpNaming.Pascal(field.Name);
        var parentCol = CSharpNaming.Column(field, strategy);

        if (field.Storage != STORAGE_FLATTENED)
            return $"        modelBuilder.Entity<{owner}>().OwnsOne(x => x.{nav}, b => b.ToJson(\"{parentCol}\"));";

        var sb = new StringBuilder();
        sb.AppendLine($"        modelBuilder.Entity<{owner}>().OwnsOne(x => x.{nav}, b =>");
        sb.AppendLine("        {");
        foreach (var nf in vo.Fields().Where(n => CSharpNaming.ScalarFor(n.SubType) is not null))
        {
            var nestedCol = $"{parentCol}_{CSharpNaming.Column(nf, strategy)}";
            sb.AppendLine($"            b.Property(p => p.{CSharpNaming.Pascal(nf.Name)}).HasColumnName(\"{nestedCol}\");");
        }
        sb.Append("        });");
        return sb.ToString();
    }
}
