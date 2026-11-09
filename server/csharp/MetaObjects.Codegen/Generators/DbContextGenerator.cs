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
using static MetaObjects.Core.Identity.IdentityConstants;

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
    /// Whether <c>OnModelCreating</c> carries the explicit 1:N relationship configuration for each
    /// enforced <c>identity.reference</c> (ADR-0047 / #294). <c>true</c> by default — that is what
    /// gives EF the foreign key the metadata declares and lets the referential action ride on the
    /// call that establishes it.
    ///
    /// <para>Override to <c>false</c> when the generated entities DO carry reference navigation
    /// properties. This generator's FK configuration uses the navigation-LESS
    /// <c>HasOne&lt;Target&gt;()</c> overload, which is correct for stock codegen precisely because
    /// stock <see cref="EntityGenerator"/> emits no reference navigations at all — ADR-0038
    /// replaced reverse navigation with explicit FK finders, so there is no navigation to name on
    /// either side. That premise is load-bearing, and it is NOT something this generator can
    /// detect: it holds for the entity generator in this repo and silently fails for an adopter
    /// that substitutes its own.</para>
    ///
    /// <para>When navigations do exist, EF's conventions discover them and build their own
    /// relationship over the same FK column, and a navigation-less configuration claiming that
    /// column leaves the convention-built one unable to identify its dependent
    /// ("The dependent side could not be determined for the one-to-one relationship between
    /// 'X.Y' and 'Y.X'") — which fails model validation, and a failed model takes down every
    /// query in the application, not just the one relationship. Such an adopter turns this off and
    /// configures its relationships itself, against the navigations only it knows about. Nothing
    /// else this generator emits is affected.</para>
    /// </summary>
    protected virtual bool EmitsReferenceForeignKeys => true;

    /// <summary>The C# property name of a field, for every line of model configuration that
    /// names one. Default: the run's <see cref="GenConfig.PropertyNaming"/> resolver, else
    /// PascalCase of the field name — the same answer <c>EntityGenerator.PropertyName</c> gives
    /// by default, so the two agree. A subclass that overrides the entity generator's hook
    /// overrides this one the same way (or sets the resolver on the config instead).</summary>
    protected virtual string PropertyName(MetaField field) => CSharpNaming.PropertyName(field, _config);

    // The run's config, for the PropertyName default. Set when Generate starts.
    private GenConfig? _config;

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

    /// <summary>Scope this entry to some objects: only those it accepts get a <c>DbSet</c>
    /// and mapping. <c>null</c>, the default, accepts every object. See <see cref="GenContext.Narrow"/>.</summary>
    public Func<MetaObject, bool>? Include { get; init; }

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        ctx = ctx.Narrow(Include);
        _config = ctx.Config;
        // FR-017 TPH: a concrete subtype shares the base's single table — it gets NO
        // DbSet and no per-subtype model config; the hierarchy is reached via the base
        // DbSet (`.OfType<Sub>()`). Filter subtypes out of the emitted set entirely.
        // FR-044 — a view-backed report joins the set as its ROW MODEL, which the
        // read-only-projection arm below maps as `HasNoKey().ToView(...)`; every other
        // report node is dropped. See ReportRows.
        var objects = ReportRows.WithReportRows(ctx)
            .Where(o => AppliesTo(o, ctx.Root))
            .OrderBy(o => o.Name, StringComparer.Ordinal)
            .ToList();
        if (objects.Count == 0) return [];
        // One context, one property per name (CS0102 otherwise), claimed as emitted: an object
        // that gets no DbSet here never takes part. Two objects on one table are EF's to refuse
        // (it does, at model build), not this generator's.
        var dbSets = $"the DbSet properties of the context of {Name} entry {ctx.EntryLabel(this)}";
        foreach (var o in objects)
        {
            ctx.Claim(dbSets, DbSetPropertyName(o, ctx), o.ResolutionKey(), "rename one, or set @dbSetName on one of them");
            if (o.IsWriteThrough())
                ctx.Claim(dbSets, CSharpNaming.ViewDbSetName(o), o.ResolutionKey(), "rename one, or set @dbSetName on one of them");
        }

        // OnModelCreating body lines (8-space indented), in a stable order. INVARIANT: each entry is
        // one complete C# statement — a guard and the statement it guards are ONE entry — because a
        // large model is split into ConfigureModelNN methods at any entry boundary.
        var modelLines = new List<string>();

        // The M:N navigations, derived ONCE. M2MNavigationBuilder.For re-walks the
        // relationships and re-derives the junction FK columns on every call, and both the
        // junction map below and the per-entity UsingEntity emission need the same answer.
        // Self-joins are excluded here, in one place rather than two: their navigation is
        // [NotMapped] (route-traversed — see EntityGenerator.M2mNavProperty), so they get
        // NO UsingEntity call and the junction's own references are the only thing that
        // can carry their actions.
        var m2mNavs = new Dictionary<MetaObject, List<M2MNavigation>>();
        foreach (var o in objects.Where(o => o.IsEntity()))
            m2mNavs[o] = M2MNavigationBuilder.For(o, ctx.Root, ctx.Warn).Where(n => !n.IsSelfJoin).ToList();

        // #294 — the FK COLUMNS that UsingEntityConfig already configures, per junction
        // entity. That call is what establishes those two relationships, so a standalone
        // HasOne/WithMany for the same column would configure one foreign key twice.
        //
        // Keyed per COLUMN, not per entity: a junction may carry a third reference of its
        // own (an `assignedById` beside the two join sides), and UsingEntityConfig names
        // only the two. Skipping the whole entity would leave that FK configured nowhere.
        //
        // Keyed by NODE IDENTITY, not by name: two entities in different packages may
        // share a bare short name (ADR-0041/0042), and a name-keyed set would let a
        // junction suppress an unrelated same-named entity's foreign keys entirely.
        var junctionOwnedFks = new Dictionary<MetaObject, HashSet<string>>();
        foreach (var nav in m2mNavs.Values.SelectMany(navs => navs))
        {
            if (!junctionOwnedFks.TryGetValue(nav.Junction, out var owned))
                junctionOwnedFks[nav.Junction] = owned = new HashSet<string>(StringComparer.Ordinal);
            owned.Add(nav.SourceField);
            owned.Add(nav.TargetField);
        }
        foreach (var p in objects.Where(o => o.IsReadOnlyProjection()))
        {
            var name = CSharpNaming.Pascal(p.Name);
            var noKey = p.PrimaryIdentity() is null ? ".HasNoKey()" : string.Empty;
            // A6 -- gated exactly like EntityGenerator's [Table] (CSharpNaming.NameRef):
            // C1 (ctx.Config.IncludeNames -- is `names` part of THIS run) AND I1
            // (ResolveObjectNames non-null -- does `p` resolve a names artifact at all).
            // A read-only projection reaching this loop always HAS a primary source (its
            // own read-only view), so I1 never misses here -- but C1 can, under a
            // narrowed --generators selection. Falls back to the bare literal view name
            // (p.DbView, non-null in this branch) otherwise -- exactly what this line
            // emitted before Program A added the constant.
            modelLines.Add($"        modelBuilder.Entity<{name}>(){noKey}.ToView({CSharpNaming.NameRef(p, ctx.Config.ColumnNamingStrategy, ctx.Config.IncludeNames, p.DbView!)}{CSharpNaming.ViewSchemaArg(p, ctx.Config.ColumnNamingStrategy, ctx.Config.IncludeNames)});");
            // Enum-typed projection columns persist as their string symbol in the view
            // (string-backed enums, CHECK-constrained varchar/text). Without an explicit
            // string conversion EF defaults to the int-ordinal mapping and reads the text
            // column as Int32 at materialization — an InvalidCastException. Mirror the
            // entity-side HasConversion<string>() so a projection that passes an enum
            // through (e.g. ProgramView.status over v_program) round-trips.
            // An int-backed enum (@intValueMap) column in the view holds the declared INTEGER,
            // so it takes the same custom converter pair the table side gets — reading it as
            // a string would fail materialization exactly as the ordinal default does here.
            // An enum ARRAY column takes the table side's element converter too: left to EF's
            // ordinal default, an int-backed array would read its stored ints as ORDINALS and
            // silently name the wrong members, and a string-backed one would read text[] as int[].
            foreach (var f in p.Fields().Where(f => f.SubType == FIELD_SUBTYPE_ENUM))
            {
                // An override that returns null for a field leaves it unconverted: no line.
                if (EnumConversionCall(name, p, f, ctx) is not { } conversion)
                {
                    continue;
                }
                modelLines.Add(f.ResolvedIsArray()
                    ? $"        modelBuilder.Entity<{name}>().PrimitiveCollection(x => x.{PropertyName(f)}).ElementType().{conversion};"
                    : $"        modelBuilder.Entity<{name}>().Property(x => x.{PropertyName(f)}).{conversion};");
            }
            // A field.map column on a view needs its jsonb mapping for the SAME reason:
            // EntityGenerator emits the Dictionary property for a projection too, so without
            // this loop the property carries no column type and no converter -- only an
            // explicit mapping makes EF agree with the jsonb column the TS-owned migration
            // creates (ADR-0015).
            foreach (var f in p.Fields().Where(f => f.SubType == FIELD_SUBTYPE_MAP))
                modelLines.Add(MapJsonbConfig(name, p, f, ctx));
            // A duration column on a view reads through the same provider-dependent mapping.
            AddDurationConfig(name, p, p.Fields(), ctx, modelLines);
            EmitShapeInheritedFacets(name, p, p.Fields(), ctx, modelLines);
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
            EmitShapeInheritedFacets(owner, e, configFields, ctx, modelLines);
            EmitDefaultValueConfig(e, configFields, ctx, modelLines);
            if (IdentityStartOn(ctx)) EmitIdentityStartConfig(owner, e, modelLines);
            EmitCommentConfig(owner, e, configFields, modelLines, ctx);
            EmitIndexConfig(owner, e, ctx, modelLines);
            EmitCheckConfig(owner, e, ctx, modelLines);

            // identity.primary @generation: assigned — the caller supplies the key. EF's
            // convention makes a single integer or Guid key generated on add, which leaves a key
            // equal to the CLR default (0) out of the INSERT altogether, and has EnsureCreated
            // build an identity column the model never asked for.
            if (AssignedKeyField(e) is { } assignedKey)
                modelLines.Add(
                    $"        modelBuilder.Entity<{owner}>().Property(x => x.{PropertyName(assignedKey)}).ValueGeneratedNever();");

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
                var prop = PropertyName(f);
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
            // Self-joins are already excluded from m2mNavs (see above).
            foreach (var nav in m2mNavs[e])
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
            {
                modelLines.Add(HasDiscriminatorConfig(owner, e, tph, ctx.Config));
                EmitTphSubtypeFieldConfig(e, tph, ctx, modelLines);
            }

            // ADR-0047 / #294 — explicit 1:N relationship configuration, with the
            // referential action INLINE on the call that establishes the foreign key.
            // Without this EF Core sees no relationship at all for a plain reference (the
            // generated class carries a bare scalar FK property and no navigation), so
            // every DeleteBehavior fell back to EF's own convention regardless of what the
            // metadata — or the database — said. A junction's sides are owned by
            // UsingEntityConfig; see the m2mJunctions note above.
            junctionOwnedFks.TryGetValue(e, out var ownedByUsingEntity);
            if (EmitsReferenceForeignKeys)
                EmitReferenceConfig(e, tph, ctx, modelLines, ownedByUsingEntity);

            // The adopter's own per-entity lines (indexes, CHECKs, query filters, computed
            // columns), last so they see everything the entity was configured with.
            modelLines.AddRange(EntityConfigTrailer(e, ctx));
        }

        // #214 (FR-024 §7) — register the write-through read model against its replica view.
        // It is a SECOND CLR type (the write entity maps the table above); reads route here.
        // Keyed (its primary identity) so a create/update can re-read the row by PK — no
        // .HasNoKey(). String-backed enum columns need the same HasConversion<string>() the
        // table side gets, or EF reads the text column as an int ordinal at materialization.
        foreach (var wt in objects.Where(o => o.IsEntity() && o.IsWriteThrough()))
        {
            var view = CSharpNaming.ViewModelClassName(wt);
            // A6 -- converted in 0.25.0, and the row it closes had been booked as STRUCTURAL
            // for its whole life. <Entity>Names carried the PRIMARY source's physical name
            // only, so a write-through entity — which declares TWO physical names — had one
            // slot between them and the second was emitted in full, right here. Keying the
            // artifact's sources by @role gives it a home.
            //
            // The ROLE comes from the source node MetaObject.ReplicaSource already selected,
            // never from a hardcoded "replica": ReplicaViewName is role-AGNOSTIC (the first
            // own read-only source, whatever role it plays), so guessing would be a second
            // derivation of what that accessor decides once.
            var replicaRole = wt.ReplicaSource!.Role;
            var viewRef = CSharpNaming.NameRef(
                wt, ctx.Config.ColumnNamingStrategy, ctx.Config.IncludeNames, wt.ReplicaViewName!, replicaRole);
            modelLines.Add($"        modelBuilder.Entity<{view}>().ToView({viewRef}{CSharpNaming.ViewSchemaArg(wt, ctx.Config.ColumnNamingStrategy, ctx.Config.IncludeNames, replicaRole)});");
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
                                          && f.Mutability != MUTABILITY_READ_WRITE))
            // A TPH subtype's own read-only field is configured too (EmitTphSubtypeFieldConfig).
            || modelLines.Any(l => l.Contains("PropertySaveBehavior.", StringComparison.Ordinal));

        // R36, R50 — the identity start. A Postgres context with an increment key gets the
        // generated design-time services whether or not a start is declared today, so removing the
        // last @sequenceStart still scaffolds through them. Nothing is registered at runtime: the
        // rewrite matters only when a migration is scaffolded, and Migrate() runs what it says.
        var written = objects.Where(o => o.IsEntity() && !o.IsReadOnlyProjection()).ToList();
        var declaresStart = written.Any(o => IdentityStartOf(o) is not null);
        var identityStart = IdentityStartOn(ctx) && written.Any(o => IncrementKeyOf(o) is not null);
        if (declaresStart && !IdentityStartOn(ctx))
            ctx.Warn($"{Name}: @sequenceStart is not in the EF model: the project names no Postgres " +
                "dialect (.metaobjects/config.json migrate.dialect: \"postgres\"; a self-hosted runner sets GenConfig.Dialect), " +
                "and the design-time services that keep a changed start from restarting the sequence are Npgsql's concern. meta migrate still creates the start.");
        // Ruling R56 (item 3): @sequenceName describes an adopted database whose sequence kept its name.
        // EF never names an identity's sequence and Npgsql cannot express it, so it is not in the model;
        // that is not an error. Said once per run, naming every object that declares it.
        var namedSequences = written
            .Where(o => o.PrimaryIdentity()?.Attr(DbConstants.IDENTITY_ATTR_SEQUENCE_NAME) is string { Length: > 0 })
            .Select(o => o.ResolutionKey())
            .ToList();
        if (namedSequences.Count > 0)
            ctx.Warn($"{Name}: @sequenceName is not in the EF model ({string.Join(", ", namedSequences)}): EF never names an " +
                "identity's sequence and Npgsql cannot express it. The database keeps the name it has, and meta migrate uses it.");

        var sb = new StringBuilder();
        EmitUsings(sb, needsMetadataUsing, ctx);
        EmitDbSetDeclarations(sb, objects, ctx);
        EmitOnModelCreatingBody(sb, modelLines, ctx);
        // The model lines are complete here, so the emitted text decides too: a TPH subtype's own
        // int-backed enum is configured although the subtype is not in `objects`.
        if (NeedsUnmappedEnumHelper(objects, ctx.Root)
            || modelLines.Any(l => l.Contains(UnmappedEnumMemberHelperName + "(", StringComparison.Ordinal)))
            EmitUnmappedEnumHelper(sb);
        // Gated on the EMITTED text, not on a second derivation of it. Every site that uses the
        // helper appends to modelLines (entity, read-only projection, and the flattened-VO member
        // block, which lands here as one OwnedTypeConfig string), and modelLines is complete by
        // now — so this is exact by construction. The predicate it replaces had to hand-mirror
        // three emission sites, and had already been wrong twice: it undercounted them, and it
        // did not model jsonbObjectsOnly suppressing the flattened arm on a read model.
        if (modelLines.Any(l => l.Contains(MapJsonbHelperName))) EmitMapJsonbHelper(sb);
        sb.AppendLine("}");
        if (modelLines.Any(l => l.Contains(DurationIntervalHelperName + "."))) EmitDurationIntervalHelper(sb);
        // The design-time services also scaffold a JSON column's comment (ruling R59).
        identityStart |= IdentityStartOn(ctx) && modelLines.Any(l => l.Contains(JsonColumnCommentAnnotation, StringComparison.Ordinal));
        if (!identityStart) return [new EmittedFile("AppDbContext.g.cs", sb.ToString())];
        var services = ContextClassName(ctx) + DesignTimeServicesSuffix;
        return [new EmittedFile("AppDbContext.g.cs", sb.ToString()), new EmittedFile($"{services}.g.cs", DesignTimeServicesFile(ctx, services))];
    }

    /// <summary>
    /// Extension hook — emits the file header, usings, namespace, and the opening of
    /// the <c>public class AppDbContext : DbContext</c> declaration through its primary
    /// constructor and any <see cref="ContextMemberLines"/> (leaving the class body open for
    /// <see cref="EmitDbSetDeclarations"/> + <see cref="EmitOnModelCreatingBody"/>; the caller
    /// emits the closing <c>}</c>). The shell is assembled from <see cref="ContextNamespace"/>,
    /// <see cref="ContextIsPartial"/>, <see cref="ContextClassName"/>, <see cref="ContextBaseClass"/>
    /// and <see cref="EmitContextConstructor"/>, so changing one of them needs no copy of this body.
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
        var dbCtxNs = ContextNamespace(ctx);
        _usingSite = (needsMetadataUsing, dbCtxNs);
        try
        {
            foreach (var line in ContextUsings(ctx))
            {
                sb.AppendLine(line);
            }
        }
        finally
        {
            _usingSite = null;
        }
        sb.AppendLine();
        sb.AppendLine($"namespace {dbCtxNs};");
        sb.AppendLine();
        var name = ContextClassName(ctx);
        sb.AppendLine($"public {(ContextIsPartial(ctx) ? "partial " : "")}class {name} : {ContextBaseClass(ctx)}");
        sb.AppendLine("{");
        if (EmitContextConstructor(ctx))
        {
            sb.AppendLine($"    public {name}(DbContextOptions<{name}> options) : base(options) {{ }}");
            sb.AppendLine();
        }
        var members = ContextMemberLines(ctx).ToList();
        foreach (var line in members)
        {
            sb.AppendLine(line);
        }
        if (members.Count > 0)
        {
            sb.AppendLine();
        }
    }

    // What EmitUsings knows that ContextUsings' signature does not carry: whether a read-only field
    // needs the Metadata namespace, and the namespace the context is declared in (asked once, of
    // ContextNamespace). Null when ContextUsings is called on its own.
    private (bool NeedsMetadataUsing, string ContextNamespace)? _usingSite;

    /// <summary>
    /// Hook — the <c>using</c> lines of the context file, complete (<c>using X;</c>), in order.
    /// Default: <c>Microsoft.EntityFrameworkCore</c>; <c>Microsoft.EntityFrameworkCore.Metadata</c>
    /// when a <c>@readOnly</c> field needs <c>PropertySaveBehavior</c>; then every namespace an
    /// entity or view resolves to other than <see cref="ContextNamespace"/>, ordinal order (the
    /// context names every entity by its short name). Called once per context. Override to add a
    /// namespace your <see cref="ContextBaseClass"/> lives in, or to drop one whose objects you
    /// leave out of the context.
    /// </summary>
    protected virtual IEnumerable<string> ContextUsings(GenContext ctx)
    {
        var needsMetadataUsing = _usingSite?.NeedsMetadataUsing ?? false;
        var dbCtxNs = _usingSite?.ContextNamespace ?? ContextNamespace(ctx);
        var lines = new List<string> { "using Microsoft.EntityFrameworkCore;" };
        if (needsMetadataUsing)
            lines.Add("using Microsoft.EntityFrameworkCore.Metadata;");
        // Package-binding — pull in every per-package namespace the model uses. The DbContext
        // references EVERY entity by short name (DbSet<X>, modelBuilder.Entity<X>()),
        // so it needs a `using` for each distinct namespace the entities resolve to.
        var refNamespaces = ReportRows.WithReportRows(ctx)
            .Where(o => o.IsEntity() || o.DbView is not null)
            .Select(o => PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(o), o.Name))
            .Where(ns => !string.IsNullOrEmpty(ns) && ns != dbCtxNs)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(ns => ns, StringComparer.Ordinal);
        lines.AddRange(refNamespaces.Select(ns => $"using {ns};"));
        return lines;
    }

    /// <summary>
    /// Hook — the generated context's class name, used for the declaration and its constructor.
    /// Default <c>AppDbContext</c>, always: <see cref="GenConfig.ContextTypeName"/> is the type the
    /// callable wrappers and reverse finders TAKE, which an adopter may define itself (often as a
    /// subclass of <c>AppDbContext</c>), so it does not name this class. The file stays
    /// <c>AppDbContext.g.cs</c>. An override renames only this declaration: the routes generator
    /// still names <c>AppDbContext</c> in its handlers, and keeping it consistent (an owned routes
    /// generator, or a <c>ContextTypeName</c> to match) is the adopter's.
    /// </summary>
    protected virtual string ContextClassName(GenContext ctx) => "AppDbContext";

    /// <summary>
    /// Hook — the namespace the context is declared in. Default: <see cref="GenConfig.Namespace"/>.
    /// Every entity namespace other than this one gets a <c>using</c>.
    /// </summary>
    protected virtual string ContextNamespace(GenContext ctx) => ctx.Config.Namespace;

    /// <summary>
    /// Hook — whether the context declares its <c>(DbContextOptions&lt;TContext&gt; options)</c>
    /// constructor. Default <c>true</c>. Return <c>false</c> when a hand-written partial owns the
    /// constructors (to inject services the generated one cannot know about).
    /// </summary>
    protected virtual bool EmitContextConstructor(GenContext ctx) => true;

    /// <summary>
    /// Hook — whether the context class is declared <c>partial</c>. Default <c>false</c>, the
    /// declaration it has always had. Return <c>true</c> to pair it with a hand-written partial.
    /// </summary>
    protected virtual bool ContextIsPartial(GenContext ctx) => false;

    /// <summary>
    /// Hook — extra class members, as complete lines (4-space indent included), placed after the
    /// constructor and before the <c>DbSet</c> declarations; a blank line follows them when there
    /// are any. Default none. An adopter declares a partial method here
    /// (<c>partial void OnModelCreatingExtensions(ModelBuilder modelBuilder);</c>) that its
    /// <see cref="ContextTrailerLines"/> call, and its hand-written partial, implement.
    /// </summary>
    protected virtual IEnumerable<string> ContextMemberLines(GenContext ctx) => [];

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
            sb.AppendLine(DbSetLine(o, ctx));
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
    /// <summary>The most configuration entries <c>OnModelCreating</c> holds before they are split into
    /// <c>ConfigureModelNN</c> methods, called in order. One method holding every entry of a large model has
    /// a stack frame too big for a thread-pool thread in a Debug build (each converter lambda is an
    /// expression tree built from locals), so building the model overflows the stack. A model within the
    /// limit is emitted as before.</summary>
    public int ModelConfigChunkSize { get; init; } = 200;

    protected virtual void EmitOnModelCreatingBody(StringBuilder sb, IReadOnlyList<string> modelLines, GenContext ctx)
    {
        // Materialized once: a hook may enumerate lazily, and each is asked exactly once per context.
        var preamble = ContextPreambleLines(ctx).ToList();
        var trailer = ContextTrailerLines(ctx).ToList();
        if (modelLines.Count == 0 && preamble.Count == 0 && trailer.Count == 0 && !AlwaysEmitOnModelCreating(ctx))
        {
            return;
        }
        sb.AppendLine();
        sb.AppendLine("    protected override void OnModelCreating(ModelBuilder modelBuilder)");
        sb.AppendLine("    {");
        // Order is part of the contract: preamble first, the model lines (or the ConfigureModelNN
        // calls that stand for them) in order, trailer last.
        foreach (var line in preamble)
        {
            sb.AppendLine(line);
        }
        if (modelLines.Count <= ModelConfigChunkSize)
        {
            foreach (var line in modelLines) sb.AppendLine(line);
            foreach (var line in trailer)
            {
                sb.AppendLine(line);
            }
            sb.AppendLine("    }");
            return;
        }
        var chunks = modelLines.Chunk(Math.Max(1, ModelConfigChunkSize)).ToList();
        for (var i = 0; i < chunks.Count; i++)
        {
            sb.AppendLine($"        ConfigureModel{i + 1:D2}(modelBuilder);");
        }
        foreach (var line in trailer)
        {
            sb.AppendLine(line);
        }
        sb.AppendLine("    }");
        for (var i = 0; i < chunks.Count; i++)
        {
            sb.AppendLine();
            sb.AppendLine($"    private void ConfigureModel{i + 1:D2}(ModelBuilder modelBuilder)");
            sb.AppendLine("    {");
            foreach (var line in chunks[i]) sb.AppendLine(line);
            sb.AppendLine("    }");
        }
    }

    /// <summary>
    /// Hook — the base class of the generated context. Default <c>DbContext</c>. An adopter whose
    /// context derives from its own (an auditing or tenancy context) returns that type here.
    /// </summary>
    protected virtual string ContextBaseClass(GenContext ctx) => "DbContext";

    /// <summary>
    /// Hook — complete lines (8-space indent included, as <c>modelLines</c> are) placed FIRST in
    /// <c>OnModelCreating</c>, before any model configuration or <c>ConfigureModelNN</c> call.
    /// Default none. An adopter returns <c>base.OnModelCreating(modelBuilder);</c> here.
    /// These lines are NOT scanned when the file decides whether it needs the <c>PropertySaveBehavior</c>
    /// using or the <c>MapJsonb</c>, <c>UnmappedEnum</c> and <c>DurationInterval</c> helpers: that decision reads the
    /// entity model lines only, so a line here that depends on one of them must bring it itself.
    /// </summary>
    protected virtual IEnumerable<string> ContextPreambleLines(GenContext ctx) => [];

    /// <summary>
    /// Hook — complete lines placed LAST in <c>OnModelCreating</c>, after the model configuration
    /// (or after the <c>ConfigureModelNN</c> calls when the model is split). Default none. An
    /// adopter returns a partial extension hook call here.
    /// Like the preamble, these lines are not scanned for using / helper gating.
    /// </summary>
    protected virtual IEnumerable<string> ContextTrailerLines(GenContext ctx) => [];

    /// <summary>
    /// Hook — whether <c>OnModelCreating</c> is emitted even when there is nothing to put in it
    /// (no model lines, no preamble, no trailer). Default <c>false</c>: an empty method is omitted.
    /// </summary>
    protected virtual bool AlwaysEmitOnModelCreating(GenContext ctx) => false;

    /// <summary>
    /// Hook — the whole <c>DbSet</c> declaration line for an entity (indent included), so an
    /// override can add <c>virtual</c> or change the name. The XML doc above it is emitted by the
    /// caller. A write-through entity's read-model <c>DbSet</c> is not routed through here.
    /// </summary>
    protected virtual string DbSetLine(MetaObject entity, GenContext ctx)
    {
        var name = CSharpNaming.Pascal(entity.Name);
        return $"    public DbSet<{name}> {DbSetPropertyName(entity, ctx)} {{ get; set; }} = default!;";
    }

    /// <summary>
    /// Hook — the DbSet property name for an object: its <c>@dbSetName</c>, else the derived
    /// plural (<see cref="CSharpNaming.DbSetName"/>). The context's collision check compares
    /// this name, so an override that renames the property is checked as it emits it.
    /// </summary>
    protected virtual string DbSetPropertyName(MetaObject entity, GenContext ctx) => CSharpNaming.DbSetName(entity);

    /// <summary>
    /// Hook — extra configuration lines appended after everything else an entity is configured
    /// with (field types, defaults, M:N, TPH discriminator, references). Default none. For the
    /// adopter's own per-entity lines: indexes, CHECK constraints, query filters, computed columns.
    /// Called for each table-mapped entity (not a TPH subtype, not a read-only projection).
    /// </summary>
    protected virtual IEnumerable<string> EntityConfigTrailer(MetaObject entity, GenContext ctx) => [];

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
    protected virtual string? DbColumnTypeConfig(string owner, MetaField f)
    {
        var prop = PropertyName(f);
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
    private string HasDiscriminatorConfig(string owner, MetaObject baseEntity, TphPlan tph, GenConfig config)
    {
        var discField = baseEntity.FindField(tph.DiscriminatorField);
        var discProp = discField is not null ? PropertyName(discField) : CSharpNaming.Pascal(tph.DiscriminatorField);
        var isEnum = discField is not null && discField.SubType == FIELD_SUBTYPE_ENUM;
        // The enum type is nested in the base class, so qualify it (<Base>.<EnumType>)
        // when referenced from the DbContext (a sibling type) — global::-qualified
        // (CSharpNaming.QualifiedOwnerTypeRef), not bare: a bare <Base> can resolve to
        // this DbContext's own same-named DbSet property instead of the entity type
        // (CS1061), which an already-plural base entity name now reaches.
        // FR-019: a SHARED (root-level abstract) or @provided enum is not nested in the base —
        // it is named where it lives, exactly as EnumConversionCall names it.
        var enumType = discField is not null && isEnum
            ? Fr019SharedEnum.SharedEnumForField(discField) is { } shared
                ? Fr019SharedEnum.SharedEnumTypeReference(shared, config)
                : $"{CSharpNaming.QualifiedOwnerTypeRef(owner, baseEntity, config)}.{CSharpNaming.EnumTypeName(baseEntity, discField)}"
            : null;

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
        MetaObject entity, TphPlan? tph, GenContext ctx, List<string> modelLines,
        IReadOnlySet<string>? ownedByUsingEntity)
    {
        // Seeded with the junction columns UsingEntityConfig already configures, so those
        // two are skipped while any OTHER reference the junction declares is still emitted.
        var emitted = ownedByUsingEntity is null
            ? new HashSet<string>(StringComparer.Ordinal)
            : new HashSet<string>(ownedByUsingEntity, StringComparer.Ordinal);

        foreach (var reference in entity.ReferenceIdentities().Where(r => r.Enforce))
        {
            if (!emitted.Add(FkKey(reference))) continue;
            modelLines.AddRange(ReferenceConfig(entity, reference, ctx));
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
                modelLines.AddRange(ReferenceConfig(st.Entity, reference, ctx));
            }
        }

        // The abstract levels between the base and its concrete subtypes, once each, in the order
        // the subtypes reach them (nearest first). Their own references were on no type at all:
        // the column existed, and EF knew no relationship over it. An intermediate that is a class
        // (EmitAbstractShapes) is configured on its own builder, which makes it part of the EF
        // hierarchy and the foreign key one for all its leaves; one that is not (its fields are
        // folded into each concrete subtype) is configured on each of those subtypes.
        var concrete = new HashSet<MetaObject>(tph.Subtypes.Select(s => s.Entity));
        var seen = new HashSet<MetaObject>();
        foreach (var st in tph.Subtypes)
        {
            for (var mid = st.Entity.SuperData as MetaObject;
                 mid is not null && !ReferenceEquals(mid, entity);
                 mid = mid.SuperData as MetaObject)
            {
                if (concrete.Contains(mid)) continue; // a concrete subtype: the pass above
                if (!seen.Add(mid)) break;            // reached before, and so was everything above it
                var references = mid.OwnIdentities().OfType<MetaReferenceIdentity>().Where(r => r.Enforce).ToList();
                if (references.Count == 0) continue;
                var isClass = !InstanceArtifacts.IsAbstract(mid) || ctx.Config.EmitAbstractShapes;
                // Folded into its subtypes: the TOPMOST concrete ones only. A concrete subtype under
                // another concrete one below `mid` inherits that one's foreign key (EF builds the FK
                // on the declaring entity type), so configuring it again would repeat the line.
                var leaves = isClass
                    ? [mid]
                    : tph.Subtypes.Select(s => s.Entity)
                        .Where(e => DescendsFrom(e, mid) && !HasConcreteAncestorBelow(e, mid, concrete))
                        .ToList();
                foreach (var reference in references)
                {
                    if (!emitted.Add(FkKey(reference))) continue;
                    foreach (var leaf in leaves)
                        modelLines.AddRange(ReferenceConfig(leaf, reference, ctx));
                }
            }
        }
    }

    // Whether a concrete subtype sits strictly between `obj` and `ancestor` in obj's extends chain.
    private static bool HasConcreteAncestorBelow(MetaObject obj, MetaObject ancestor, IReadOnlySet<MetaObject> concrete)
    {
        for (var cursor = obj.SuperData as MetaObject; cursor is not null && !ReferenceEquals(cursor, ancestor);
             cursor = cursor.SuperData as MetaObject)
            if (concrete.Contains(cursor)) return true;
        return false;
    }

    private static bool DescendsFrom(MetaObject obj, MetaObject ancestor)
    {
        for (var cursor = obj.SuperData; cursor is not null; cursor = cursor.SuperData)
            if (ReferenceEquals(cursor, ancestor)) return true;
        return false;
    }

    /// <summary>
    /// Core <c>@default</c> as the column default EF knows about, so a database EF creates carries
    /// it and the model agrees with the schema <c>meta migrate</c> builds:
    /// <list type="bullet">
    ///   <item>A literal the property's CLR type can hold (bool, string, a number, an enum member)
    ///   is <c>HasDefaultValue(v).HasSentinel(v)</c>. The sentinel is the load-bearing half. EF
    ///   leaves a property with a database default out of the INSERT when its value equals the
    ///   sentinel, which is otherwise the CLR default — so a bool defaulting to <c>true</c> would
    ///   store <c>true</c> when the app set <c>false</c>, and a nullable one its explicit NULL.
    ///   With the declared default as the sentinel, EF omits only the value the database would
    ///   write anyway, for nullable and non-nullable properties alike.</item>
    ///   <item>A SQL expression (<c>now()</c>, anything function-like, <c>current_timestamp</c>;
    ///   a bare <c>now</c> is <c>now()</c>, as migrate reads it) or a literal of a type with no
    ///   C# literal here (a timestamp, date, uuid) is <c>HasDefaultValueSql(...)</c>, on a
    ///   REQUIRED property only. Its sentinel stays the CLR default, which on a non-nullable
    ///   property means "not supplied"; on a nullable one it is NULL, and an app that set NULL on
    ///   purpose would get the default instead, so those are left out.</item>
    /// </list>
    /// Not configured: primary-key fields, arrays, value objects, maps and durations.
    /// </summary>
    private void EmitDefaultValueConfig(
        MetaObject entity, IEnumerable<MetaField> fields, GenContext ctx, List<string> modelLines)
    {
        foreach (var f in fields)
        {
            modelLines.AddRange(DefaultValueConfig(entity, f, ctx));
        }
    }

    /// <summary>
    /// Hook — the column-default configuration lines for one field (see the summary above):
    /// <c>HasDefaultValue/HasSentinel</c>, <c>HasDefaultValueSql</c>, or none. Called for EVERY field
    /// of a configured entity, so an override can add a default the metadata does not carry;
    /// the base returns nothing for a primary-key field, an array, a field with no <c>@default</c>
    /// and a <c>@dbColumnType</c> override. The emitted class is the entity's own name.
    /// </summary>
    protected virtual IEnumerable<string> DefaultValueConfig(MetaObject entity, MetaField f, GenContext ctx)
    {
        var className = CSharpNaming.Pascal(entity.Name);
        var pk = entity.PrimaryIdentity()?.Fields ?? [];
        if (f.Default is not { } raw || f.ResolvedIsArray() || pk.Contains(f.Name))
        {
            return [];
        }
        if (CSharpNaming.DbColumnTypeClrOverride(f) is not null)
        {
            return [];
        }
        var lhs = $"        modelBuilder.Entity<{className}>().Property(x => x.{PropertyName(f)})";
        if (DefaultLiteral(className, entity, f, raw, ctx.Config) is { } literal)
        {
            return [$"{lhs}.HasDefaultValue({literal}).HasSentinel({literal});"];
        }
        if (!CSharpNaming.IsRequired(entity, f) || DefaultSql(f, raw) is not { } sql)
        {
            return [];
        }
        return [$"{lhs}.HasDefaultValueSql(\"{CSharpNaming.CSharpStringLiteral(sql)}\");"];
    }

    /// <summary>
    /// <c>identity.primary @sequenceStart</c> on a single-field <c>increment</c> key: a fresh
    /// database's identity begins there, as <c>meta migrate</c> creates it (<c>GENERATED BY
    /// DEFAULT AS IDENTITY (START WITH n)</c>). Set as the annotation Npgsql's
    /// <c>HasIdentityOptions</c> writes, inside the provider check, so the context itself needs
    /// no Npgsql reference. A start-only change never restarts the sequence: Npgsql alone would
    /// write <c>RESTART WITH n</c> (or <c>RESTART WITH 1</c> when the start is removed), handing
    /// out ids live rows hold, so the generated design-time services
    /// (<see cref="DesignTimeServicesFile"/>) scaffold it as SQL instead.
    /// </summary>
    private static void EmitIdentityStartConfig(string owner, MetaObject entity, List<string> modelLines)
    {
        if (IdentityStartOf(entity) is not { } start) return;
        // One entry, one statement: the guard and its body never split across a chunk boundary.
        modelLines.Add($"        if (Database.ProviderName == \"{NpgsqlProviderName}\") modelBuilder.Entity<{owner}>().Property(x => x.{CSharpNaming.Pascal(start.Field.Name)}).HasAnnotation(" +
            $"\"{NpgsqlIdentityOptionsAnnotation}\", \"'{start.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)}', '1', '', '', 'False', '1'\");");
    }

    /// <summary>
    /// The table's CHECK constraints (item 13, rulings R55): every validator that can carry one and
    /// every scalar <c>field.enum</c>, with <c>meta migrate</c>'s names and expression text
    /// (<see cref="CheckConstraints"/>), so an EF migration and <c>meta migrate</c> build the same
    /// table. Declared only on a dialect migrate builds (<c>postgres</c>, <c>sqlite</c>, <c>d1</c>):
    /// the text is dialect-specific and EF hands it to the provider verbatim. One statement per entry.
    /// </summary>
    protected virtual void EmitCheckConfig(string owner, MetaObject entity, GenContext ctx, List<string> modelLines)
    {
        if (entity.DbTable is null) return;
        foreach (var check in CheckConstraints.For(entity, ctx.Config))
            modelLines.Add($"        modelBuilder.Entity<{owner}>().ToTable(t => t.HasCheckConstraint(\"{CSharpNaming.CSharpStringLiteral(check.Name)}\", " +
                $"\"{CSharpNaming.CSharpStringLiteral(check.Expression)}\"));");
    }

    private const string NpgsqlIdentityOptionsAnnotation = "Npgsql:IdentitySequenceOptions";
    private const string DesignTimeServicesSuffix = "DesignTimeServices";

    /// <summary>
    /// Whether this run emits <c>@sequenceStart</c> and the design-time services: the project's
    /// dialect is Postgres. The start is Npgsql's annotation, so a project on any other dialect, or
    /// naming none, gets neither it nor the services, and a migration can never RESTART.
    /// </summary>
    private static bool IdentityStartOn(GenContext ctx) =>
        string.Equals(ctx.Config.Dialect, "postgres", StringComparison.OrdinalIgnoreCase);

    /// <summary>The field of an entity's single-field increment key — the key a start applies to — or null.</summary>
    private static MetaField? IncrementKeyOf(MetaObject entity) =>
        entity.PrimaryIdentity() is MetaPrimaryIdentity { Fields.Count: 1, Generation: GENERATION_INCREMENT } pk
            ? entity.FindField(pk.Fields[0])
            : null;

    /// <summary>The <c>@sequenceStart</c> of an entity's single-field increment key, or null.</summary>
    private static (MetaField Field, long Value)? IdentityStartOf(MetaObject entity)
    {
        if (IncrementKeyOf(entity) is not { } field || entity.PrimaryIdentity()!.Attr(DbConstants.IDENTITY_ATTR_SEQUENCE_START) is not { } raw) return null;
        return (field, Convert.ToInt64(raw, System.Globalization.CultureInfo.InvariantCulture));
    }

    /// <summary>
    /// The design-time services of a Postgres context, <c>&lt;Context&gt;DesignTimeServices</c> (rulings R50,
    /// R51, R59, R60; one class for every design-time concern): an
    /// <c>IDesignTimeServices</c> that wraps the model differ the context already has, so
    /// <c>dotnet ef migrations add</c> scaffolds every start-only identity change — a start added,
    /// changed or removed — as SQL, Up and Down, and never as the <c>AlterColumn</c> Npgsql would
    /// write as <c>RESTART</c>. The SQL records the start
    /// (<c>ALTER TABLE … ALTER COLUMN … SET START WITH n</c>; a removed start goes back to the
    /// identity default) and, for a declared start, moves the counter forward to
    /// <c>GREATEST(n, max(id) + 1)</c> when it is below that, and never back. That makes a database
    /// rebuilt by replaying migrations begin at <c>n</c> as a fresh one does, and never hands out an
    /// id a live row holds.
    /// <para>Ruling: design time only. The rewrite matters only when a migration is scaffolded;
    /// <c>Migrate()</c> executes the operations a migration already holds. Nothing is registered at
    /// runtime, and the file uses public EF types only (no Npgsql reference, no EF-internal type).
    /// The accepted residual risk: a migrations or startup project that neither is the context's
    /// project nor carries the reference still scaffolds a RESTART. <c>--verbose</c> prints "Using
    /// design-time services from assembly …" when the services are found.</para>
    /// <para>EF looks for <c>IDesignTimeServices</c> implementations in the startup assembly, and
    /// for <c>[assembly: DesignTimeServicesReference]</c> in the startup and migrations assemblies.
    /// The reference is generated beside the class when the context's assembly name is known
    /// (<see cref="GenConfig.ContextAssemblyName"/>), so EF's default layout, where the migrations
    /// live in the context's assembly, needs no adopter code.</para>
    /// </summary>
    private string DesignTimeServicesFile(GenContext ctx, string className)
    {
        var ns = ContextNamespace(ctx);
        var assembly = ctx.Config.ContextAssemblyName;
        var reference = $"[assembly: DesignTimeServicesReference(\"{ns}.{className}, {assembly ?? "<assembly>"}\", \"{NpgsqlProviderName}\")]";
        if (assembly is null)
            ctx.Warn($"{Name}: {className}.g.cs carries no DesignTimeServicesReference: the context's assembly name is unknown " +
                "(no single .csproj in the output directory or above it; set GenConfig.ContextAssemblyName). EF finds the services " +
                "only when the context's project is the startup project; otherwise a changed @sequenceStart scaffolds as RESTART. " +
                $"Add [assembly: DesignTimeServicesReference(\"{ns}.{className}, <assembly>\")] to the migrations or startup project.");
        return $$"""
            // <auto-generated/>
            // Generated by MetaObjects db-context. Do not edit by hand.
            #nullable enable
            using System;
            using System.Collections.Generic;
            using System.Linq;
            using Microsoft.EntityFrameworkCore;
            using Microsoft.EntityFrameworkCore.Design;
            using Microsoft.EntityFrameworkCore.Infrastructure;
            using Microsoft.EntityFrameworkCore.Metadata;
            using Microsoft.EntityFrameworkCore.Migrations;
            using Microsoft.EntityFrameworkCore.Migrations.Operations;
            using Microsoft.EntityFrameworkCore.Storage;
            using Microsoft.Extensions.DependencyInjection;
            {{(assembly is null ? "" : "\n" + reference + "\n")}}
            namespace {{ns}};

            /// <summary>Design-time only: a start-only identity change scaffolds as SQL that records the
            /// start and moves the counter forward to it, never back, instead of Npgsql's RESTART; and a
            /// JSON column's comment, which EF 8 cannot carry, scaffolds as COMMENT ON COLUMN. EF runs
            /// it for <c>dotnet ef migrations add</c>; nothing is registered at runtime.</summary>
            public sealed class {{className}} : IDesignTimeServices
            {
                private const string Options = "{{NpgsqlIdentityOptionsAnnotation}}";
                private const string Strategy = "Npgsql:ValueGenerationStrategy";

                /// <summary>Wraps the differ already registered (the context's own, by default), once.</summary>
                public void ConfigureDesignTimeServices(IServiceCollection services)
                {
                    // Found by the startup scan and by the reference both: wrap once.
                    if (services.Any(d => d.ServiceType == typeof(Applied))) return;
                    services.AddSingleton<Applied>();
                    var inner = services.LastOrDefault(d => d.ServiceType == typeof(IMigrationsModelDiffer) && d.ServiceKey is null);
                    services.Add(new ServiceDescriptor(typeof(IMigrationsModelDiffer),
                        sp => new Differ(Resolve(inner, sp), sp.GetRequiredService<ICurrentDbContext>().Context.GetService<ISqlGenerationHelper>()),
                        inner?.Lifetime ?? ServiceLifetime.Transient));
                }

                private sealed class Applied { }

                private static IMigrationsModelDiffer Resolve(ServiceDescriptor? inner, IServiceProvider sp) => inner switch
                {
                    { ImplementationInstance: IMigrationsModelDiffer differ } => differ,
                    { ImplementationFactory: { } factory } => (IMigrationsModelDiffer)factory(sp),
                    { ImplementationType: { } type } => (IMigrationsModelDiffer)ActivatorUtilities.CreateInstance(sp, type),
                    _ => sp.GetRequiredService<ICurrentDbContext>().Context.GetService<IMigrationsModelDiffer>(),
                };

                private sealed class Differ(IMigrationsModelDiffer inner, ISqlGenerationHelper sql) : IMigrationsModelDiffer
                {
                    public bool HasDifferences(IRelationalModel? source, IRelationalModel? target) => inner.HasDifferences(source, target);

                    public IReadOnlyList<MigrationOperation> GetDifferences(IRelationalModel? source, IRelationalModel? target)
                    {
                        var result = new List<MigrationOperation>();
                        foreach (var operation in inner.GetDifferences(source, target))
                        {
                            if (operation is not AlterColumnOperation alter || StartChange(alter, sql) is not { } change)
                            {
                                result.Add(operation);
                                continue;
                            }
                            result.AddRange(change.Statements.Select(s => new SqlOperation { Sql = s }));
                            if (OnlyTheStart(alter, change.OldOptions)) continue;
                            // The rest of the change, with the old start made the new one: no start change is left in it.
                            alter.OldColumn[Options] = change.OldOptions;
                            result.Add(alter);
                        }
                        result.AddRange(JsonColumnComments(source, target, sql).Select(s => new SqlOperation { Sql = s }));
                        return result;
                    }
                }

                // Ruling R59: EF 8's JsonColumn carries no comment, so a JSON column's comment rides on
                // its owned type as an annotation and is scaffolded here, after every other operation
                // (a new table's column exists by then). Down is the same diff the other way.
                private const string JsonComment = "{{JsonColumnCommentAnnotation}}";

                private static IEnumerable<string> JsonColumnComments(IRelationalModel? source, IRelationalModel? target, ISqlGenerationHelper sql)
                {
                    var from = JsonCommentsOf(source);
                    foreach (var (column, text) in JsonCommentsOf(target))
                        if (!from.TryGetValue(column, out var old) || old != text)
                            yield return CommentOn(column, text, sql);
                    foreach (var (column, _) in from)
                        if (!JsonCommentsOf(target).ContainsKey(column)
                            && target?.FindTable(column.Table, column.Schema)?.FindColumn(column.Column) is not null)
                            yield return CommentOn(column, null, sql);
                }

                private static Dictionary<(string? Schema, string Table, string Column), string> JsonCommentsOf(IRelationalModel? model)
                {
                    var comments = new Dictionary<(string? Schema, string Table, string Column), string>();
                    if (model is null) return comments;
                    foreach (var type in model.Model.GetEntityTypes())
                        if (type.FindAnnotation(JsonComment)?.Value is string text
                            && type.GetContainerColumnName() is { } column && type.GetTableName() is { } table)
                            comments[(type.GetSchema(), table, column)] = text;
                    return comments;
                }

                private static string CommentOn((string? Schema, string Table, string Column) c, string? text, ISqlGenerationHelper sql) =>
                    "COMMENT ON COLUMN " + sql.DelimitIdentifier(c.Table, c.Schema) + "." + sql.DelimitIdentifier(c.Column)
                    + " IS " + (text is null ? "NULL" : Literal(text)) + sql.StatementTerminator;

                // The serialized options are "'start', 'increment', 'min', 'max', 'cyclic', 'cache'";
                // a missing annotation is Npgsql's defaults, and an empty start is no start.
                private const string Defaults = "'', '1', '', '', 'False', '1'";
                private static string[] Parts(string? options) => (options ?? Defaults).Split(',').Select(p => p.Trim().Trim('\'')).ToArray();
                private static string? Start(string? options) => Parts(options)[0] is { Length: > 0 } start ? start : null;

                /// <summary><paramref name="options"/> with the start replaced: what the old column
                /// must say for Npgsql to see no start change.</summary>
                private static string WithStart(string? options, string? start) =>
                    "'" + (start ?? "") + "'" + (options ?? Defaults)[(options ?? Defaults).IndexOf(',')..];

                private static bool Descending(string? options) => long.TryParse(Parts(options)[1], out var increment) && increment < 0;

                /// <summary>Where an identity without a start begins: its minimum ascending, its
                /// maximum descending (PostgreSQL's default).</summary>
                private static string DefaultStart(string? options)
                {
                    var p = Parts(options);
                    return Descending(options) ? (p[3] is { Length: > 0 } max ? max : "-1") : (p[2] is { Length: > 0 } min ? min : "1");
                }

                private static bool IsIdentity(object? strategy) => strategy?.ToString()?.StartsWith("Identity", StringComparison.Ordinal) == true;

                private static string Literal(string text) => "'" + text.Replace("'", "''") + "'";

                /// <summary>The SQL of the start-only change an alter carries, or null when it moves no start.</summary>
                private static (IReadOnlyList<string> Statements, string OldOptions)? StartChange(AlterColumnOperation operation, ISqlGenerationHelper sql)
                {
                    if (!IsIdentity(operation[Strategy]) || !IsIdentity(operation.OldColumn[Strategy])) return null;
                    var to = operation[Options] as string;
                    var from = operation.OldColumn[Options] as string;
                    if (Start(to) == Start(from)) return null;
                    var table = sql.DelimitIdentifier(operation.Table, operation.Schema);
                    var column = sql.DelimitIdentifier(operation.Name);
                    var statements = new List<string>
                    {
                        "ALTER TABLE " + table + " ALTER COLUMN " + column + " SET START WITH " + (Start(to) ?? DefaultStart(to)) + sql.StatementTerminator,
                    };
                    // A declared start also moves the counter forward to it, or past the highest id, and
                    // never back. A removed start, or a descending identity, records the start only.
                    if (Start(to) is { } start && !Descending(to))
                        statements.Add(
                            "DO $$\n" +
                            "DECLARE\n" +
                            "    mo_seq regclass := pg_get_serial_sequence(" + Literal(table) + ", " + Literal(operation.Name) + ")::regclass;\n" +
                            "    mo_target bigint;\n" +
                            "    mo_next bigint;\n" +
                            "BEGIN\n" +
                            "    SELECT GREATEST(" + start + ", COALESCE(MAX(" + column + "), 0) + 1) INTO mo_target FROM " + table + ";\n" +
                            "    EXECUTE 'SELECT CASE WHEN is_called THEN last_value + ' || (SELECT seqincrement FROM pg_sequence WHERE seqrelid = mo_seq)\n" +
                            "        || ' ELSE last_value END FROM ' || mo_seq INTO mo_next;\n" +
                            "    IF mo_next < mo_target THEN PERFORM setval(mo_seq, mo_target, false); END IF;\n" +
                            "END $$;");
                    return (statements, WithStart(from, Start(to)));
                }

                /// <summary>Whether the alter changes nothing but its identity start.</summary>
                private static bool OnlyTheStart(AlterColumnOperation operation, string oldOptions)
                {
                    var o = operation.OldColumn;
                    if (operation.ClrType != o.ClrType || operation.ColumnType != o.ColumnType || operation.IsNullable != o.IsNullable
                        || operation.IsUnicode != o.IsUnicode || operation.IsFixedLength != o.IsFixedLength || operation.MaxLength != o.MaxLength
                        || operation.Precision != o.Precision || operation.Scale != o.Scale || operation.IsRowVersion != o.IsRowVersion
                        || !Equals(operation.DefaultValue, o.DefaultValue) || operation.DefaultValueSql != o.DefaultValueSql
                        || operation.ComputedColumnSql != o.ComputedColumnSql || operation.IsStored != o.IsStored
                        || operation.Comment != o.Comment || operation.Collation != o.Collation)
                        return false;
                    var names = operation.GetAnnotations().Select(a => a.Name).Union(o.GetAnnotations().Select(a => a.Name));
                    return names.All(n => n == Options
                        ? Parts(operation[n] as string).SequenceEqual(Parts(oldOptions))
                        : Equals(operation[n], o[n]));
                }
            }
            """ + "\n";
    }

    /// <summary>
    /// Core <c>@description</c> as the database comment, as <c>meta migrate</c> writes it
    /// (<c>COMMENT ON TABLE</c> / <c>COMMENT ON COLUMN</c>): an entity's on its table, a field's
    /// on its column, read resolving. Set through the metadata API, which reaches every property
    /// kind; a flattened value object is not a column (its members are), so it gets none.
    /// </summary>
    private void EmitCommentConfig(string owner, MetaObject entity, IEnumerable<MetaField> fields, List<string> modelLines,
        GenContext ctx, bool tableComment = true)
    {
        if (tableComment && entity.Attr(MetaObjects.Core.Documentation.DocumentationConstants.DOC_ATTR_DESCRIPTION) is string { Length: > 0 } table)
            modelLines.Add($"        modelBuilder.Entity<{owner}>().Metadata.SetComment(\"{CSharpNaming.CSharpStringLiteral(table)}\");");
        foreach (var f in fields)
        {
            var vo = f.SubType == FIELD_SUBTYPE_OBJECT ? ValueObjectNames.ResolveFieldRef(f, ctx.Root) as MetaObject : null;
            // A JSON column's comment falls back to its value object's description (ruling R59).
            var text = f.Attr(MetaObjects.Core.Documentation.DocumentationConstants.DOC_ATTR_DESCRIPTION) as string;
            if (string.IsNullOrEmpty(text) && vo is not null)
                text = vo.Attr(MetaObjects.Core.Documentation.DocumentationConstants.DOC_ATTR_DESCRIPTION) as string;
            if (string.IsNullOrEmpty(text)) continue;
            var literal = CSharpNaming.CSharpStringLiteral(text);
            if (f.SubType == FIELD_SUBTYPE_OBJECT)
            {
                // Flattened: the members are the columns, and the object is none.
                if (f.Storage == STORAGE_FLATTENED || vo is null) continue;
                // An owned JSON column (ToJson): EF 8's JsonColumn carries no comment, so the comment
                // rides on the owned type as an annotation, and the design-time differ scaffolds it as
                // COMMENT ON COLUMN (ruling R59). A value object holding a map is a plain converted
                // property instead, and takes the comment as any column does.
                if (!HoldsMap(vo, ctx.Root, new HashSet<MetaObject>()))
                {
                    if (!IdentityStartOn(ctx))
                    {
                        ctx.Warn($"{Name}: the @description of {entity.Name}.{f.Name} is not in the EF model: a JSON column carries " +
                            "no comment in EF 8, and only a Postgres project's design-time services scaffold one. meta migrate still writes it.");
                        continue;
                    }
                    modelLines.Add($"        modelBuilder.Entity<{owner}>().Metadata.FindNavigation(\"{PropertyName(f)}\")!.TargetEntityType" +
                        $".SetAnnotation(\"{JsonColumnCommentAnnotation}\", \"{literal}\");");
                    continue;
                }
            }
            // GetProperty, not FindProperty?.: a property this generator configures and cannot find is a bug, said loudly.
            modelLines.Add($"        modelBuilder.Entity<{owner}>().Metadata.GetProperty(\"{PropertyName(f)}\").SetComment(\"{literal}\");");
        }
    }

    /// <summary>The owned-type annotation carrying a JSON column's comment (ruling R59).</summary>
    internal const string JsonColumnCommentAnnotation = "MetaObjects:JsonColumnComment";

    /// <summary>
    /// The index vocabulary as EF indexes, named as <c>meta migrate</c> names them, so a model
    /// over the migrated database declares the indexes it has (an EF migration would otherwise
    /// drop them): a field's <c>@unique</c> (<c>&lt;table&gt;_&lt;column&gt;_unique</c>), an
    /// <c>identity.secondary</c> (unique) and an <c>index.lookup</c>, each with <c>@where</c>
    /// (<c>HasFilter</c>), <c>@using</c> (<c>HasMethod</c>) and <c>@orders</c>
    /// (<c>IsDescending</c>), under its resolved name. An <c>@expr</c> index is not one EF can
    /// model; <see cref="ExpressionIndexesGenerator"/> writes it as SQL.
    /// </summary>
    private void EmitIndexConfig(string owner, MetaObject entity, GenContext ctx, List<string> modelLines,
        IEnumerable<MetaField>? ownFields = null, Func<MetaData, bool>? declares = null)
    {
        var table = CSharpNaming.Table(entity);
        // A TPH subtype passes the fields and index nodes it adds beyond its ancestors in the model.
        foreach (var f in ownFields ?? entity.Fields())
        {
            // ADR-0039: resolving — @unique may be inherited via extends.
            if (f.Attr(FIELD_ATTR_UNIQUE) is not true || f.ResolvedIsArray()) continue;
            var column = CSharpNaming.Column(f, ctx.Config.ColumnNamingStrategy);
            modelLines.Add($"        modelBuilder.Entity<{owner}>().HasIndex(x => x.{PropertyName(f)}).IsUnique()" +
                $".HasDatabaseName(\"{CSharpNaming.CSharpStringLiteral($"{table}_{column}_unique")}\");");
        }
        var nodes = entity.SecondaryIdentities().Select(i => ((MetaData)i, i.Fields, true))
            .Concat(entity.LookupIndexes().Select(i => ((MetaData)i, i.Fields, false)))
            .Where(n => declares is null || declares(n.Item1))
            .ToList();
        foreach (var (node, fields, unique) in nodes)
        {
            if (node.Attr(DbConstants.IDENTITY_ATTR_EXPR) is string { Length: > 0 } || fields.Count == 0) continue;
            var props = new List<string>();
            foreach (var name in fields)
            {
                if (entity.FindField(name) is not { } mf) { props.Clear(); break; }
                props.Add(PropertyName(mf));
            }
            if (props.Count == 0) continue;
            var indexName = CSharpNaming.IndexRef(entity, node, ctx.Config.ColumnNamingStrategy, ctx.Config.IncludeNames);
            var selector = props.Count == 1 ? $"x => x.{props[0]}" : $"x => new {{ {string.Join(", ", props.Select(p => "x." + p))} }}";
            // The NAMED overload: two indexes over one column list (a partial one beside a plain
            // one) are two EF indexes only when each carries its own name.
            var line = new StringBuilder($"        modelBuilder.Entity<{owner}>().HasIndex({selector}, {indexName})");
            if (unique) line.Append(".IsUnique()");
            if (node.Attr(DbConstants.IDENTITY_ATTR_WHERE) is string where && where.Trim().Length > 0)
                line.Append($".HasFilter(\"{CSharpNaming.CSharpStringLiteral(where.Trim())}\")");
            if (node.Attr(DbConstants.IDENTITY_ATTR_ORDERS) is System.Collections.IEnumerable orderList and not string)
            {
                var desc = orderList.Cast<object?>().Select(o => string.Equals(o?.ToString(), "desc", StringComparison.OrdinalIgnoreCase)).ToList();
                if (desc.Any(d => d))
                    line.Append(".IsDescending(").Append(string.Join(", ", props.Select((_, i) => i < desc.Count && desc[i] ? "true" : "false"))).Append(')');
            }
            line.Append($".HasDatabaseName({indexName});");
            modelLines.Add(line.ToString());
            // @using: the access method, an Npgsql annotation (btree is the default and is left out).
            if (node.Attr(DbConstants.IDENTITY_ATTR_USING) is string method && method.Trim().Length > 0 && method.Trim() != "btree")
            {
                // One entry per statement (the modelLines invariant): the guard and its statement are one line.
                modelLines.Add($"        if (Database.ProviderName == \"{NpgsqlProviderName}\") modelBuilder.Entity<{owner}>().HasIndex({selector}, {indexName})" +
                    $".HasAnnotation(\"Npgsql:IndexMethod\", \"{CSharpNaming.CSharpStringLiteral(method.Trim())}\");");
            }
        }
    }

    // The SQL expressions migrate treats as an expression default (expected-schema.ts
    // EXPR_DEFAULT_PATTERNS): the rest of a string default is a literal.
    private static readonly System.Text.RegularExpressions.Regex ExprDefault = new(
        @"^(current_timestamp|now\(\)|current_date|current_time)$|\(\)",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>A C# literal of the property's own CLR type for a <c>@default</c>, or <c>null</c>
    /// when the default is a SQL expression or its type has no literal form here.</summary>
    private static string? DefaultLiteral(string className, MetaObject entity, MetaField f, object raw, GenConfig config)
    {
        var text = Convert.ToString(raw, System.Globalization.CultureInfo.InvariantCulture) ?? "";
        if (f.SubType == FIELD_SUBTYPE_ENUM)
        {
            if (f.EffectiveEnumValues is not { } members || !members.Contains(text)) return null;
            var type = Fr019SharedEnum.SharedEnumForField(f) is { } shared
                ? Fr019SharedEnum.SharedEnumTypeReference(shared, config)
                : $"{CSharpNaming.QualifiedOwnerTypeRef(className, entity, config)}.{CSharpNaming.EnumTypeName(entity, f)}";
            return $"{type}.{text}";
        }
        var clr = CSharpNaming.ScalarForField(f);
        if (clr == "string")
            return text.Length > 0 && (ExprDefault.IsMatch(text) || text.Equals("now", StringComparison.OrdinalIgnoreCase))
                ? null
                : $"\"{CSharpNaming.CSharpStringLiteral(text)}\"";
        if (clr == "bool")
            return raw is bool b ? (b ? "true" : "false")
                : bool.TryParse(text, out var pb) ? (pb ? "true" : "false") : null;
        var suffix = clr switch
        {
            "int" => "", "long" => "L", "double" => "d", "float" => "f", "decimal" => "m",
            "short" => "", "byte" => "", _ => null,
        };
        if (suffix is null
            || !decimal.TryParse(text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out _))
            return null;
        // An integral literal for a short/byte property needs the cast: EF requires the default's
        // type to be the property's own.
        return clr is "short" or "byte" ? $"({clr}){text}" : text + suffix;
    }

    /// <summary>The SQL a <c>@default</c> that has no C# literal stands for: the expression as
    /// declared (a bare <c>now</c> as <c>now()</c>), or a quoted SQL literal.</summary>
    private static string? DefaultSql(MetaField f, object raw)
    {
        if (raw is not string text || f.SubType is FIELD_SUBTYPE_DURATION or FIELD_SUBTYPE_MAP or FIELD_SUBTYPE_OBJECT)
            return null;
        if (text.Equals("now", StringComparison.OrdinalIgnoreCase)) return "now()";
        if (text.Length > 0 && ExprDefault.IsMatch(text)) return text;
        return "'" + text.Replace("'", "''") + "'";
    }

    /// <summary>
    /// FR-017 TPH — the per-field configuration of the fields a concrete SUBTYPE declares beyond
    /// its TPH ancestors. A subtype gets no DbSet and is not in the emitted set, so the root's
    /// pass (over the root's own fields) never reaches them: an owned value object was left for
    /// EF to discover as an entity ("requires a primary key"), and a timestamp, enum, decimal,
    /// array or map column lost the mapping the same field gets on the root. Configured on the
    /// subtype's own builder, which EF applies to the shared table. A subtype that extends another
    /// concrete subtype configures only what it adds, since the parent is in the model already.
    /// </summary>
    private void EmitTphSubtypeFieldConfig(MetaObject root, TphPlan tph, GenContext ctx, List<string> modelLines)
    {
        foreach (var st in tph.Subtypes)
            modelLines.AddRange(TphSubtypeFieldConfig(root, st.Entity, ctx));
    }

    /// <summary>
    /// Hook — the per-field configuration of one concrete TPH SUBTYPE (see the summary above):
    /// the field-type lines, the column defaults, the <c>SetAfterSaveBehavior</c> lines, the
    /// column comments and the indexes (<c>@unique</c>, <c>identity.secondary</c>,
    /// <c>index.lookup</c>) for what it declares beyond its TPH ancestors, on the subtype's own builder. Called once per
    /// subtype of each discriminator <paramref name="root"/>; empty for a subtype that adds no field.
    /// </summary>
    protected virtual IEnumerable<string> TphSubtypeFieldConfig(MetaObject root, MetaObject subtype, GenContext ctx)
    {
        var tph = TphPlanBuilder.For(root, ctx.Root);
        if (tph is null)
        {
            return [];
        }
        var concrete = new HashSet<MetaObject>(tph.Subtypes.Select(st => st.Entity));
        // The nearest ancestor already in the EF model: a concrete subtype, else the root.
        var cursor = subtype.SuperData as MetaObject;
        while (cursor is not null && cursor != root && !concrete.Contains(cursor))
        {
            cursor = cursor.SuperData as MetaObject;
        }
        var ancestor = cursor ?? root;
        var inherited = new HashSet<string>(ancestor.Fields().Select(f => f.Name), StringComparer.Ordinal);
        var own = subtype.Fields().Where(f => !inherited.Contains(f.Name)).ToList();
        // Resolving on both sides: an index node an abstract level between them declares is the
        // subtype's to configure, one the ancestor already resolves is configured there.
        var ancestorIndexes = new HashSet<string>(
            ancestor.SecondaryIdentities().Select(i => i.Name).Concat(ancestor.LookupIndexes().Select(i => i.Name)), StringComparer.Ordinal);
        var ownIndexes = subtype.SecondaryIdentities().Select(i => i.Name).Concat(subtype.LookupIndexes().Select(i => i.Name))
            .Where(n => !ancestorIndexes.Contains(n)).ToHashSet(StringComparer.Ordinal);
        if (own.Count == 0 && ownIndexes.Count == 0)
        {
            return [];
        }

        var lines = new List<string>();
        var cls = CSharpNaming.Pascal(subtype.Name);
        EmitFieldTypeConfig(cls, subtype, own, ctx, lines, jsonbObjectsOnly: false);
        EmitDefaultValueConfig(subtype, own, ctx, lines);
        foreach (var f in own.Where(f => !f.ResolvedIsArray() && f.Mutability != MUTABILITY_READ_WRITE))
        {
            lines.Add(
                $"        modelBuilder.Entity<{cls}>().Property(x => x.{PropertyName(f)}).Metadata.SetAfterSaveBehavior(PropertySaveBehavior.Ignore);");
        }
        // The shared table's comment is the root's; a subtype's own columns carry theirs.
        EmitCommentConfig(cls, subtype, own, lines, ctx, tableComment: false);
        EmitIndexConfig(cls, subtype, ctx, lines, own, n => ownIndexes.Contains(n.Name));
        return lines;
    }

    /// <summary>
    /// Under <see cref="GenConfig.EmitAbstractShapes"/>, a concrete class extends the abstract
    /// shape its entity extends, and the fields that shape declares live on the shape class —
    /// which carries no EF attributes by design. So the <c>[Key]</c>, <c>[Column]</c> and
    /// <c>[MaxLength]</c> those fields would have carried on the concrete class are configured
    /// here instead, or the model keys the entity by convention, names the columns after the
    /// properties, and drops the declared length. Nothing when the knob is off (the concrete
    /// class then declares every field itself, attributes included).
    /// </summary>
    private void EmitShapeInheritedFacets(
        string className, MetaObject entity, IEnumerable<MetaField> fields, GenContext ctx, List<string> modelLines)
    {
        if (!ctx.Config.EmitAbstractShapes) return;
        if (entity.SuperData is not MetaObject parent || !parent.IsEntity() || !InstanceArtifacts.IsAbstract(parent)
            || TphPlanBuilder.IsTphMember(parent, ctx.Root))
            return;
        var shapeDeclared = new HashSet<string>(parent.Fields().Select(f => f.Name), StringComparer.Ordinal);
        var lhs = $"        modelBuilder.Entity<{className}>()";

        if (entity.PrimaryIdentity()?.Fields is [var keyName] && shapeDeclared.Contains(keyName)
            && entity.FindField(keyName) is { } keyField)
            modelLines.Add($"{lhs}.HasKey(x => x.{PropertyName(keyField)});");

        foreach (var f in fields.Where(f => shapeDeclared.Contains(f.Name)))
        {
            var col = CSharpNaming.ColumnRef(entity, f, ctx.Config.ColumnNamingStrategy, ctx.Config.IncludeNames);
            var prop = PropertyName(f);
            var isScalar = CSharpNaming.ScalarFor(f.SubType) is not null;
            if (f.ResolvedIsArray() && (isScalar || f.SubType == FIELD_SUBTYPE_ENUM))
                modelLines.Add($"{lhs}.PrimitiveCollection(x => x.{prop}).HasColumnName({col});");
            else if (isScalar || f.SubType is FIELD_SUBTYPE_ENUM or FIELD_SUBTYPE_MAP)
                modelLines.Add($"{lhs}.Property(x => x.{prop}).HasColumnName({col})"
                    + (f.SubType == FIELD_SUBTYPE_STRING && EffectiveMaxLength(f) is { } max ? $".HasMaxLength({max})" : "")
                    + ";");
            // An object field's column is already named by its owned-type config.
        }
    }

    /// <summary>A string field's effective maximum length: the strictest of <c>@maxLength</c> and
    /// a <c>validator.length @max</c> — the same value EntityGenerator's <c>[MaxLength]</c> carries.</summary>
    private static long? EffectiveMaxLength(MetaField f)
    {
        long? max = f.MaxLength;
        foreach (var v in f.Validators())
            if (v.SubType == MetaObjects.Core.Validator.ValidatorConstants.VALIDATOR_SUBTYPE_LENGTH && v.Max is long lmax)
                max = max is long cur ? Math.Min(cur, lmax) : lmax;
        return max;
    }

    /// <summary>The key field of a single-column primary identity declared
    /// <c>@generation: assigned</c>, or <c>null</c>. A composite key is never generated by EF's
    /// convention, so it needs nothing.</summary>
    private static MetaField? AssignedKeyField(MetaObject entity) =>
        entity.PrimaryIdentity() is MetaPrimaryIdentity { Generation: GENERATION_ASSIGNED } pk
        && pk.Fields is [var only]
            ? entity.FindField(only)
            : null;

    /// <summary>
    /// Identity of the physical foreign key a reference defines: its ordered FK field
    /// names. A TPH subtype re-declaring its base's reference (to add an inverse, or just
    /// restating it) produces the same key, so the shared column is configured once.
    /// </summary>
    private static string FkKey(MetaReferenceIdentity reference) =>
        string.Join(",", ReferentialActions.ReadIdentityFields(reference));

    /// <summary>
    /// Hook — the relationship-configuration lines for one reference: one line, or none when it
    /// cannot be expressed (an unresolvable / non-persisted target, or an FK field the
    /// emitted class does not declare). Silent by design — a dangling <c>@references</c>
    /// is already a load error, and the other cases are shapes this generator
    /// deliberately does not map. <paramref name="entity"/> is the declaring entity (a TPH
    /// subtype for a reference it declares itself); the emitted class is its own name.
    /// </summary>
    protected virtual IEnumerable<string> ReferenceConfig(
        MetaObject entity, MetaReferenceIdentity reference, GenContext ctx)
    {
        var owner = CSharpNaming.Pascal(entity.Name);
        if (reference.TargetEntity is null)
        {
            return [];
        }
        var target = NamingRefs.RefTarget(reference, IDENTITY_REFERENCE_ATTR_REFERENCES) as MetaObject;
        if (target is null || !target.IsEntity() || !InstanceArtifacts.EmitsInstanceArtifacts(target))
            return [];

        var fkFields = ReferentialActions.ReadIdentityFields(reference);
        if (fkFields.Count == 0)
        {
            return [];
        }

        // G6: a reference whose fields are members of ONE flattened value object
        // (`address.countryId`) is a foreign key of that owned type, configured on its builder.
        if (fkFields.Any(f => f.Contains('.')))
            return FlattenedMemberReferenceConfig(entity, reference, target, fkFields, ctx);

        var props = new List<string>(fkFields.Count);
        var isWriteThrough = entity.IsWriteThrough();
        foreach (var name in fkFields)
        {
            // #214 — a write-through entity's WRITE class omits the derived (origin.*)
            // fields, so naming one here would reference a property the class does not
            // declare (a compile error in the generated file).
            if (entity.FindField(name) is not { } field)
            {
                return [];
            }
            if (isWriteThrough && field.IsDerived())
            {
                return [];
            }
            props.Add(PropertyName(field));
        }

        var actions = ReferentialActions.Resolve(entity, reference);
        return [$"        modelBuilder.Entity<{owner}>().HasOne<{CSharpNaming.Pascal(target.Name)}>()"
             + $".WithMany().HasForeignKey({ForeignKeyExpression("e", props)})"
             + PrincipalKeyCall(reference, target)
             + $"{OnDeleteCall(entity, fkFields, actions.OnDelete, ctx)}"
             + ConstraintNameCall(reference) + ";"];
    }

    /// <summary>
    /// G6 (reference half): the relationship for a reference whose <c>@fields</c> are members of
    /// one flattened value object. The member properties live on the owned type, so the foreign
    /// key is configured on its builder, one statement:
    /// <c>modelBuilder.Entity&lt;Plan&gt;().OwnsOne(x =&gt; x.Address).HasOne&lt;Country&gt;().WithMany().HasForeignKey(e =&gt; e.CountryId)</c>.
    /// Fields spread over the entity and a value object, or over two value objects, have no EF
    /// mapping: the run warns and configures none.
    /// </summary>
    private IEnumerable<string> FlattenedMemberReferenceConfig(
        MetaObject entity, MetaReferenceIdentity reference, MetaObject target, IReadOnlyList<string> fkFields, GenContext ctx)
    {
        var members = fkFields.Select(f => FlattenedMembers.Resolve(entity, f)).ToList();
        if (members.Any(m => m is null) || members.Select(m => m!.Embedding).Distinct().Count() != 1)
        {
            ctx.Warn($"{Name}: identity.reference \"{entity.Name}.{reference.Name}\" names fields that are not all members of one flattened value object ({string.Join(", ", fkFields)}); no foreign key is configured for it.");
            return [];
        }
        var owner = CSharpNaming.Pascal(entity.Name);
        var nav = PropertyName((MetaField)members[0]!.Embedding);
        var props = members.Select(m => PropertyName((MetaField)m!.Member)).ToList();
        var actions = ReferentialActions.Resolve(entity, reference);
        return [$"        modelBuilder.Entity<{owner}>().OwnsOne(x => x.{nav}).HasOne<{CSharpNaming.Pascal(target.Name)}>()"
             + $".WithMany().HasForeignKey({ForeignKeyExpression("e", props)})"
             + PrincipalKeyCall(reference, target)
             + $"{OnDeleteCall(entity, fkFields, actions.OnDelete, ctx)}"
             + ConstraintNameCall(reference) + ";"];
    }

    /// <summary>
    /// <c>.HasPrincipalKey(...)</c> when <c>@references</c> names target fields that are not the
    /// target's primary key (<c>"Warehouse.regionCode,siteNo"</c>), else <c>""</c>. Without it EF
    /// pairs the foreign key with the primary key: a composite FK then fails model validation
    /// ("cannot target the primary key ... because it is not compatible"), and a single column of
    /// the PK's type is silently joined to the wrong column. EF makes the named fields an
    /// alternate key, which is the unique constraint such a reference needs anyway.
    /// </summary>
    private string PrincipalKeyCall(MetaReferenceIdentity reference, MetaObject target)
    {
        var targetFields = reference.TargetFields;
        if (targetFields.Count == 0) return string.Empty;
        if (target.PrimaryIdentity()?.Fields is { } pk && pk.SequenceEqual(targetFields, StringComparer.Ordinal))
            return string.Empty;
        var props = new List<string>(targetFields.Count);
        foreach (var name in targetFields)
        {
            if (target.FindField(name) is not { } field) return string.Empty;
            props.Add(PropertyName(field));
        }
        return $".HasPrincipalKey({ForeignKeyExpression("p", props)})";
    }

    /// <summary><c>.HasConstraintName("...")</c> from the reference's <c>@constraintName</c>, so the
    /// model (and a database EF creates from it) names the FK the way the schema does; else <c>""</c>.</summary>
    private static string ConstraintNameCall(MetaReferenceIdentity reference) =>
        // ADR-0039: resolving — an inherited reference keeps its declared name.
        reference.Attr(DbConstants.IDENTITY_ATTR_CONSTRAINT_NAME) is string name && name.Length > 0
            ? $".HasConstraintName(\"{CSharpNaming.CSharpStringLiteral(name)}\")"
            : string.Empty;

    /// <summary>
    /// The <c>HasForeignKey</c> argument naming <paramref name="props"/> on the dependent:
    /// <c>e =&gt; e.Prop</c> for one column, <c>e =&gt; new { e.A, e.B }</c> for a composite.
    ///
    /// <para>A typed lambda rather than <c>nameof(&lt;Owner&gt;.Prop)</c>, and not by accident.
    /// This expression lands INSIDE the generated DbContext class body, where C# simple-name
    /// lookup binds <c>&lt;Owner&gt;</c> to a MEMBER of the context before it considers a type of
    /// the same name — and the context declares one DbSet property per entity. So an entity whose
    /// type name equals any DbSet property name made <c>nameof</c> read the DbSet and fail to
    /// compile (CS1061). That is reachable from stock metadata, not just exotic input:
    /// <c>Pluralize("Address") == "Addresses"</c>, so a model carrying both an <c>Address</c> and
    /// an <c>Addresses</c> entity broke. A lambda parameter is local, so nothing in scope can
    /// shadow it. A bare string literal would also dodge the shadowing but would give up
    /// compile-checking of the property name, turning a build error into a runtime EF failure.</para>
    /// </summary>
    private static string ForeignKeyExpression(string param, IReadOnlyList<string> props) =>
        props.Count == 1
            ? $"{param} => {param}.{props[0]}"
            : $"{param} => new {{ {string.Join(", ", props.Select(p => $"{param}.{p}"))} }}";

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
        const string noAction = ".OnDelete(DeleteBehavior.NoAction)";

        if (onDelete == ACTION_SET_NULL)
        {
            var required = fkFields.Where(n => entity.FindField(n) is { IsRequired: true }).ToList();
            if (required.Count > 0)
            {
                ctx.Warn($"{Name}: \"{entity.Name}\" resolves ON DELETE SET NULL over required " +
                         $"field(s) {string.Join(", ", required)} — SET NULL cannot fire on a NOT NULL " +
                         "column, so the foreign key is configured NoAction instead.");
                return noAction;
            }
        }

        return onDelete switch
        {
            ACTION_CASCADE => ".OnDelete(DeleteBehavior.Cascade)",
            ACTION_SET_NULL => ".OnDelete(DeleteBehavior.SetNull)",
            ACTION_RESTRICT => ".OnDelete(DeleteBehavior.Restrict)",
            // No resolved action — no correlated relationship, or an explicit `no-action`.
            // The TS-owned DDL emits no ON DELETE clause for this FK, so the database
            // behaves as NO ACTION, and saying so EXPLICITLY is the whole point: omitting
            // the call hands the decision to EF's convention, which for a REQUIRED foreign
            // key is Cascade. That would make the generated context delete rows the
            // database would have refused to orphan — a destructive disagreement with the
            // schema, introduced by the very change meant to end the disagreement.
            _ => noAction,
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

        var resolved = ReferentialActions.Resolve(junction, reference).OnDelete;
        // Only a DECLARED action is applied here — no NoAction default, unlike the 1:N
        // path. These two relationships are established by UsingEntityConfig and have
        // existed since FR-018 with EF's own convention deciding their delete behaviour;
        // pinning them to NoAction now would stop EF clearing junction rows on a tracked
        // delete, a behaviour change for every existing M:N adopter that has nothing to do
        // with #294. The 1:N path defaults precisely because those relationships are NEW
        // here: there is no prior behaviour to preserve, only EF's convention to prevent.
        var constraint = ConstraintNameCall(reference);
        if (resolved is null) return constraint;
        return OnDeleteCall(junction, [fkField], resolved, ctx) + constraint;
    }

    // A junction FK column's C# property, through the same resolver its entity class used.
    private string JunctionFkProperty(MetaObject junction, string fkField) =>
        junction.FindField(fkField) is { } f ? PropertyName(f) : CSharpNaming.Pascal(fkField);

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
        var sourceFkProp = JunctionFkProperty(nav.Junction, nav.SourceField);
        var targetFkProp = JunctionFkProperty(nav.Junction, nav.TargetField);
        var targetOnDelete = JunctionSideOnDelete(nav.Junction, nav.TargetField, ctx);
        var sourceOnDelete = JunctionSideOnDelete(nav.Junction, nav.SourceField, ctx);
        // Typed lambdas for the same reason the 1:N path uses them (see ForeignKeyExpression):
        // `nameof(<Through>.Prop)` inside the DbContext body binds <Through> to a same-named DbSet
        // property instead of the type. The inner parameter cannot reuse the outer `l`/`r` (CS0136),
        // hence `j` — it is the junction being configured on both sides.
        return
            $"        modelBuilder.Entity<{source}>().HasMany(x => x.{navProp}).WithMany().UsingEntity<{through}>(" +
            $"l => l.HasOne<{target}>().WithMany().HasForeignKey({ForeignKeyExpression("j", [targetFkProp])}){targetOnDelete}, " +
            $"r => r.HasOne<{source}>().WithMany().HasForeignKey({ForeignKeyExpression("j", [sourceFkProp])}){sourceOnDelete});";
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

    /// <summary>Name of the generated fail-fast helper the write converters end in.</summary>
    private const string UnmappedEnumMemberHelperName = "UnmappedEnumMember";

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
        sb.AppendLine();
        sb.AppendLine("    /// <summary>");
        sb.AppendLine("    /// An int-backed field.enum property held a value outside @values (a cast integer, or");
        sb.AppendLine("    /// a member the C# enum declares that the metadata does not): it has no declared");
        sb.AppendLine("    /// integer, and writing some other member's instead would corrupt the row silently.");
        sb.AppendLine("    /// </summary>");
        sb.AppendLine($"    private static int {UnmappedEnumMemberHelperName}(object? value, string field) =>");
        sb.AppendLine("        throw new System.InvalidOperationException(");
        sb.AppendLine("            $\"field.enum '{field}' cannot write {value}: it has no integer in \" +");
        sb.AppendLine("            \"@intValueMap — the value is not one of the members the model declares.\");");
    }

    /// <summary>
    /// The EF config line pinning one <c>field.map</c> to its jsonb column: the column type
    /// plus the shared converter/comparer pair. Shared by the entity/write-through path
    /// (<see cref="EmitFieldTypeConfig"/>) and the read-only-projection path, which both emit
    /// a <c>Dictionary&lt;string, V&gt;</c> property and so both need the mapping.
    /// </summary>
    private string MapJsonbConfig(string className, MetaObject owner, MetaField f, GenContext ctx) =>
        $"        modelBuilder.Entity<{className}>().Property(x => x.{PropertyName(f)})"
            + MapJsonbSuffix(owner, f, ctx) + ";";

    /// <summary>
    /// The column-type + converter/comparer suffix every <c>field.map</c> mapping ends in, whatever
    /// the receiver. Written once so the two tiers — a top-level property and a FLATTENED value
    /// object's member, which differ only in the receiver and a <c>HasColumnName</c> — cannot drift:
    /// a converter change fixed in one tier only is exactly the failure the flattened tier's old
    /// known-gap entry described.
    /// </summary>
    private static string MapJsonbSuffix(MetaObject owner, MetaField f, GenContext ctx)
    {
        var valueType = MapValueTypeRef(f, ctx);
        // The SAME requiredness predicate the property emission uses (MapProperty), so the
        // converter's nullability annotation always matches the property it converts: EF Core
        // 8's nullability-aware HasConversion signature checks the converter's model type
        // against the property's own annotation, and a mismatch is a CS8620 warning.
        var converter = CSharpNaming.IsRequired(owner, f)
            ? $"{MapJsonbHelperName}.RequiredConverter<{valueType}>()"
            : $"{MapJsonbHelperName}.Converter<{valueType}>()";
        return $".HasColumnType(\"jsonb\").HasConversion("
            + $"{converter}, {MapJsonbHelperName}.Comparer<{valueType}>())";
    }

    /// <summary>Name of the generated jsonb (de)serialization helper the field.map configs use.</summary>
    private const string MapJsonbHelperName = "MapJsonb";

    /// <summary>
    /// The C# type argument naming a <c>field.map</c>'s VALUE — the <c>V</c> in
    /// <c>Dictionary&lt;string, V&gt;</c>, as written INSIDE the generated DbContext.
    /// </summary>
    /// <remarks>
    /// A scalar <c>@valueType</c> is a C# keyword (<c>string</c>, <c>int</c>, ...) and needs no
    /// qualification. An <c>@objectRef</c> value object is emitted FULLY QUALIFIED: the
    /// DbContext's usings are a fixed set (<see cref="EmitUsings"/>) that covers ENTITY
    /// namespaces only — a value object is neither an entity nor a view, so a bare name would
    /// not resolve as soon as the VO's package binds to a different namespace. Same rule the
    /// <c>System.Guid</c> / <c>System.Uri</c> / <c>UnmappedEnumValue</c> emissions already
    /// follow, and the reason this is the one map site that cannot reuse
    /// <see cref="CSharpNaming.MapValueType"/> verbatim (the entity file, which CAN use the bare
    /// name, emits that).
    /// </remarks>
    private static string MapValueTypeRef(MetaField f, GenContext ctx)
    {
        if (f.ObjectRef is not { } oref || oref.Length == 0) return CSharpNaming.MapValueType(f);
        var vo = ValueObjectNames.ResolveFieldRef(f, ctx.Root);
        if (vo is null) return CSharpNaming.Pascal(CSharpNaming.StripPkg(oref));
        var bare = ValueObjectNames.TypeName(vo, ctx.Root);
        var ns = ValueObjectNames.Namespace(vo, ctx.Config);
        return string.IsNullOrEmpty(ns) ? bare : ns + "." + bare;
    }

    /// <summary>
    /// Emits the shared jsonb converter/comparer pair every <c>field.map</c> column's config
    /// calls. Emitted only when the model carries at least one map, so a map-free model
    /// produces byte-identical output — same gating as
    /// <see cref="EmitUnmappedEnumHelper"/>.
    /// </summary>
    /// <remarks>
    /// <para>The COMPARER is the load-bearing half, not decoration. EF snapshots a
    /// value-converted property by REFERENCE unless told otherwise, so with a converter alone
    /// an in-place <c>entity.Labels["k"] = v</c> is never detected as a change and the UPDATE
    /// never fires — the same silent non-persistence this whole mapping exists to fix.</para>
    /// <para>It compares ENTRY-WISE rather than by serialized JSON, which matters in both
    /// directions: JSON string equality is key-ORDER sensitive, so a dictionary rebuilt in a
    /// different order would read as changed and issue an UPDATE for a row nothing touched;
    /// and it made every equality check serialize both dictionaries. Scalars now settle on
    /// <c>EqualityComparer&lt;T&gt;.Default</c> with no serialization at all, while a value-object
    /// value still falls through to a JSON compare because the generated POCO is a class and
    /// compares by reference. The snapshot deep-copies only when the value type needs it.</para>
    /// <para>The shared <c>Options</c> instance the helper emits carries a
    /// <c>JsonStringEnumConverter</c> so a <c>field.enum</c> member of the map's value object
    /// serializes as its member SYMBOL — the rule <see cref="JsonEnumConversions"/> states for
    /// the owned-<c>field.object</c> jsonb path, for the same reason: System.Text.Json's
    /// default is the enum's int ORDINAL, which no sibling port writes for the same declared
    /// field, and <c>@intValueMap</c> is a column-storage concern that reaches nothing inside
    /// a JSON document. One shared instance serves the converter and the Eq/Snap JSON arms,
    /// so every arm encodes enums identically.</para>
    /// <para>Fully qualified throughout: the generated file's usings are a fixed set
    /// (<see cref="EmitUsings"/>), and widening it would change byte-identical output for
    /// every model.</para>
    /// <para>The converter/comparer type arguments are the NULLABLE dictionary: a
    /// non-required map's property is nullable (nullability follows the column), and EF
    /// Core 8's nullability-aware <c>HasConversion</c> signature expects the converter's
    /// model type to match. Annotation-only — EF passes null through a value converter
    /// untranslated and never invokes the expressions on it, so the lambdas' bodies are
    /// unchanged.</para>
    /// </remarks>
    private static void EmitMapJsonbHelper(StringBuilder sb)
    {
        sb.AppendLine();
        sb.AppendLine("    /// <summary>");
        sb.AppendLine("    /// Shared jsonb (de)serialization for field.map columns. The comparer is required:");
        sb.AppendLine("    /// EF snapshots a value-converted property by reference, so without it an in-place");
        sb.AppendLine("    /// edit to the dictionary is never detected and the row is never updated.");
        sb.AppendLine("    /// </summary>");
        sb.AppendLine($"    private static class {MapJsonbHelperName}");
        sb.AppendLine("    {");
        sb.AppendLine("        private static readonly System.Text.Json.JsonSerializerOptions Options = new()");
        sb.AppendLine("        {");
        sb.AppendLine("            Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }");
        sb.AppendLine("        };");
        sb.AppendLine();
        sb.AppendLine("        internal static Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<");
        sb.AppendLine("            System.Collections.Generic.Dictionary<string, TValue>, string> RequiredConverter<TValue>() => new(");
        sb.AppendLine("                v => System.Text.Json.JsonSerializer.Serialize(v, Options),");
        sb.AppendLine("                v => System.Text.Json.JsonSerializer.Deserialize<");
        sb.AppendLine("                    System.Collections.Generic.Dictionary<string, TValue>>(v, Options)!);");
        sb.AppendLine();
        sb.AppendLine("        /// <summary>Same conversion as RequiredConverter, over the NULLABLE dictionary a");
        sb.AppendLine("        /// non-required map's property carries — keep the two bodies identical. EF Core's");
        sb.AppendLine("        /// nullability-aware HasConversion checks the converter's model type against the");
        sb.AppendLine("        /// property's own annotation, so one factory cannot serve both arms.</summary>");
        sb.AppendLine("        internal static Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<");
        sb.AppendLine("            System.Collections.Generic.Dictionary<string, TValue>?, string> Converter<TValue>() => new(");
        sb.AppendLine("                v => System.Text.Json.JsonSerializer.Serialize(v, Options),");
        sb.AppendLine("                v => System.Text.Json.JsonSerializer.Deserialize<");
        sb.AppendLine("                    System.Collections.Generic.Dictionary<string, TValue>>(v, Options)!);");
        sb.AppendLine();
        // A value object that holds a map is stored as ONE document converted whole: EF Core 8 cannot
        // map a Dictionary<string, VO> member inside an owned-JSON type. The same Options serve it, so
        // a decimal member keeps its canonical-string wire form (DecimalWire.Declared on the member).
        sb.AppendLine("        /// <summary>A whole value-object document (or collection of them) as one jsonb value,");
        sb.AppendLine("        /// for a value object that holds a map (EF Core 8 cannot own a dictionary inside JSON).</summary>");
        sb.AppendLine("        internal static Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<TModel, string> ObjectConverter<TModel>() => new(");
        sb.AppendLine("            v => System.Text.Json.JsonSerializer.Serialize(v, Options),");
        sb.AppendLine("            v => System.Text.Json.JsonSerializer.Deserialize<TModel>(v, Options)!);");
        sb.AppendLine();
        sb.AppendLine("        internal static Microsoft.EntityFrameworkCore.ChangeTracking.ValueComparer<TModel> ObjectComparer<TModel>() => new(");
        sb.AppendLine("            (a, b) => System.Text.Json.JsonSerializer.Serialize(a, Options) == System.Text.Json.JsonSerializer.Serialize(b, Options),");
        sb.AppendLine("            v => System.Text.Json.JsonSerializer.Serialize(v, Options).GetHashCode(),");
        sb.AppendLine("            v => System.Text.Json.JsonSerializer.Deserialize<TModel>(System.Text.Json.JsonSerializer.Serialize(v, Options), Options)!);");
        sb.AppendLine();
        sb.AppendLine("        internal static Microsoft.EntityFrameworkCore.ChangeTracking.ValueComparer<");
        sb.AppendLine("            System.Collections.Generic.Dictionary<string, TValue>?> Comparer<TValue>() => new(");
        sb.AppendLine("                (a, b) => Eq(a, b), v => Hash(v), v => Snap(v));");
        sb.AppendLine();
        sb.AppendLine("        /// <summary>Order-INDEPENDENT equality: a dictionary rebuilt in a different key");
        sb.AppendLine("        /// order holds the same value, and comparing serialized JSON would call it changed");
        sb.AppendLine("        /// and issue an UPDATE for a row nothing touched. Scalars settle on the default");
        sb.AppendLine("        /// comparer (no serialization at all); a value-object value falls through to a JSON");
        sb.AppendLine("        /// compare, since the generated POCO is a class and compares by reference.</summary>");
        sb.AppendLine("        private static bool Eq<TValue>(");
        sb.AppendLine("            System.Collections.Generic.Dictionary<string, TValue>? a,");
        sb.AppendLine("            System.Collections.Generic.Dictionary<string, TValue>? b)");
        sb.AppendLine("        {");
        sb.AppendLine("            if (a is null || b is null) return ReferenceEquals(a, b);");
        sb.AppendLine("            if (a.Count != b.Count) return false;");
        sb.AppendLine("            foreach (var kv in a)");
        sb.AppendLine("            {");
        sb.AppendLine("                if (!b.TryGetValue(kv.Key, out var other)) return false;");
        sb.AppendLine("                if (System.Collections.Generic.EqualityComparer<TValue>.Default.Equals(kv.Value, other)) continue;");
        sb.AppendLine("                if (System.Text.Json.JsonSerializer.Serialize(kv.Value, Options)");
        sb.AppendLine("                    != System.Text.Json.JsonSerializer.Serialize(other, Options)) return false;");
        sb.AppendLine("            }");
        sb.AppendLine("            return true;");
        sb.AppendLine("        }");
        sb.AppendLine();
        sb.AppendLine("        /// <summary>Keys and count only — order-independent (XOR), allocation-free, and");
        sb.AppendLine("        /// stable for a value-object value whose GetHashCode is reference-based. Equal");
        sb.AppendLine("        /// dictionaries always hash equal, which is all EF requires.</summary>");
        sb.AppendLine("        private static int Hash<TValue>(System.Collections.Generic.Dictionary<string, TValue>? v)");
        sb.AppendLine("        {");
        sb.AppendLine("            if (v is null) return 0;");
        sb.AppendLine("            var h = v.Count;");
        sb.AppendLine("            foreach (var k in v.Keys) h ^= k.GetHashCode();");
        sb.AppendLine("            return h;");
        sb.AppendLine("        }");
        sb.AppendLine();
        sb.AppendLine("        /// <summary>The change-tracking snapshot. A value-object value needs a DEEP copy or");
        sb.AppendLine("        /// an in-place edit to a nested object mutates the snapshot too and goes undetected;");
        sb.AppendLine("        /// an immutable scalar only needs the dictionary copied.</summary>");
        sb.AppendLine("        private static System.Collections.Generic.Dictionary<string, TValue>? Snap<TValue>(");
        sb.AppendLine("            System.Collections.Generic.Dictionary<string, TValue>? v) =>");
        sb.AppendLine("            v is null");
        sb.AppendLine("                ? null");
        sb.AppendLine("                : typeof(TValue).IsValueType || typeof(TValue) == typeof(string)");
        sb.AppendLine("                    ? new System.Collections.Generic.Dictionary<string, TValue>(v)");
        sb.AppendLine("                    : System.Text.Json.JsonSerializer.Deserialize<");
        sb.AppendLine("                        System.Collections.Generic.Dictionary<string, TValue>>(");
        sb.AppendLine("                            System.Text.Json.JsonSerializer.Serialize(v, Options), Options)!;");
        sb.AppendLine("    }");
    }

    /// <summary>
    /// True when any emitted converter will reference <see cref="UnmappedEnumHelperName"/>
    /// — i.e. the model carries at least one int-backed <c>field.enum</c>. Mirrors the
    /// fields <see cref="EmitFieldTypeConfig"/> configures (enum fields of every emitted
    /// object, plus a write-through entity's read-model view over the same field set) AND
    /// the enum members of every FLATTENED value object those objects own, which
    /// <see cref="OwnedTypeConfig"/> gives the same converter — a value object is not in
    /// <paramref name="objects"/>, so scanning only their own fields would emit a converter
    /// that names a helper this file never declares.
    /// </summary>
    private static bool NeedsUnmappedEnumHelper(IEnumerable<MetaObject> objects, MetaRoot root) =>
        objects.Any(o => o.Fields().Any(f =>
            (f.SubType == FIELD_SUBTYPE_ENUM && IntValueMapOf(f) is not null)
            || (f.SubType == FIELD_SUBTYPE_OBJECT && f.Storage == STORAGE_FLATTENED && !f.ResolvedIsArray()
                && ValueObjectNames.ResolveFieldRef(f, root) is { } vo
                && vo.Fields().Any(nf =>
                    nf.SubType == FIELD_SUBTYPE_ENUM && IntValueMapOf(nf) is not null))));

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
    /// the helper's ordinary body. The model→provider chain does the same, ending in
    /// <c>UnmappedEnumMember</c>: <c>@intValueMap</c>'s keys match <c>@values</c>
    /// exactly, but the C# enum can still hold a value outside them (a cast integer, or a
    /// <c>@provided</c> enum's extra member), which must not be stored as another member's
    /// integer.</para>
    /// </remarks>
    protected virtual string? EnumConversionCall(string owner, MetaObject entity, MetaField f, GenContext ctx)
    {
        var config = ctx.Config;
        var intMap = IntValueMapOf(f);
        // A string-backed enum's column length (EnumLength.ResolveMaxLength: its @maxLength, else
        // the project's enums.maxLength) is the VARCHAR(n) `meta migrate` creates. An array enum
        // is a text[] column, whose elements carry no length.
        if (intMap is null)
            return !f.ResolvedIsArray() && EnumLength.ResolveMaxLength(f) is { } length
                ? $"HasConversion<string>().HasMaxLength({length})"
                : "HasConversion<string>()";

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
        // Non-shared branch: the enum IS nested in the entity class, referenced from the
        // DbContext (a sibling type) — global::-qualified (CSharpNaming.QualifiedOwnerTypeRef),
        // not bare: a bare <Owner> can resolve to this DbContext's own same-named DbSet
        // property instead of the entity type (CS1061), which an already-plural entity
        // name now reaches.
        var type = Fr019SharedEnum.SharedEnumForField(f) is { } shared
            ? Fr019SharedEnum.SharedEnumTypeReference(shared, config)
            : $"{CSharpNaming.QualifiedOwnerTypeRef(owner, entity, config)}.{CSharpNaming.EnumTypeName(entity, f)}";
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
        // Every member gets its own branch on the WRITE side too, ending in the throwing helper:
        // a value outside @values (a cast like (E)99, or a member a @provided C# enum carries
        // that the metadata does not) would otherwise fall into the else branch and be stored
        // as the LAST member's int, silently.
        for (var i = 0; i < members.Count; i++)
            toProvider.Append($"v == {type}.{members[i]} ? {ints[i]} : ");
        // Typed object: the lambda's parameter is the property's type, nullable or not.
        toProvider.Append($"{UnmappedEnumMemberHelperName}(v, \"{f.Name}\")");
        // Every member gets its own branch here (no last-member fallthrough) so the
        // final else can reject an int the model does not describe.
        for (var i = 0; i < members.Count; i++)
            fromProvider.Append($"v == {ints[i]} ? {type}.{members[i]} : ");
        fromProvider.Append($"{UnmappedEnumHelperName}<{type}>(v, \"{f.Name}\")");

        // An ARRAY's conversion goes on the primitive collection's ElementTypeBuilder, which
        // is not generic: it has no HasConversion(lambda, lambda) overload to type the two
        // lambdas against (CS1660), so the pair is wrapped in an explicit ValueConverter.
        // The element converter is the scalar pair unchanged, so each element is stored as
        // its declared int and an unmapped stored element throws exactly as a scalar does.
        if (f.ResolvedIsArray())
            return "HasConversion(new global::Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<"
                + $"{type}, int>({toProvider}, {fromProvider}))";
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
        {
            if (OwnedTypeConfig(className, entity, f, ctx) is { } cfg)
            {
                modelLines.Add(cfg);
            }
        }

        // Every other kind of field, in FieldTypeRank order: all maps, then all enums, then primitive
        // collections, decimals, timestamps, uri, inet, durations. The order is the one this method
        // has always emitted in (OrderBy is stable, so fields keep their declared order within a
        // kind); FieldTypeConfig is asked about every field, once, in that order. An ARRAY of
        // durations belongs to two kinds, a primitive collection and a duration, and the old passes
        // wrote its two halves apart: its duration half is set aside by the hook (see
        // FieldTypeConfig) and written here at its declared place among the durations.
        var items = new List<(int Rank, MetaField Field, bool DurationHalf)>();
        foreach (var f in fieldList)
        {
            items.Add((FieldTypeRank(f), f, false));
            if (IsDurationArray(f))
            {
                items.Add((FieldTypeRankDuration, f, true));
            }
        }
        var outerDeferred = _deferredDurationLines;
        var deferred = new Dictionary<MetaField, List<string>>();
        _deferredDurationLines = deferred;
        try
        {
            foreach (var (_, f, durationHalf) in items.OrderBy(i => i.Rank))
            {
                if (durationHalf)
                {
                    if (deferred.TryGetValue(f, out var half))
                    {
                        modelLines.AddRange(half);
                    }
                    continue;
                }
                if (f.SubType == FIELD_SUBTYPE_ENUM)
                {
                    // An override that returns null leaves the field unconverted: no line.
                    if (EnumConversionCall(className, entity, f, ctx) is { } conversion)
                    {
                        var prop = PropertyName(f);
                        // An int-backed enum (@intValueMap) persists the declared INTEGER instead of the
                        // member symbol, so it needs a custom converter pair rather than HasConversion<string>().
                        // The generated C# `enum` declaration is byte-identical either way — int-backing is a
                        // persistence concern, invisible in the entity's API.
                        // ADR-0039: resolving — array-ness inheritable via extends. Array-of-enum uses the
                        // EF Core 8 primitive collection with a per-element conversion so members persist as
                        // symbols (["DRAFT"]) — or as their declared ints — not as int ordinals ([0]).
                        if (f.ResolvedIsArray())
                        {
                            modelLines.Add($"        modelBuilder.Entity<{className}>().PrimitiveCollection(x => x.{prop}).ElementType().{conversion};");
                        }
                        else
                        {
                            modelLines.Add($"        modelBuilder.Entity<{className}>().Property(x => x.{prop}).{conversion};");
                        }
                    }
                }
                modelLines.AddRange(FieldTypeConfig(className, entity, f, ctx));
            }
        }
        finally
        {
            _deferredDurationLines = outerDeferred;
        }

        foreach (var f in fieldList.Where(f => !f.ResolvedIsArray() && f.DbColumnType is not null))
        {
            // An override that returns null leaves the field with no column-type line.
            if (DbColumnTypeConfig(className, f) is { } cfg)
            {
                modelLines.Add(cfg);
            }
        }
    }

    // The duration half of an ARRAY-of-durations field's lines, set aside by the default
    // FieldTypeConfig while EmitFieldTypeConfig is running, so the driver can write it where the
    // duration pass always wrote it. Null outside that run, when the hook returns everything at once.
    private Dictionary<MetaField, List<string>>? _deferredDurationLines;

    private const int FieldTypeRankDuration = 8;

    private static bool IsDurationArray(MetaField f) =>
        f.ResolvedIsArray() && f.SubType == FIELD_SUBTYPE_DURATION && f.DbColumnType is null;

    // The place of a field's type configuration among the others, so a model's lines keep the
    // order they have always had: maps, enums, primitive collections, decimals, timestamps, uri,
    // inet, durations. A field matching more than one (an array of durations is both a primitive
    // collection and a duration) sits at the first. Everything else — scalars needing nothing,
    // owned value objects (configured by OwnedTypeConfig above) — sorts last and emits nothing here.
    private static int FieldTypeRank(MetaField f)
    {
        var array = f.ResolvedIsArray();
        if (f.SubType == FIELD_SUBTYPE_MAP)
        {
            return 1;
        }
        if (f.SubType == FIELD_SUBTYPE_ENUM)
        {
            return 2;
        }
        if (array && CSharpNaming.ScalarFor(f.SubType) is not null)
        {
            return 3;
        }
        if (!array && f.SubType == FIELD_SUBTYPE_DECIMAL && f.Precision is not null)
        {
            return 4;
        }
        if (!array && f.SubType == FIELD_SUBTYPE_TIMESTAMP)
        {
            return 5;
        }
        if (!array && f.SubType == FIELD_SUBTYPE_URI && !CSharpNaming.IsLenientNet(f))
        {
            return 6;
        }
        if (!array && f.SubType == FIELD_SUBTYPE_INET && !CSharpNaming.IsLenientNet(f))
        {
            return 7;
        }
        if (f.SubType == FIELD_SUBTYPE_DURATION && f.DbColumnType is null)
        {
            return 8;
        }
        return 99;
    }

    /// <summary>
    /// Hook — the type configuration lines of ONE field, on <paramref name="owner"/> (the emitted
    /// class: the entity, a TPH subtype, or a write-through entity's <c>&lt;Entity&gt;View</c> read
    /// model): a <c>field.map</c>'s jsonb column, a scalar array's primitive collection, a decimal's
    /// precision, a timestamp's column type, <c>field.uri</c>/<c>field.inet</c> storage and a
    /// duration's provider-dependent mapping. Called for EVERY field being configured, so an
    /// override can add a line for any of them; the base returns nothing for a field none of those
    /// apply to. Enum conversions come from <see cref="EnumConversionCall"/>, owned value objects
    /// from <see cref="OwnedTypeConfig"/> and <c>@dbColumnType</c> from <see cref="DbColumnTypeConfig"/>.
    /// </summary>
    protected virtual IEnumerable<string> FieldTypeConfig(string owner, MetaObject entity, MetaField f, GenContext ctx)
    {
        var lines = new List<string>();
        var array = f.ResolvedIsArray();
        var prop = PropertyName(f);

        // field.map -> a single jsonb column holding the JSON object. Without this the property
        // gets NO storage mapping at all: nothing tells EF the column type, and nothing tells it
        // how to turn the dictionary into the column's value. What a given provider does with an
        // unmapped Dictionary is then the PROVIDER's business, not this model's -- which is the
        // problem, because the column the TS-owned migration creates is jsonb (ADR-0015) and only
        // an explicit mapping makes EF agree with it. Stated as a property of the mapping rather
        // than of any provider's defaults: those were asserted here from memory and never
        // measured. Not gated by jsonbObjectsOnly --
        // a map's storage is ALWAYS the single jsonb column, so a write-through entity's
        // read model declares it too (same rule as the enum / decimal / timestamp loops).
        // The C# analog of Kotlin's jsonb(col, encoder, decoder): the converter is emitted
        // explicitly, so the mapping does not depend on any host-side serializer configuration
        // the generated code cannot make on a consumer's behalf. The COMPARER is not optional --
        // see EmitMapJsonbHelper.
        if (f.SubType == FIELD_SUBTYPE_MAP)
        {
            lines.Add(MapJsonbConfig(owner, entity, f, ctx));
        }

        if (array && CSharpNaming.ScalarFor(f.SubType) is not null)
        {
            lines.Add($"        modelBuilder.Entity<{owner}>().PrimitiveCollection(x => x.{prop});");
        }

        if (!array && f.SubType == FIELD_SUBTYPE_DECIMAL && f.Precision is not null)
        {
            lines.Add(f.Scale is long sc
                ? $"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).HasPrecision({f.Precision}, {sc});"
                : $"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).HasPrecision({f.Precision});");
        }

        if (!array && f.SubType == FIELD_SUBTYPE_TIMESTAMP)
        {
            var colType = CSharpNaming.IsLocalTime(f)
                ? "timestamp without time zone"
                : "timestamp with time zone";
            lines.Add($"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).HasColumnType(\"{colType}\");");
        }

        // #234: a @lenient field.uri / field.inet is a plain string mapped to a plain `text`
        // column (EF's string default) — no System.Uri HasConversion, no native `inet` type.
        if (!array && f.SubType == FIELD_SUBTYPE_URI && !CSharpNaming.IsLenientNet(f))
        {
            // System.Uri is FULLY QUALIFIED: the emitted AppDbContext carries no `using System;`
            // (unlike the entity files), so an unqualified `new Uri(v)` in OnModelCreating fails
            // to compile except under a host's ImplicitUsings — the generated context must be
            // self-contained (this is also on the #214 write-through read-model path now).
            lines.Add(
                $"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).HasColumnType(\"text\").HasConversion(v => v!.ToString(), v => new System.Uri(v));");
        }

        if (!array && f.SubType == FIELD_SUBTYPE_INET && !CSharpNaming.IsLenientNet(f))
        {
            lines.Add(
                $"        modelBuilder.Entity<{owner}>().Property(x => x.{prop}).HasColumnType(\"inet\");");
        }

        // field.duration — a System.TimeSpan. Npgsql maps it to the native `interval` (and an array
        // to `interval[]`), reading an interval with a month or year part as an error. Every other
        // provider stores the canonical ISO-8601 string in a text column (the TS-owned SQLite / MySQL
        // schemas), through the entity namespace's DurationWire; EF's own TimeSpan text ("01:30:00")
        // would not be the cross-port form, and MySQL's `time` cannot hold more than 838 hours.
        if (f.SubType == FIELD_SUBTYPE_DURATION && f.DbColumnType is null)
        {
            if (_deferredDurationLines is { } deferred && IsDurationArray(f))
            {
                // Under EmitFieldTypeConfig the duration half of an array waits for its pass; the
                // lines are still this hook's to produce, the driver only moves them.
                var half = new List<string>();
                AddDurationConfig(owner, entity, [f], ctx, half);
                deferred[f] = half;
            }
            else
            {
                AddDurationConfig(owner, entity, [f], ctx, lines);
            }
        }

        return lines;
    }

    // field.duration — a System.TimeSpan. Npgsql maps it to the native `interval` (and an array
    // to `interval[]`), reading an interval with a month or year part as an error. Every other
    // provider stores a 64-bit count of microseconds in an integer column (the TS-owned SQLite /
    // MySQL schemas), through the entity namespace's DurationWire; EF's own TimeSpan text
    // ("01:30:00") does not order as the span, and MySQL's `time` cannot hold more than 838 hours.
    private void AddDurationConfig(
        string className, MetaObject entity, IEnumerable<MetaField> fields, GenContext ctx, List<string> modelLines)
    {
        foreach (var f in fields.Where(f => f.SubType == FIELD_SUBTYPE_DURATION && f.DbColumnType is null))
            modelLines.Add(string.Join("\n",
                DurationColumnLines($"modelBuilder.Entity<{className}>()", "x", PropertyName(f), f.ResolvedIsArray(), entity, ctx, "        ")));
    }

    // The provider-dependent mapping of one duration column (a top-level property, or a member of a
    // flattened value object through its owned builder `target`):
    //   - Npgsql: the native `interval` (`interval[]` for an array), read through the generated
    //     DurationInterval type mapping, so a month or year part, or a day count past what a TimeSpan
    //     holds, is refused instead of read wrong (Npgsql's own TimeSpan read drops a negative month
    //     part and wraps such a day count).
    //   - any other provider (SQLite, MySQL): a 64-bit count of microseconds in an integer column
    //     (sub-microsecond ticks truncated toward zero; a count past a TimeSpan refused, not
    //     wrapped), which orders and compares as the span does. An array holds the counts.
    private static IEnumerable<string> DurationColumnLines(
        string target, string v, string prop, bool isArray, MetaObject owner, GenContext ctx, string indent)
    {
        var micros = DurationMicrosConverter(owner, ctx);
        yield return $"{indent}if (Database.ProviderName == \"{NpgsqlProviderName}\")";
        yield return isArray
            ? $"{indent}    {target}.PrimitiveCollection({v} => {v}.{prop}).Metadata.SetTypeMapping({DurationIntervalHelperName}.ArrayMapping);"
            : $"{indent}    {target}.Property({v} => {v}.{prop}).HasColumnType(\"interval\").Metadata.SetTypeMapping({DurationIntervalHelperName}.Mapping);";
        yield return $"{indent}else";
        yield return isArray
            ? $"{indent}    {target}.PrimitiveCollection({v} => {v}.{prop}).ElementType().HasConversion({micros});"
            : $"{indent}    {target}.Property({v} => {v}.{prop}).HasConversion({micros});";
    }

    // The namespace OWNER's DurationWire is emitted into (owner has a duration field, so it has one).
    private static string DurationWireRef(MetaObject owner, GenContext ctx) =>
        "global::" + PackageBindingResolver.Resolve(ctx.Config, PackageBindingResolver.EffectivePackage(owner), owner.Name, fallbackContext: owner.Name)
        + ".DurationWire";

    // A TimeSpan <-> canonical ISO-8601 string converter: a duration inside a JSON document.
    private static string DurationConverter(MetaObject owner, GenContext ctx)
    {
        var dw = DurationWireRef(owner, ctx);
        return "new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<System.TimeSpan, string>(" +
            $"v => {dw}.Format(v), v => {dw}.Parse(v))";
    }

    // A TimeSpan <-> microsecond-count converter: a duration column on a database without an interval type.
    private static string DurationMicrosConverter(MetaObject owner, GenContext ctx)
    {
        var dw = DurationWireRef(owner, ctx);
        return "new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<System.TimeSpan, long>(" +
            $"v => {dw}.ToMicros(v), v => {dw}.FromMicros(v))";
    }

    private const string DurationIntervalHelperName = "DurationInterval";

    // field.duration on Npgsql — the interval type mapping the duration columns are read through.
    // Npgsql's own TimeSpan read guards the month part with `months > 0` (so '-1 mons' reads as zero)
    // and adds the day part unchecked (so a day count past a TimeSpan wraps); this mapping reads the
    // value as NpgsqlInterval instead and refuses both. Npgsql is reached by reflection only, so the
    // generated context compiles, and runs, in a project with no Npgsql reference; the class is first
    // touched in the Npgsql branch of OnModelCreating. Emitted after the context class: the two
    // mapping types must be public and top-level for a compiled model (`dotnet ef dbcontext
    // optimize`), which re-creates a property's mapping as `<MappingType>.Default.Clone(...)` and
    // refuses a nested or non-public one. DurationIntervalEfCoreTests (integration) gates LINQ,
    // interval arithmetic and a compiled model against a live Postgres.
    private static void EmitDurationIntervalHelper(StringBuilder sb) => sb.AppendLine(DurationIntervalHelperSource);

    private const string DurationIntervalHelperSource = """

/// <summary>
/// field.duration on Npgsql: an <c>interval</c> column read through <c>NpgsqlInterval</c>, so a month
/// or year part, or a day count past what a TimeSpan holds, is refused rather than read wrong.
/// Npgsql is reached by reflection: a project on another provider needs no Npgsql reference.
/// </summary>
internal static class DurationInterval
{
    // The Npgsql shape this mapping reads, resolved and checked when the model is built (the
    // first touch is SetTypeMapping in OnModelCreating, or the first query on a compiled model),
    // so a missing or changed type fails there, naming what is missing, rather than on a row.
    internal static readonly System.Type IntervalType = Resolve();
    private static readonly System.Reflection.PropertyInfo Months = IntervalType.GetProperty("Months")!;
    private static readonly System.Reflection.PropertyInfo Days = IntervalType.GetProperty("Days")!;
    private static readonly System.Reflection.PropertyInfo Time = IntervalType.GetProperty("Time")!;
    internal static readonly System.Reflection.MethodInfo GetFieldValue =
        typeof(System.Data.Common.DbDataReader).GetMethod(nameof(System.Data.Common.DbDataReader.GetFieldValue))!;

    internal static readonly Microsoft.EntityFrameworkCore.Storage.RelationalTypeMapping Mapping = DurationIntervalMapping.Default;
    internal static readonly Microsoft.EntityFrameworkCore.Storage.RelationalTypeMapping ArrayMapping = DurationIntervalArrayMapping.Default;

    private static System.Type Resolve()
    {
        var type = System.Type.GetType(IntervalShape.TypeName, throwOnError: false);
        if (IntervalShape.Problem(type) is { } problem) throw new System.InvalidOperationException(problem);
        return type!;
    }

    /// <summary>The check of the NpgsqlInterval shape, kept apart from the state above so it can run against any type.</summary>
    internal static class IntervalShape
    {
        internal const string TypeName = "NpgsqlTypes.NpgsqlInterval, Npgsql";

        /// <summary>Null when <paramref name="type"/> has the shape the mapping reads, else a message naming what is missing.</summary>
        internal static string? Problem(System.Type? type)
        {
            const string Lead = "field.duration on Npgsql: the generated DurationInterval mapping reads an interval column as " +
                "NpgsqlTypes.NpgsqlInterval (an Int32 Months, an Int32 Days and an Int64 Time in microseconds; " +
                "tested with Npgsql 8.0.5), but ";
            if (type is null) return Lead + "no type NpgsqlTypes.NpgsqlInterval was found in the loaded Npgsql assembly.";
            var missing = new System.Collections.Generic.List<string>();
            foreach (var (name, want) in new[] { ("Months", typeof(int)), ("Days", typeof(int)), ("Time", typeof(long)) })
            {
                var property = type.GetProperty(name);
                if (property is null || property.PropertyType != want)
                    missing.Add(want.Name + " " + name);
            }
            return missing.Count == 0
                ? null
                : Lead + type.FullName + " has no " + string.Join(", no ", missing) + " property. Check the Npgsql version the project references.";
        }
    }

    /// <summary>An NpgsqlInterval as a TimeSpan: refused when it has a month or year part, or a span a TimeSpan cannot hold.</summary>
    public static System.TimeSpan FromInterval(object interval)
    {
        if ((int)Months.GetValue(interval)! != 0)
            throw new System.InvalidCastException("field.duration: the interval has a month or year part, so it is not a fixed-length span");
        var days = (int)Days.GetValue(interval)!;
        var micros = (long)Time.GetValue(interval)!;
        return System.TimeSpan.FromTicks(checked(days * System.TimeSpan.TicksPerDay + micros * 10));
    }

    /// <summary>An interval[] (an NpgsqlInterval array) as the list a duration array property holds.</summary>
    public static System.Collections.Generic.IList<System.TimeSpan> FromIntervals(object intervals)
    {
        var list = new System.Collections.Generic.List<System.TimeSpan>();
        foreach (var interval in (System.Array)intervals) list.Add(FromInterval(interval!));
        return list;
    }

    // A span as Postgres interval input: [-]HH:MM:SS[.f], hours unbounded, no day part. The column
    // holds microseconds, so sub-microsecond ticks are truncated toward zero.
    internal static string Literal(System.TimeSpan value)
    {
        long micros = value.Ticks / 10;
        bool negative = micros < 0;
        ulong rest = negative ? (ulong)(-(micros + 1)) + 1UL : (ulong)micros;
        ulong frac = rest % 1_000_000UL, s = rest / 1_000_000UL % 60, m = rest / 60_000_000UL % 60, h = rest / 3_600_000_000UL;
        var text = h.ToString("00", System.Globalization.CultureInfo.InvariantCulture) + ":" + m.ToString("00", System.Globalization.CultureInfo.InvariantCulture)
            + ":" + s.ToString("00", System.Globalization.CultureInfo.InvariantCulture);
        if (frac > 0) text += "." + frac.ToString("D6", System.Globalization.CultureInfo.InvariantCulture).TrimEnd('0');
        return "INTERVAL '" + (negative ? "-" : "") + text + "'";
    }
}

/// <summary>The type mapping of a field.duration column on Npgsql (an <c>interval</c>, read through <see cref="DurationInterval"/>).</summary>
public sealed class DurationIntervalMapping : Microsoft.EntityFrameworkCore.Storage.RelationalTypeMapping
{
    public static DurationIntervalMapping Default { get; } = new();

    public DurationIntervalMapping() : base("interval", typeof(System.TimeSpan)) { }
    private DurationIntervalMapping(RelationalTypeMappingParameters parameters) : base(parameters) { }
    protected override Microsoft.EntityFrameworkCore.Storage.RelationalTypeMapping Clone(RelationalTypeMappingParameters parameters) => new DurationIntervalMapping(parameters);
    public override System.Reflection.MethodInfo GetDataReaderMethod() => DurationInterval.GetFieldValue.MakeGenericMethod(DurationInterval.IntervalType);
    public override System.Linq.Expressions.Expression CustomizeDataReaderExpression(System.Linq.Expressions.Expression expression) =>
        System.Linq.Expressions.Expression.Call(typeof(DurationInterval).GetMethod(nameof(DurationInterval.FromInterval))!,
            System.Linq.Expressions.Expression.Convert(expression, typeof(object)));
    protected override string GenerateNonNullSqlLiteral(object value) => DurationInterval.Literal((System.TimeSpan)value);
}

/// <summary>The type mapping of an <c>@isArray</c> field.duration column on Npgsql (an <c>interval[]</c>).</summary>
public sealed class DurationIntervalArrayMapping : Microsoft.EntityFrameworkCore.Storage.RelationalTypeMapping
{
    private static readonly Microsoft.EntityFrameworkCore.ChangeTracking.ValueComparer<System.Collections.Generic.IList<System.TimeSpan>> ListComparer = new(
        (a, b) => a == null ? b == null : b != null && System.Linq.Enumerable.SequenceEqual(a, b),
        v => System.Linq.Enumerable.Aggregate(v, 0, (h, e) => System.HashCode.Combine(h, e)),
        v => System.Linq.Enumerable.ToList(v));

    // After ListComparer: static initializers run in declaration order. The element mapping is the
    // scalar one, which is what lets EF query the column as a primitive collection (Contains, Count,
    // Any): a compiled model carries only what the mapping itself names.
    public static DurationIntervalArrayMapping Default { get; } = new();

    public DurationIntervalArrayMapping() : base(new RelationalTypeMappingParameters(
        new CoreTypeMappingParameters(typeof(System.Collections.Generic.IList<System.TimeSpan>), comparer: ListComparer, keyComparer: ListComparer,
            elementMapping: DurationIntervalMapping.Default), "interval[]")) { }
    private DurationIntervalArrayMapping(RelationalTypeMappingParameters parameters) : base(parameters) { }
    protected override Microsoft.EntityFrameworkCore.Storage.RelationalTypeMapping Clone(RelationalTypeMappingParameters parameters) => new DurationIntervalArrayMapping(parameters);
    public override System.Reflection.MethodInfo GetDataReaderMethod() => DurationInterval.GetFieldValue.MakeGenericMethod(DurationInterval.IntervalType.MakeArrayType());
    public override System.Linq.Expressions.Expression CustomizeDataReaderExpression(System.Linq.Expressions.Expression expression) =>
        System.Linq.Expressions.Expression.Call(typeof(DurationInterval).GetMethod(nameof(DurationInterval.FromIntervals))!,
            System.Linq.Expressions.Expression.Convert(expression, typeof(object)));
    protected override string GenerateNonNullSqlLiteral(object value) =>
        "ARRAY[" + string.Join(",", System.Linq.Enumerable.Select((System.Collections.Generic.IEnumerable<System.TimeSpan>)value, DurationInterval.Literal)) + "]::interval[]";
}
""";

    // The EF Core provider name Npgsql registers (DbContext.Database.ProviderName).
    private const string NpgsqlProviderName = "Npgsql.EntityFrameworkCore.PostgreSQL";

    // True when a value object declares a field.map, or holds a value object that does.
    private static bool HoldsMap(MetaObject vo, MetaRoot root, HashSet<MetaObject> seen)
    {
        if (!seen.Add(vo)) return false;
        foreach (var nf in vo.Fields())
        {
            if (nf.SubType == FIELD_SUBTYPE_MAP) return true;
            if (nf.SubType == FIELD_SUBTYPE_OBJECT && ValueObjectNames.ResolveFieldRef(nf, root) is { } nested
                && HoldsMap(nested, root, seen)) return true;
        }
        return false;
    }

    // Owned-type config for an object-typed entity field. @storage flattened maps each
    // nested scalar to its core-naming flattened column (PhysicalNaming.ResolveFlattenedColumnName); every other storage collapses to one
    // json column (.ToJson) — matching the TS-owned schema DDL. null (with a warning)
    // when @objectRef can't be resolved. <paramref name="owner"/> is the emitted CLR class
    // name (the write entity, or a write-through entity's <Entity>View read model — #214).
    //
    // KNOWN GAP: a @required non-flattened object field gets a NOT NULL jsonb column in
    // the TS-owned schema DDL, but .ToJson here does not mark the owned navigation
    // required, so EF models it nullable — a gen↔schema nullability mismatch. Deferred
    // until the exact EF Core required-owned-JSON mapping can be validated against a
    // live provider.
    protected virtual string? OwnedTypeConfig(string owner, MetaObject entity, MetaField field, GenContext ctx)
    {
        if (ValueObjectNames.ResolveFieldRef(field, ctx.Root) is not { } vo)
        {
            ctx.Warn($"{Name}: object-typed field \"{entity.Name}.{field.Name}\" has an unresolved @objectRef \"{field.ObjectRef}\" — no owned-type config emitted.");
            return null;
        }
        var strategy = ctx.Config.ColumnNamingStrategy;
        var nav = PropertyName(field);
        // A6 -- the field itself belongs to `entity` (the JSON column's own physical
        // name, not the nested value object's), so it hits entity's own names artifact
        // unconditionally in practice — a lookup, not an assumption, per ColumnRef.
        var parentColRef = CSharpNaming.ColumnRef(entity, field, strategy, ctx.Config.IncludeNames);

        // An @isArray object field is a COLLECTION of the value object (the EntityGenerator
        // emits it as ICollection<VO>), so EF must map it with .OwnsMany(...).ToJson(...) —
        // .OwnsOne over a collection compiles but fails at EF model finalization ("must be a
        // non-interface reference type to be used as an entity type"). An array is always a
        // single JSON column (flattening N objects onto fixed columns is nonsensical), so it
        // never takes the flattened branch below. ResolvedIsArray per ADR-0039 (array-ness is
        // inheritable via extends).
        // An enum member inside the JSON document needs the SAME string conversion the
        // entity-level path gives a top-level enum, and for the same stated reason ("else enum
        // arrays persist as int ordinals", EmitFieldTypeConfig). EF Core 8's default for an
        // unconfigured enum is its ORDINAL, so an unconverted member stored `{"mood": 0}` where
        // every sibling port stores the member SYMBOL — a cross-port wire-contract break, and a
        // positionally fragile one: reordering @values silently re-maps already-stored data,
        // which is precisely why @intValueMap was specified as a MAP rather than an array.
        // A value object that holds a field.map (directly or through a nested value object) cannot be
        // an EF Core 8 owned-JSON type: the dictionary member has no owned mapping and model
        // finalization fails. Such a field is one jsonb property converted whole instead, which keeps
        // the stored document identical (every member serializes by its [JsonPropertyName], a decimal
        // as its canonical string through DecimalWire.Declared).
        if (field.Storage != STORAGE_FLATTENED && HoldsMap(vo, ctx.Root, new HashSet<MetaObject>()))
        {
            var modelType = CSharpNaming.IsRequired(entity, field) ? "" : "?";
            var voType = MapValueTypeRef(field, ctx);
            var clr = field.ResolvedIsArray()
                ? $"System.Collections.Generic.ICollection<{voType}>{modelType}"
                : voType + modelType;
            return $"        modelBuilder.Entity<{owner}>().Property(x => x.{nav}).HasColumnName({parentColRef})"
                + $".HasColumnType(\"jsonb\").HasConversion({MapJsonbHelperName}.ObjectConverter<{clr}>(), {MapJsonbHelperName}.ObjectComparer<{clr}>());";
        }
        var jsonEnums = JsonEnumConversions(vo, ctx);
        if (field.ResolvedIsArray())
            return jsonEnums.Count == 0
                ? $"        modelBuilder.Entity<{owner}>().OwnsMany(x => x.{nav}, b => b.ToJson({parentColRef}));"
                : OwnedJsonBlock("OwnsMany", owner, nav, parentColRef, jsonEnums);

        if (field.Storage != STORAGE_FLATTENED)
            return jsonEnums.Count == 0
                ? $"        modelBuilder.Entity<{owner}>().OwnsOne(x => x.{nav}, b => b.ToJson({parentColRef}));"
                : OwnedJsonBlock("OwnsOne", owner, nav, parentColRef, jsonEnums);

        // Each nested member's column is core naming's, whole
        // (PhysicalNaming.ResolveFlattenedColumnName): the field's @flattenedColumnPrefix verbatim,
        // else `<parent field's column>_`, then the member's own column — the same function
        // migrate-ts names these columns with, and TS owns the schema (ADR-0015). It is NOT EF's
        // own owned-type default, `<Nav>_<Prop>`, which binds a column no migration creates
        // (under the pascal column rule the two coincide). Under this generator's column
        // rule, so verify's probe of an alternate rule names these columns the way it names
        // every other.

        var sb = new StringBuilder();
        sb.AppendLine($"        modelBuilder.Entity<{owner}>().OwnsOne(x => x.{nav}, b =>");
        sb.AppendLine("        {");
        // A6 -- NOT converted, on two independent grounds. `vo` (object.value) never
        // carries a source (FR-024 value purity), so it has no <Vo>Names artifact at
        // all — CSharpNaming.ColumnRef would miss on every nf, always. And even with
        // one, nestedCol is a COMPOSITE string (prefix + column), not the bare physical
        // name a names constant holds — there is no single constant this could reference.
        //
        // Every member the migration flattens must be named here, in the value object's
        // declaration order. migrate's `flattenObjectField` (expected-schema.ts) iterates
        // `targetObject.fields()` UNCONDITIONALLY and emits one `<prefix><member col>` per
        // member, so any member this loop skips gets EF's `<Nav>_<Prop>` default instead —
        // a column the migration never creates, failing at the engine with 42703.
        //
        // Scalars and non-array enums were the original set. An enum was missing at first —
        // it is deliberately not a ScalarFor(...) type — so it fell through to the POCO's own
        // mapping: a bare [Column("<member column>")] (an unprefixed column) before the POCO
        // stopped carrying that attribute, EF's `<Nav>_<Prop>` default after. Neither is the
        // column the migration created. An enum member also needs the SAME conversion the
        // entity-level path gives it (HasConversion<string>() / the @intValueMap pair):
        // migrate flattens it to the text/integer column it would be as a top-level field,
        // while EF's default for an unconfigured enum is an integer column — so a
        // string-backed enum named correctly but left unconverted still fails at the engine.
        //
        // ARRAY ENUM and NESTED OBJECT members were skipped by the same `continue` and are
        // handled below: each is one of the three member kinds `EmitValueObjectPoco` emits a
        // property for, so each is a real property EF will map by its own default naming.
        // `field.map` is the fourth. It gets the SAME jsonb column config a top-level map gets
        // (see the map loop in EmitFieldTypeConfig), pinned to its flattened column name.
        foreach (var nf in vo.Fields())
        {
            var nestedColAny = PhysicalNaming.ResolveFlattenedColumnName(field, nf, strategy);

            // An ARRAY enum: migrate gives it a native array column (subtypeToSqlType derives
            // text[] from isArray), and EF Core 8 maps it as a primitive collection. Same
            // element conversion as the entity-level path, for the same reason — otherwise the
            // members persist as int ordinals inside the array.
            if (nf.SubType == FIELD_SUBTYPE_ENUM && nf.ResolvedIsArray())
            {
                // An override returning null leaves the member unconverted: no line for it.
                if (EnumConversionCall(ValueObjectNames.TypeName(vo, ctx.Root), vo, nf, ctx) is { } elementConversion)
                {
                    sb.AppendLine($"            b.PrimitiveCollection(p => p.{PropertyName(nf)})"
                        + $".HasColumnName(\"{nestedColAny}\").ElementType()"
                        + $".{elementConversion};");
                }
                continue;
            }

            // A NESTED value object: migrate gives it ONE json column at `<prefix><col>`
            // (subtypeToSqlType returns { kind: "json" } for field.object — a nested VO does
            // not flatten recursively). It is one jsonb PROPERTY converted whole (the same
            // ObjectConverter/ObjectComparer pair a map-holding value object takes), never a
            // nested owned `ToJson`: EF Core 8 refuses a JSON column inside a table-split owned
            // type ("All owned types containing a JSON column must be mapped to a JSON column
            // themselves"), which failed model validation for the whole context. The document
            // is keyed by each member's [JsonPropertyName] and enums are written as their
            // symbols, the same document the owned-JSON mapping writes elsewhere.
            if (nf.SubType == FIELD_SUBTYPE_OBJECT
                && ValueObjectNames.ResolveFieldRef(nf, ctx.Root) is not null)
            {
                var nullable = CSharpNaming.IsRequired(vo, nf) ? "" : "?";
                var nestedType = MapValueTypeRef(nf, ctx);
                var clr = nf.ResolvedIsArray()
                    ? $"System.Collections.Generic.ICollection<{nestedType}>{nullable}"
                    : nestedType + nullable;
                sb.AppendLine($"            b.Property(p => p.{PropertyName(nf)}).HasColumnName(\"{nestedColAny}\")"
                    + $".HasColumnType(\"jsonb\").HasConversion({MapJsonbHelperName}.ObjectConverter<{clr}>(), {MapJsonbHelperName}.ObjectComparer<{clr}>());");
                continue;
            }

            // A `field.map` member: the migration flattens it to a jsonb column at
            // `<prefix><col>`, so it takes the SAME converter/comparer pair a top-level map
            // takes, pinned to that name. Previously this fell to a warning whose stated
            // reason was that the port configured a top-level map nowhere either — that is
            // no longer true, and an unmapped dictionary here binds EF's `<Nav>_<Prop>`
            // default: a column the migration never creates (42703 at the engine).
            if (nf.SubType == FIELD_SUBTYPE_MAP)
            {
                sb.AppendLine($"            b.Property(p => p.{PropertyName(nf)})"
                    + $".HasColumnName(\"{nestedColAny}\")" + MapJsonbSuffix(vo, nf, ctx) + ";");
                continue;
            }

            // A `field.duration` member: the migration flattens it to an `interval` column on
            // Postgres and an integer microsecond count elsewhere — the same provider-dependent
            // mapping a top-level duration takes (DurationColumnLines). Without it EF would write
            // its own "01:30:00" text there and fail to read another port's count.
            if (nf.SubType == FIELD_SUBTYPE_DURATION && CSharpNaming.DbColumnTypeClrOverride(nf) is null)
            {
                var dprop = PropertyName(nf);
                sb.AppendLine(nf.ResolvedIsArray()
                    ? $"            b.PrimitiveCollection(p => p.{dprop}).HasColumnName(\"{nestedColAny}\");"
                    : $"            b.Property(p => p.{dprop}).HasColumnName(\"{nestedColAny}\");");
                foreach (var line in DurationColumnLines("b", "p", dprop, nf.ResolvedIsArray(), vo, ctx, "            "))
                    sb.AppendLine(line);
                continue;
            }

            var isScalar = CSharpNaming.ScalarFor(nf.SubType) is not null;
            var isEnum = nf.SubType == FIELD_SUBTYPE_ENUM && !nf.ResolvedIsArray();
            if (!isScalar && !isEnum)
            {
                // Whatever remains is a member kind this loop does not know how to pin. Warn,
                // naming the column the migration WILL create, so the divergence is loud.
                ctx.Warn($"{Name}: value object \"{vo.Name}\" member \"{nf.Name}\" (field.{nf.SubType}) is "
                    + $"flattened by the migration into column \"{nestedColAny}\" but gets no EF column "
                    + "mapping here, so EF will bind its own default name instead. See KNOWN_GAPS.md.");
                continue;
            }
            var nestedCol = nestedColAny;
            // The enum type nests in the value object's class (EntityGenerator's
            // EmitValueObjectPoco), so the VO is the `owner` the conversion qualifies it by.
            var conversion = isEnum && EnumConversionCall(ValueObjectNames.TypeName(vo, ctx.Root), vo, nf, ctx) is { } call
                ? $".{call}"
                : "";
            sb.AppendLine($"            b.Property(p => p.{PropertyName(nf)}).HasColumnName(\"{nestedCol}\"){conversion};");
        }
        sb.Append("        });");
        return sb.ToString();
    }

    /// <summary>
    /// The per-member <c>b.Property(...)</c> lines an owned-JSON value object needs so its enum
    /// members serialize as member SYMBOLS rather than EF's default int ordinals. Empty when the
    /// value object declares no enum member, which keeps the single-line
    /// <c>OwnsOne/OwnsMany(..., b =&gt; b.ToJson(...))</c> form byte-identical for every VO that
    /// had no divergence to begin with.
    /// </summary>
    /// <remarks>
    /// <para>The conversion is <c>HasConversion&lt;string&gt;()</c> UNCONDITIONALLY — deliberately
    /// NOT <see cref="EnumConversionCall"/>. <c>@intValueMap</c> is a COLUMN-storage concern
    /// (0.23.2: it switches the column from <c>varchar</c> + string CHECK to <c>integer</c> + int
    /// CHECK) and there is no column inside a JSON document. It reaches no port's value-object
    /// path — in the TypeScript reference `intValueMap` has zero hits under `templates/
    /// value-object-file.ts` and `inferred-types.ts`, so TS emits a plain string-literal union and
    /// writes the symbol whether or not the enum is int-backed. Routing the int map in here would
    /// have swapped one cross-port divergence for another.</para>
    /// <para>The array arm mirrors the entity-level rule exactly (EF Core 8 primitive collection
    /// with a per-element conversion); the two must not drift, because a VO member and a top-level
    /// field of the same declared subtype describe the same stored value.</para>
    /// </remarks>
    private List<string> JsonEnumConversions(MetaObject vo, GenContext ctx, string builder = "b")
    {
        var lines = new List<string>();
        foreach (var nf in vo.Fields())
        {
            var prop = PropertyName(nf);
            // A decimal member of a JSON document is stored as its CANONICAL STRING (the same text
            // the wire carries, ADR-0019 Amendment 1), not as EF's default JSON number: an exact
            // read-back, identical to every other port's stored form. Single members only.
            if (nf.SubType == FIELD_SUBTYPE_DECIMAL && !nf.ResolvedIsArray()
                && CSharpNaming.DbColumnTypeClrOverride(nf) is null)
            {
                lines.Add(CSharpNaming.IsRequired(vo, nf)
                    ? $"            {builder}.Property(p => p.{prop}).HasConversion(v => v.ToString(\"0.############################\", System.Globalization.CultureInfo.InvariantCulture), s => decimal.Parse(s, System.Globalization.CultureInfo.InvariantCulture));"
                    : $"            {builder}.Property(p => p.{prop}).HasConversion(v => v == null ? null : v.Value.ToString(\"0.############################\", System.Globalization.CultureInfo.InvariantCulture), s => s == null ? (decimal?)null : decimal.Parse(s, System.Globalization.CultureInfo.InvariantCulture));");
                continue;
            }
            // A duration member of a JSON document is stored as its canonical ISO-8601 string (the
            // wire form), not as EF's own TimeSpan text ("01:30:00"), on every provider.
            if (nf.SubType == FIELD_SUBTYPE_DURATION && CSharpNaming.DbColumnTypeClrOverride(nf) is null)
            {
                var converter = DurationConverter(vo, ctx);
                lines.Add(nf.ResolvedIsArray()
                    ? $"            {builder}.PrimitiveCollection(p => p.{prop}).ElementType().HasConversion({converter});"
                    : $"            {builder}.Property(p => p.{prop}).HasConversion({converter});");
                continue;
            }
            if (nf.SubType != FIELD_SUBTYPE_ENUM) continue;
            // ADR-0039: resolving — array-ness is inheritable via extends.
            lines.Add(nf.ResolvedIsArray()
                ? $"            {builder}.PrimitiveCollection(p => p.{prop}).ElementType().HasConversion<string>();"
                : $"            {builder}.Property(p => p.{prop}).HasConversion<string>();");
        }
        return lines;
    }

    /// <summary>
    /// The multi-line owned-JSON config: <c>.ToJson(col)</c> plus the per-member conversions.
    /// <paramref name="ownsCall"/> is <c>OwnsOne</c> or <c>OwnsMany</c>.
    /// </summary>
    private static string OwnedJsonBlock(
        string ownsCall, string owner, string nav, string parentColRef, List<string> memberLines)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"        modelBuilder.Entity<{owner}>().{ownsCall}(x => x.{nav}, b =>");
        sb.AppendLine("        {");
        sb.AppendLine($"            b.ToJson({parentColRef});");
        foreach (var line in memberLines) sb.AppendLine(line);
        sb.Append("        });");
        return sb.ToString();
    }
}
