package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.InetField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.field.UriField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.origin.AggregateOrigin;
import com.metaobjects.origin.MetaOrigin;
import com.metaobjects.validator.ArrayValidator;
import com.metaobjects.validator.LengthValidator;
import com.metaobjects.validator.MetaValidator;
import com.metaobjects.validator.NumericValidator;
import com.metaobjects.validator.RegexValidator;
import com.metaobjects.validator.RequiredValidator;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import com.metaobjects.generator.util.GeneratedFileWriter;

/**
 * Generator: one Java 21 {@code record} per {@code object.entity}, used as the
 * request/response body for the matching {@link SpringControllerGenerator}
 * output.
 *
 * <p>The generated DTO record separates wire shape from persistence-entity
 * shape: the consumer's JPA / jOOQ / JDBC entity stays a regular class, and
 * the controller marshals between record + entity through their generated
 * {@code <Entity>Repository} (see {@link SpringRepositoryGenerator}).</p>
 *
 * <p>Field type mapping is centralised in {@link SpringTypeMapper}; wrapped
 * primitives ({@code Long}, not {@code long}) are used so omitted JSON fields
 * deserialise to {@code null}. {@link ObjectField} components are skipped
 * for v1 — the cross-port wire contract permits flattened / jsonb storage,
 * but the Java DTO codepath needs the referenced value-class generated
 * alongside, which is follow-up work paralleling
 * {@code KotlinEntityGenerator}'s {@code field.object} arm.</p>
 *
 * <p>Args:</p>
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringDtoGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    /**
     * FR-019 per-port config for resolving {@code @provided} enum namespaces, parsed from the
     * {@code providedEnumNamespace} (single fallback) + {@code providedEnumPackages}
     * (package&rarr;namespace map) generator args. Empty (no namespaces) by default; a referenced
     * provided enum with no resolvable namespace is a codegen-time error.
     */
    private Fr019SharedEnum.ProvidedEnumConfig fr019Config =
        new Fr019SharedEnum.ProvidedEnumConfig(null, java.util.Map.of());

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    /** Real work — sidesteps the parent's print-style writer machinery. */
    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());
        fr019Config = Fr019SharedEnum.ProvidedEnumConfig.of(
            getArg("providedEnumNamespace"), getArg("providedEnumPackages"));
        // FR-019: materialize each shared (package-level abstract, non-@provided) enum ONCE as a
        // standalone Java enum, so consuming DTOs reference it instead of redeclaring it inline.
        emitSharedEnums(loader, outRoot);
        boolean emitAbstractShapes = Boolean.parseBoolean(getArg("emitAbstractShapes", "false"));
        for (MetaObject entity : loader.getMetaObjects()) {
            // FR-024: a (read) DTO is emitted for concrete entities AND any
            // object.projection (read-only-kind source) — the read model. A proc/
            // tableFunction-backed projection DTO may include input @param fields as
            // components (matching the pre-B4b entity behavior). Abstract shapes fall
            // through below.
            if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())
                    && !MetaObject.SUBTYPE_PROJECTION.equals(entity.getSubType())) continue;
            if (GeneratorUtil.isAbstract(entity)) {
                if (emitAbstractShapes) emitAbstractShape(entity, outRoot);
                continue;
            }
            // FR-017 TPH: a discriminator base's DTO carries the UNION of its subtype columns
            // (each folded nullable) so polymorphic + per-subtype endpoints share one wire shape.
            if (TphPlan.isTphBase(entity, loader)) emitTphUnion(entity, loader, outRoot);
            else emit(entity, outRoot);
            // FR-035: a presence-tracked <Entity>Patch alongside the DTO, for exactly the
            // entities whose non-TPH repository interface gains patch(...) — a concrete
            // writable table entity that is neither a TPH base nor a TPH subtype. Emitted
            // from THIS generator (which every consumer already runs) so a re-run of an
            // existing <generators> config that omits a separate patch generator cannot
            // produce a controller/repository that references a missing <Entity>Patch.
            if (SpringRepositoryGenerator.appliesTo(entity)
                    && !TphPlan.isTphBase(entity, loader)
                    && !TphPlan.isTphSubtype(entity)) {
                emitPatch(entity, outRoot);
            }
            // FR-036 Program B: a concrete TPH subtype ALSO gets a presence-tracked <Sub>Patch —
            // the base controller's per-subtype update route binds it for the present-key PATCH
            // tristate (mirroring the vanilla path). The subtype's standalone <Sub>Dto (emitted by
            // emit() above) carries the field constraints the controller validates present values
            // against. The base itself emits only its union DTO (no patch — writes go per subtype).
            if (TphPlan.isTphSubtype(entity)) {
                emitTphSubtypePatch(entity, outRoot);
            }
        }
        // #234: emit the strict field.uri / field.inet Jackson deserializers ONCE per package
        // that has such a field (a same-package MetaNetBindings the DTO components bind through).
        emitNetBindings(loader, outRoot);
    }

    /**
     * True iff this generator emits a concrete DTO {@code record} for
     * {@code entity}: any {@code object.entity} that is not {@code abstract}.
     * Unlike the controller/repository, the DTO is emitted for EVERY concrete
     * entity regardless of {@code source.rdb} kind (a view-kind entity still gets
     * a wire DTO). Abstract entities are excluded here — they only get the opt-in
     * interface shape via {@code emitAbstractShape} when the {@code emitAbstractShapes}
     * arg is set, which is a separate emit path, not part of this predicate.
     * Extracted verbatim from the {@link #execute(MetaDataLoader)} concrete-emit guard.
     */
    public static boolean appliesTo(MetaObject entity) {
        // FR-024: emit a read DTO for any concrete entity OR any object.projection
        // (read-only-kind source) — a projection is a read-only wire model; the write
        // surfaces skip it. A proc/tableFunction-backed projection DTO may include
        // input @param fields as components (matching the pre-B4b entity behavior).
        if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())
                && !MetaObject.SUBTYPE_PROJECTION.equals(entity.getSubType())) return false;
        return !GeneratorUtil.isAbstract(entity);
    }

    protected void emit(MetaObject entity, Path outRoot) {
        List<MetaField> fields = dtoComponentFields(entity);
        // Each field carries its full validation (the standard, non-TPH DTO). A value-object
        // jsonb column additionally gets @Valid so the POST path's validator.validate(dto)
        // cascades into the nested VO's constraints (spec section 0 — @Valid cascades on
        // validate(bean), unlike the PATCH path's per-field validateValue).
        List<String> annotationsPerField = new ArrayList<>(fields.size());
        for (MetaField field : fields) {
            String a = validationAnnotations(field);
            if (isValueObjectJsonbField(field)) a = a.isEmpty() ? "@Valid" : "@Valid " + a;
            // #234: a STRICT field.uri / field.inet component binds through the codegen-owned
            // literal deserializer (absolute-scheme URI / IPv4-or-IPv6 literal, no DNS) so a
            // malformed value is rejected at the wire tier (HTTP 400), aligning the JVM DTO with
            // the TS/Python strict contract.
            String net = netDeserializeAnnotation(field);
            if (!net.isEmpty()) a = a.isEmpty() ? net : net + " " + a;
            annotationsPerField.add(a);
        }
        // Issue #203: for an entity declaring @autoSet timestamp fields, emit the record-body
        // stamping helpers (stampForInsert / stampForUpdate / insertPreserving) the generated
        // controller uses to honor onCreate/onUpdate — and that a consumer's full-DTO
        // repository.update / import path can reuse. Empty (no helpers) otherwise, so a
        // non-@autoSet DTO stays byte-identical. Gated on the writable-controller predicate so
        // a read-only projection DTO never sprouts write-path helpers.
        //
        // ADR-0045 (#203/#229): a TPH subtype (e.g. BridgeAuth) has no OWN source.rdb — single-
        // table inheritance shares the base's — so SpringRepositoryGenerator.appliesTo's own-only
        // firstRdbSource lookup always returns false for it, even though it IS writable via the
        // base's table. Include TphPlan.isTphSubtype(entity) explicitly so its standalone <Sub>Dto
        // gets the same stamping helpers as any other writable entity's DTO (parity with the
        // vanilla contract for a consumer using the subtype DTO directly). The TPH controller's
        // own per-subtype create instead stamps via the BASE union DTO's helper — see emitTphUnion.
        boolean writableForAutoSet = SpringRepositoryGenerator.appliesTo(entity) || TphPlan.isTphSubtype(entity);
        List<String> extraBodyMembers =
            (writableForAutoSet && AutoSetSupport.hasAutoSetFields(entity))
                ? autoSetStampHelpers(entity, fields, SpringNaming.dtoName(
                      SpringNaming.splitFqn(entity.getName())[1]))
                : List.of();
        emitRecord(entity, outRoot, fields, annotationsPerField, extraBodyMembers);
    }

    /**
     * FR-035: emit the presence-tracked {@code <Entity>Patch} — a sibling of the DTO that
     * carries the absent / null / value tristate a record cannot. Only the caller-settable
     * fields (scalar fields MINUS the primary key) are members; {@code has<F>()} reports
     * presence (incl. an explicit null), {@code <f>()} the value. {@code fromJson} rejects a
     * non-object body, binds present values via Jackson exactly as create does, clears a
     * non-{@code @required} field on an explicit null, and throws a
     * {@code PatchValidationException} on an explicit null on a {@code @required} field (the
     * controller maps both to HTTP 400). Emitted here — from the DTO generator every consumer
     * already runs — so no separate generator can be forgotten and leave a controller /
     * repository referencing a missing {@code <Entity>Patch}.
     */
    private void emitPatch(MetaObject entity, Path outRoot) {
        String shortName = SpringNaming.splitFqn(entity.getName())[1];
        // Issue #203: the vanilla patch gains stampAutoSetOnUpdate() for each @autoSet onUpdate
        // column, so the generated controller's PATCH handler bumps updated_at on every write.
        writePatch(entity, outRoot, SpringNaming.patchName(shortName),
            SpringNaming.dtoName(shortName), settableFields(entity), AutoSetSupport.onUpdateFields(entity));
    }

    /**
     * FR-036 Program B: emit the presence-tracked {@code <Sub>Patch} for ONE concrete TPH subtype —
     * the same tristate shape as the vanilla {@link #emitPatch}, but its settable members are the
     * subtype's EFFECTIVE scalar fields (base + subtype) MINUS the primary key AND the discriminator
     * field (both immutable on a per-subtype update). The base's {@code @required} columns keep the
     * present-null &rarr; validation-error rule; a nullable subtype column clears on an explicit
     * null. Consumed by the TPH base controller's per-subtype update route and the repository
     * {@code patchByIdAndType} seam.
     */
    private void emitTphSubtypePatch(MetaObject subtype, Path outRoot) {
        String shortName = SpringNaming.splitFqn(subtype.getName())[1];
        // The discriminator field is immutable on a per-subtype PATCH — exclude it from the patch.
        String discriminatorField = TphPlan.discriminatorFieldOf(subtype);
        // ADR-0045 (#203/#229): the TPH base controller's per-subtype update route calls
        // patch.stampAutoSetOnUpdate() exactly like the vanilla update handler (emitPatch below) —
        // wire the resolving onUpdate @autoSet fields (inherited from the base, shared by every
        // subtype row in the single table) through so the generated <Sub>Patch actually carries
        // the hook. Empty for a hierarchy with no @autoSet column, so a non-@autoSet <Sub>Patch
        // stays byte-identical.
        writePatch(subtype, outRoot, SpringNaming.patchName(shortName),
            SpringNaming.dtoName(shortName), settableFields(subtype, discriminatorField),
            AutoSetSupport.onUpdateFields(subtype));
    }

    /**
     * Shared FR-035/FR-036 patch emitter — writes {@code <patchName>.java} (a presence-tracked
     * partial-update shape) for {@code entity} over the {@code settable} field list, qualifying an
     * inline {@code field.enum} against {@code dtoName}. Both the vanilla {@link #emitPatch} and the
     * TPH {@link #emitTphSubtypePatch} paths funnel through here so the tristate semantics (absent /
     * present-null-clears / present-null-on-@required-throws / present-value-binds) cannot drift.
     */
    private void writePatch(MetaObject entity, Path outRoot, String patchName, String dtoName,
            List<MetaField> settable, List<MetaField> onUpdateAutoSet) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) src.append("package ").append(pkg).append(";\n\n");
        src.append("import com.fasterxml.jackson.core.JsonProcessingException;\n");
        src.append("import com.fasterxml.jackson.core.type.TypeReference;\n");
        src.append("import com.fasterxml.jackson.databind.JsonNode;\n");
        src.append("import com.fasterxml.jackson.databind.ObjectMapper;\n");
        src.append("import com.metaobjects.generator.spring.runtime.PatchValidationException;\n");
        src.append("import java.util.LinkedHashMap;\n");
        src.append("import java.util.Map;\n");
        src.append("import java.util.Set;\n\n");
        src.append("/** GENERATED — presence-tracked partial-update (PATCH) shape for ")
           .append(shortName).append(". Do not hand-edit; regenerated from metadata. */\n");
        src.append("public final class ").append(patchName).append(" {\n\n");
        src.append("    private final Map<String, Object> assigned;\n\n");
        src.append("    private ").append(patchName)
           .append("(Map<String, Object> assigned) { this.assigned = assigned; }\n\n");

        // Per settable field: has<Field>() (presence, incl. explicit null) + <field>() (value).
        for (MetaField field : settable) {
            String name = field.getName();
            String cap = SpringNaming.capitalize(name);
            String type = patchComponentType(field, entity, dtoName);
            src.append("    public boolean has").append(cap)
               .append("() { return assigned.containsKey(\"").append(name).append("\"); }\n");
            src.append("    public ").append(type).append(' ').append(name).append("() { return (")
               .append(type).append(") assigned.get(\"").append(name).append("\"); }\n");
        }
        src.append("\n    /** The field names ASSIGNED by this patch (present in the body), in order. */\n");
        src.append("    public Set<String> assignedFields() { return assigned.keySet(); }\n\n");
        // FR-036: the assigned name→value map (present values, incl. an explicit null), for the
        // controller to bean-validate each PRESENT non-null value against the DTO's constraints.
        src.append("    /** The name&rarr;value map of fields ASSIGNED by this patch (present values, incl. explicit null). */\n");
        src.append("    public java.util.Map<String, Object> assignedValues() { return java.util.Collections.unmodifiableMap(assigned); }\n\n");

        // Issue #203 — @autoSet onUpdate stamping. The generated controller's PATCH handler calls
        // this AFTER binding + validating the caller's present values and BEFORE delegating to
        // repository.patch, so every partial update bumps updated_at (the model value is ignored:
        // the server owns onUpdate timestamps). now() is keyed off each column's temporal type. Only
        // emitted for entities that declare an @autoSet onUpdate column.
        if (!onUpdateAutoSet.isEmpty()) {
            src.append("    /** Issue #203 @autoSet: stamp every onUpdate column to now() (server-owned; bumps on every PATCH). */\n");
            src.append("    public void stampAutoSetOnUpdate() {\n");
            for (MetaField field : onUpdateAutoSet) {
                src.append("        assigned.put(\"").append(field.getName()).append("\", ")
                   .append(AutoSetSupport.nowExpr(field)).append(");\n");
            }
            src.append("    }\n\n");
        }

        // fromJson — the presence-tracked builder.
        src.append("    /**\n");
        src.append("     * Build from a JSON body. A non-object body is rejected; an ABSENT key is\n");
        src.append("     * untouched; a present null CLEARS a non-@required field and is a validation\n");
        src.append("     * error on a @required one; a present value binds via Jackson exactly as\n");
        src.append("     * create does. Unknown keys are ignored (FR-035 PATCH-3 deferred).\n");
        src.append("     */\n");
        src.append("    public static ").append(patchName)
           .append(" fromJson(JsonNode body, ObjectMapper mapper) {\n");
        src.append("        if (!body.isObject()) throw new PatchValidationException(\"(request body)\");\n");
        src.append("        Map<String, Object> assigned = new LinkedHashMap<>();\n");
        for (MetaField field : settable) {
            String name = field.getName();
            String type = patchComponentType(field, entity, dtoName);
            boolean required = isRequired(field);
            // A TypeReference (not a raw Class) so a generic component — e.g. a
            // field.<scalar> @isArray List<Long> — binds with its element type intact.
            src.append("        bind(body, mapper, assigned, \"").append(name)
               .append("\", new TypeReference<").append(type).append(">() {}, ")
               .append(required).append(");\n");
        }
        src.append("        return new ").append(patchName).append("(assigned);\n");
        src.append("    }\n\n");

        // bind — one settable field. treeToValue lets Jackson handle every subtype (no hand-rolled arms).
        src.append("    private static void bind(JsonNode body, ObjectMapper mapper, Map<String, Object> assigned,\n");
        src.append("            String field, TypeReference<?> type, boolean required) {\n");
        src.append("        if (!body.has(field)) return;                         // absent → untouched\n");
        src.append("        JsonNode node = body.get(field);\n");
        src.append("        if (node.isNull()) {\n");
        src.append("            if (required) throw new PatchValidationException(field);\n");
        src.append("            assigned.put(field, null);                         // explicit null → clear\n");
        src.append("            return;\n");
        src.append("        }\n");
        src.append("        try {\n");
        src.append("            assigned.put(field, mapper.treeToValue(node, type));\n");
        src.append("        } catch (JsonProcessingException e) {\n");
        src.append("            throw new PatchValidationException(field);\n");
        src.append("        }\n");
        src.append("    }\n");
        src.append("}\n");

        writeJavaFile(entity, outRoot, pkg, patchName, src.toString());
    }

    /**
     * The vanilla {@code <Entity>Patch} settable set: DTO component fields (scalars PLUS
     * value-object jsonb columns, Program D) MINUS the primary-key field(s) MINUS any
     * {@code @autoSet} column.
     *
     * <p>Review-gate fix (write-once contract): {@code @autoSet} is server-owned — onCreate
     * columns (e.g. {@code createdAt}) are write-once and nothing else in the generated CRUD
     * ever overwrites them past insert, so leaving one caller-bindable here let a PATCH mutate
     * it directly. onUpdate columns (e.g. {@code updatedAt}) are always overwritten by the
     * separately-emitted {@code stampAutoSetOnUpdate()} hook regardless of this list, but are
     * excluded too for consistency with the TPH {@link #settableFields(MetaObject, String)}
     * 2-arg overload below, which already excludes {@code @autoSet} entirely — this is the
     * SSOT alignment the 2-arg overload's own comment calls out as remaining scope.</p>
     */
    private static List<MetaField> settableFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : minusPk(entity, dtoComponentFields(entity), null)) {
            if (AutoSetSupport.isAutoSet(field)) continue;
            out.add(field);
        }
        return out;
    }

    /**
     * The TPH per-subtype settable set: {@link #scalarFields(MetaObject)} MINUS the primary key
     * MINUS the field named {@code alsoExclude} (the immutable discriminator, or nothing when
     * {@code null}). Scalar-only — value-object columns on a TPH hierarchy are out of scope
     * (Program D), so a TPH base's union DTO and per-subtype patch stay VO-free.
     *
     * <p>Public so {@link SpringControllerGenerator#emitTph} can validate a TPH per-subtype CREATE
     * body against exactly the field set the sibling {@code <Sub>Patch} covers (effective scalars
     * MINUS the primary key MINUS the discriminator), keeping create + patch validation on one
     * SSOT: the PK is auto-generated and the discriminator is injected from the URL, so neither is
     * validated from the body.</p>
     */
    public static List<MetaField> settableFields(MetaObject entity, String alsoExclude) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : minusPk(entity, scalarFields(entity), alsoExclude)) {
            // ADR-0045 (#203/#229): @autoSet is server-owned — never a caller-settable TPH
            // per-subtype field. Excluding it here is the SSOT for both the create-validated set
            // (SpringControllerGenerator#emitTph's createValidated) and the sibling <Sub>Patch's
            // settable/bindable set, so a caller can neither be required to supply it on POST nor
            // mutate it via PATCH. (The single-arg vanilla settableFields(entity) overload above,
            // used by the non-TPH <Entity>Patch, applies the identical exclusion — review-gate fix,
            // see its javadoc.)
            if (AutoSetSupport.isAutoSet(field)) continue;
            out.add(field);
        }
        return out;
    }

    /** {@code pool} MINUS the entity's primary-key field(s) MINUS {@code alsoExclude} (when non-null). */
    private static List<MetaField> minusPk(MetaObject entity, List<MetaField> pool, String alsoExclude) {
        List<String> pkFields = entity.getIdentities(true).stream()
            .filter(MetaIdentity::isPrimary)
            .findFirst()
            .map(MetaIdentity::getFields)
            .orElse(List.of());
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : pool) {
            if (pkFields.contains(field.getName())) continue;
            if (alsoExclude != null && alsoExclude.equals(field.getName())) continue;
            // FR-024 §7 (#214): a DERIVED field (origin.*) is view-computed, not stored on the
            // writable table, so it is excluded from every write-input shape (the <Entity>Patch
            // and the TPH per-subtype settable set). The read <Entity>Dto still carries it (via
            // dtoComponentFields) — only the settable/write pools drop it.
            if (field.isDerived()) continue;
            out.add(field);
        }
        return out;
    }

    /** The {@code <Entity>Patch} component type for {@code field}. Identical to the DTO's
     *  FR-019-aware {@link #componentTypeFr019} EXCEPT for an INLINE {@code field.enum}: its
     *  enum is declared nested in the DTO record body, so the sibling {@code <Entity>Patch}
     *  must qualify it as {@code <Entity>Dto.<EnumName>}. A shared / materialized / {@code @provided}
     *  enum is a top-level type, resolvable unqualified. */
    private String patchComponentType(MetaField<?> field, MetaObject entity, String dtoName) {
        if (field instanceof EnumField && Fr019SharedEnum.sharedEnumForField(field) == null) {
            return SpringTypeMapper.payloadJavaTypeName(field, entity, dtoName + ".");
        }
        return componentTypeFr019(field, entity);
    }

    /**
     * FR-017 TPH: emit the discriminator-base DTO as the UNION of the base's own scalar columns
     * (full validation) plus every subtype-only column (folded NULLABLE — no validation, since a
     * row of any other subtype stores NULL there even when the field is {@code @required}). This
     * single wire shape backs both the polymorphic and per-subtype endpoints of the base controller.
     */
    protected void emitTphUnion(MetaObject base, MetaDataLoader loader, Path outRoot) {
        List<MetaField> fields = new ArrayList<>(scalarFields(base));
        for (MetaField field : TphPlan.collectSubtypeFields(base, loader)) {
            if (field instanceof ObjectField) continue;
            fields.add(field);
        }
        // The TPH union DTO is a partial-PATCH-friendly wire body — every component is a nullable
        // wrapper and carries NO bean-validation (a per-subtype POST/PATCH supplies only its own
        // columns; the single table's column nullability is the real constraint). The controller
        // intentionally omits @Valid, so keeping @NotNull here would be inert + misleading. Matches
        // the Kotlin lane's all-nullable union data class.
        List<String> annotationsPerField = new ArrayList<>(fields.size());
        for (int i = 0; i < fields.size(); i++) annotationsPerField.add("");
        // ADR-0045 (#203/#229): the TPH controller's per-subtype create/update bind and return
        // this UNION Dto type (repository.createWithType/patchByIdAndType), never a subtype-shaped
        // record, so the stamping helper the controller calls (stampForInsert) must be typed to
        // the union HERE — a standalone <Sub>Dto's own stampForInsert(SubDto) would not type-check
        // against the union-typed `dto` the create handler binds. Gated exactly like the vanilla
        // path (AutoSetSupport.hasAutoSetFields(base) — @autoSet columns live on the base, shared
        // by every subtype row in the single table): empty for a non-@autoSet hierarchy, so the
        // union DTO stays byte-identical.
        List<String> extraBodyMembers =
            (SpringRepositoryGenerator.appliesTo(base) && AutoSetSupport.hasAutoSetFields(base))
                ? autoSetStampHelpers(base, fields, SpringNaming.dtoName(SpringNaming.splitFqn(base.getName())[1]))
                : List.of();
        emitRecord(base, outRoot, fields, annotationsPerField, extraBodyMembers);
    }

    /** Shared record emitter: write {@code <Entity>Dto} record from a field + per-field annotation
     *  list, plus {@code extraBodyMembers} (static methods / declarations) appended after the
     *  nested-enum declarations in the record body — e.g. the issue #203 @autoSet stamping helpers. */
    private void emitRecord(MetaObject entity, Path outRoot, List<MetaField> fields,
            List<String> annotationsPerField, List<String> extraBodyMembers) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String recordName = SpringNaming.dtoName(shortName);

        // A jakarta constraint is any annotation content OTHER than the Jackson @JsonDeserialize
        // (#234) — stripping only @JsonDeserialize keeps this byte-identical for every pre-#234
        // DTO (which never carries one) while a uri/inet-only component doesn't pull an unused
        // jakarta.validation import.
        boolean usesValidation = annotationsPerField.stream()
            .anyMatch(a -> !a.replaceAll("@JsonDeserialize\\([^)]*\\)", "").trim().isEmpty());
        // @Valid (jakarta.validation, NOT ...constraints) cascades validation into a
        // value-object jsonb component — emitted on VO fields by emit() (Program D).
        boolean usesValid = annotationsPerField.stream().anyMatch(a -> a.contains("@Valid"));
        // #234: a strict field.uri / field.inet component carries @JsonDeserialize(using = …).
        boolean usesNetDeser = annotationsPerField.stream().anyMatch(a -> a.contains("@JsonDeserialize"));

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        if (usesNetDeser) {
            src.append("import com.fasterxml.jackson.databind.annotation.JsonDeserialize;\n");
        }
        // Wildcard import keeps the emit simple — record components carry a small,
        // closed set of jakarta.validation.constraints annotations.
        if (usesValid) {
            src.append("import jakarta.validation.Valid;\n");
        }
        if (usesValidation) {
            src.append("import jakarta.validation.constraints.*;\n");
        }
        if (usesNetDeser || usesValid || usesValidation) {
            src.append('\n');
        }
        src.append("/** GENERATED — wire DTO for ").append(shortName)
           .append(". Do not hand-edit; regenerated from metadata. */\n");
        src.append("public record ").append(recordName).append("(\n");

        // Filter ObjectField — see class javadoc. Same reason as the Kotlin port's
        // KotlinExposedTableGenerator scalar-only filter.
        for (int i = 0; i < fields.size(); i++) {
            MetaField field = fields.get(i);
            String annotations = annotationsPerField.get(i);
            src.append("    ");
            if (!annotations.isEmpty()) src.append(annotations).append(' ');
            src.append(componentTypeFr019(field, entity)).append(' ').append(field.getName());
            if (i < fields.size() - 1) src.append(',');
            src.append('\n');
        }

        // Nested `public enum <Name> { <members> }` declarations for this record's INLINE enum
        // fields, deduped by enum-type name. FR-019: a field resolving to a package-level shared
        // enum is NOT nested here — its type is materialized standalone (or @provided externally)
        // and merely referenced. Inline enums stay nested (cross-port parity, byte-identical default).
        List<String> enumDecls = collectEnumDecls(entity, fields);
        if (enumDecls.isEmpty() && extraBodyMembers.isEmpty()) {
            src.append(") {}\n");
        } else {
            src.append(") {\n");
            for (String decl : enumDecls) src.append("    ").append(decl).append('\n');
            for (String member : extraBodyMembers) src.append(member);
            src.append("}\n");
        }

        writeJavaFile(entity, outRoot, pkg, recordName, src.toString());
    }

    /**
     * Issue #203 — build the record-body {@code @autoSet} stamping helpers for {@code entity}
     * (whose DTO record is {@code recordName}, over the component list {@code fields}):
     * <ul>
     *   <li>{@code stampForInsert(dto)} — a copy with EVERY {@code @autoSet} column (onCreate AND
     *       onUpdate) stamped to {@code now()} (a fresh row's updated_at equals its created_at —
     *       one shared {@code now()} local per temporal type guarantees the equality);</li>
     *   <li>{@code stampForUpdate(dto)} — a copy with {@code onUpdate} columns stamped to
     *       {@code now()} and {@code onCreate} PRESERVED (never rewrites created_at);</li>
     *   <li>{@code insertPreserving(dto)} — the DTO written VERBATIM (import/restore/replication).</li>
     * </ul>
     * Each rebuilds the immutable record via its canonical constructor, copying every non-stamped
     * component through and substituting {@code now()} for the stamped ones.
     */
    private List<String> autoSetStampHelpers(MetaObject entity, List<MetaField> fields, String recordName) {
        List<MetaField> stampAll = AutoSetSupport.stampFields(entity);      // onCreate + onUpdate
        List<MetaField> onUpdate = AutoSetSupport.onUpdateFields(entity);   // onUpdate only
        List<String> members = new ArrayList<>();
        members.add(stampHelper(recordName, "stampForInsert", fields, stampAll,
            "a copy with every @autoSet column (onCreate AND onUpdate) stamped to now() on insert "
                + "(the model value is ignored; a fresh row's updated_at equals its created_at)"));
        members.add(stampHelper(recordName, "stampForUpdate", fields, onUpdate,
            "a copy with @autoSet onUpdate columns stamped to now(); onCreate columns are preserved "
                + "(never rewrites created_at — the full-DTO update path)"));
        members.add(
            "\n    /** Issue #203 @autoSet escape hatch: the DTO written VERBATIM (import/restore/replication). */\n"
            + "    public static " + recordName + " insertPreserving(" + recordName + " dto) { return dto; }\n");
        return members;
    }

    /**
     * One {@code public static <Record> <method>(<Record> dto)} stamping helper: rebuild the record
     * via its canonical constructor, substituting {@code now()} (keyed off each column's temporal
     * type) for every field in {@code stamp} and copying the rest through. One {@code now()} local
     * per distinct temporal Java type so all fields of that type share a single instant.
     */
    private static String stampHelper(String recordName, String methodName, List<MetaField> fields,
            List<MetaField> stamp, String doc) {
        java.util.Set<String> stampNames = new java.util.LinkedHashSet<>();
        for (MetaField f : stamp) stampNames.add(f.getName());

        StringBuilder b = new StringBuilder();
        b.append("\n    /** Issue #203 @autoSet: ").append(doc).append(". */\n");
        b.append("    public static ").append(recordName).append(' ').append(methodName)
         .append('(').append(recordName).append(" dto) {\n");
        // One shared now() local per distinct temporal Java type among the stamped fields.
        java.util.LinkedHashMap<String, String> typeToVar = new java.util.LinkedHashMap<>();
        for (MetaField f : stamp) {
            String javaType = SpringTypeMapper.javaTypeName(f);
            typeToVar.computeIfAbsent(javaType, jt -> {
                String var = "__now" + jt.substring(jt.lastIndexOf('.') + 1);
                b.append("        ").append(jt).append(' ').append(var).append(" = ")
                 .append(AutoSetSupport.nowExpr(f)).append(";\n");
                return var;
            });
        }
        b.append("        return new ").append(recordName).append("(\n");
        for (int i = 0; i < fields.size(); i++) {
            MetaField field = fields.get(i);
            String name = field.getName();
            String value = stampNames.contains(name)
                ? typeToVar.get(SpringTypeMapper.javaTypeName(field))
                : "dto." + name + "()";
            b.append("            ").append(value);
            if (i < fields.size() - 1) b.append(',');
            b.append('\n');
        }
        b.append("        );\n");
        b.append("    }\n");
        return b.toString();
    }

    /**
     * Emit the abstract <em>shape</em> for an {@code abstract: true} entity: a
     * Java {@code interface} with one accessor per scalar field. A {@code record}
     * cannot serve as a base type, so the shape is an interface concrete DTO
     * records can later be wired to implement. Only emitted when the
     * {@code emitAbstractShapes} arg is {@code true} (default OFF for Java).
     */
    protected void emitAbstractShape(MetaObject entity, Path outRoot) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String typeName = SpringNaming.dtoName(shortName);

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("/** GENERATED — abstract wire-DTO shape for ").append(shortName)
           .append(". Do not hand-edit; regenerated from metadata. */\n");
        src.append("public interface ").append(typeName).append(" {\n");
        for (MetaField field : scalarFields(entity)) {
            String type = SpringTypeMapper.javaTypeName(field);
            src.append("    ").append(type).append(' ').append(field.getName()).append("();\n");
        }
        src.append("}\n");

        writeJavaFile(entity, outRoot, pkg, typeName, src.toString());
    }

    /**
     * Resolve {@code <outRoot>/<pkg-as-dirs>/<typeName>.java}, create parent
     * directories, and write {@code body}. Shared file-IO tail for both the
     * concrete-record and abstract-interface emit paths.
     */
    protected void writeJavaFile(MetaObject entity, Path outRoot, String pkg, String typeName, String body) {
        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(typeName + ".java");
            GeneratedFileWriter.write(outFile, body);
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + typeName + ".java for entity " + entity.getName() + ": " + e, e);
        }
    }

    /**
     * Return the entity's scalar fields — i.e. every {@link MetaField} that is
     * not an {@link ObjectField}. Value-object {@code field.object} columns are
     * carried separately by {@link #dtoComponentFields(MetaObject)}; this
     * scalar-only view still backs the TPH union / abstract-shape / sort surfaces
     * (which are value-object-agnostic).
     */
    public static List<MetaField> scalarFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : entity.getMetaFields()) {
            if (field instanceof ObjectField) continue;
            out.add(field);
        }
        return out;
    }

    /** The single legal {@code @storage} value for a value-object jsonb column (Program D);
     *  {@code flattened} / {@code subdocument} owned-object storage is out of scope. */
    static final String STORAGE_JSONB = "jsonb";

    /**
     * The vanilla {@code <Entity>Dto} / {@code <Entity>Patch} component fields: every scalar
     * field PLUS every value-object jsonb column ({@code field.object @objectRef=<value> @storage:jsonb},
     * single or {@code @isArray}), in declared order. Program D: the VO columns become
     * strongly-typed record components (bound to the generated {@code <VO>} record) so they
     * POST + PATCH with nested validation. A non-VO {@link ObjectField} (flattened / subdocument
     * storage, or an unresolved / non-value {@code @objectRef}) is still skipped.
     */
    public static List<MetaField> dtoComponentFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : entity.getMetaFields()) {
            if (field instanceof ObjectField) {
                if (isValueObjectJsonbField(field)) out.add(field);
                continue;
            }
            out.add(field);
        }
        return out;
    }

    /** The value-object jsonb columns of {@code entity}, in declared order (Program D) — the
     *  fields the controller runs explicit nested-VO validation over on PATCH (spec section 0). */
    public static List<ObjectField> valueObjectJsonbFields(MetaObject entity) {
        List<ObjectField> out = new ArrayList<>();
        for (MetaField field : entity.getMetaFields()) {
            if (isValueObjectJsonbField(field)) out.add((ObjectField) field);
        }
        return out;
    }

    /**
     * True iff {@code field} is a value-object jsonb column: a {@link ObjectField} whose
     * {@code @objectRef} resolves to an {@code object.value} and whose {@code @storage} is
     * jsonb (explicit, or the single-jsonb-column default when {@code @storage} is absent).
     * Flattened / subdocument owned-object storage is out of scope (Program D).
     */
    public static boolean isValueObjectJsonbField(MetaField<?> field) {
        if (!(field instanceof ObjectField of)) return false;
        if (!of.hasMetaAttr(ObjectField.ATTR_OBJECTREF)) return false;
        MetaObject ref;
        try {
            ref = of.getObjectRef();
        } catch (RuntimeException unresolved) {
            return false;
        }
        if (ref == null || !MetaObject.SUBTYPE_VALUE.equals(ref.getSubType())) return false;
        if (!of.hasMetaAttr(ObjectField.ATTR_STORAGE)) return true; // default single-jsonb-column
        Object storage = of.getMetaAttr(ObjectField.ATTR_STORAGE).getValue();
        return STORAGE_JSONB.equalsIgnoreCase(String.valueOf(storage).trim());
    }

    /** The referenced {@code object.value} when {@code field} is a value-object jsonb column,
     *  else {@code null}. Used by {@link SpringValueObjectGenerator}'s reachability walk. */
    static MetaObject valueObjectRefOf(MetaField<?> field) {
        return isValueObjectJsonbField(field) ? ((ObjectField) field).getObjectRef() : null;
    }

    // === validation (SP-C validator parity) =================================

    /**
     * Java DTO-record component type for {@code field} owned by {@code owner}. A
     * {@code field.enum} is typed as the value-constrained nested Java {@code enum}
     * ({@link SpringTypeMapper#enumTypeName}, single or {@code List<Enum>}) whose declaration
     * {@link #collectEnumDecls} emits inside the record body — parity with the other ports and
     * with {@code SpringPayloadGenerator}. Other scalars delegate to {@link SpringTypeMapper};
     * array fields ({@code isArray=true}) are wrapped as {@code List<elementType>} (the wrapped
     * element type so an omitted JSON element deserialises to {@code null}).
     */
    public static String componentType(MetaField<?> field, MetaObject owner) {
        if (field instanceof EnumField) {
            return SpringTypeMapper.payloadJavaTypeName(field, owner, "");
        }
        String element = SpringTypeMapper.javaTypeName(field);
        return field.isArrayType() ? "java.util.List<" + element + ">" : element;
    }

    /**
     * FR-019-aware DTO component type. A {@code field.enum} resolving to a package-level shared enum
     * is typed by the materialized standalone type (a bare {@code E} in the same package, else its
     * FQN) or — when {@code @provided} — the configured external {@code <ns>.E}; an enum array wraps
     * it in {@code List<…>}. Every other field (including inline enums) delegates verbatim to the
     * static {@link #componentType(MetaField, MetaObject)}, so the inline default stays byte-identical.
     */
    private String componentTypeFr019(MetaField<?> field, MetaObject owner) {
        if (field instanceof EnumField) {
            Fr019SharedEnum.SharedEnum shared = Fr019SharedEnum.sharedEnumForField(field);
            if (shared != null) {
                String ref = Fr019SharedEnum.typeReference(shared, owner, fr019Config);
                return field.isArrayType() ? "java.util.List<" + ref + ">" : ref;
            }
        }
        return componentType(field, owner);
    }

    /**
     * FR-019: emit each materialized shared enum (package-level abstract, non-{@code @provided},
     * consumed by ≥1 entity field) ONCE as a standalone top-level Java {@code enum} in its declaring
     * package — {@code <pkg>/<Name>.java} containing {@code public enum <Name> { A, B, C }}. Consuming
     * DTOs reference this type. Provided enums emit nothing here (referenced externally).
     */
    private void emitSharedEnums(MetaDataLoader loader, Path outRoot) {
        for (Fr019SharedEnum.SharedEnum shared : Fr019SharedEnum.materializedSharedEnums(loader)) {
            StringBuilder src = new StringBuilder();
            if (!shared.javaPackage().isEmpty()) {
                src.append("package ").append(shared.javaPackage()).append(";\n\n");
            }
            src.append("/** GENERATED — shared enum ").append(shared.name())
               .append(". Do not hand-edit; regenerated from metadata. */\n");
            src.append("public enum ").append(shared.name()).append(" { ")
               .append(String.join(", ", shared.values())).append(" }\n");
            writeSharedEnumFile(shared, outRoot, src.toString());
        }
    }

    // === #234 strict field.uri / field.inet bind-layer enforcement =============

    /**
     * True iff {@code field} is a STRICT (non-{@code @lenient}) {@code field.uri} / {@code field.inet} —
     * the fields whose DTO component binds through the {@link #emitNetBindings generated MetaNetBindings}
     * literal deserializer. #234: a {@code @lenient} uri/inet degrades to a plain String
     * ({@link SpringTypeMapper#javaTypeName}) with NO deserializer, so it is NOT strict.
     */
    private static boolean isStrictNetField(MetaField<?> field) {
        return (field instanceof UriField || field instanceof InetField)
            && !SpringTypeMapper.isLenientNetField(field);
    }

    /**
     * #234: the Jackson {@code @JsonDeserialize} annotation binding a STRICT {@code field.uri} /
     * {@code field.inet} record component to the codegen-owned literal deserializer in the same-package
     * {@code MetaNetBindings} — an absolute-scheme URI or an IPv4/IPv6 LITERAL (never a DNS lookup). An
     * {@code @isArray} component uses {@code contentUsing} (deserialize the ELEMENTS). Empty for any
     * other field.
     */
    private static String netDeserializeAnnotation(MetaField<?> field) {
        if (!isStrictNetField(field)) return "";
        String deser = (field instanceof UriField)
            ? "MetaNetBindings.AbsoluteUriDeserializer.class"
            : "MetaNetBindings.InetLiteralDeserializer.class";
        String key = field.isArrayType() ? "contentUsing" : "using";
        return "@JsonDeserialize(" + key + " = " + deser + ")";
    }

    /**
     * #234: emit the codegen-owned {@code MetaNetBindings} support file — the strict Jackson
     * deserializers a STRICT {@code field.uri} / {@code field.inet} record component binds through —
     * ONCE per Java package that has such a field. Dependency-free (java.net + Jackson only), so the
     * generated code still runs without any MetaObjects runtime (mirrors the Kotlin support-block).
     */
    private void emitNetBindings(MetaDataLoader loader, Path outRoot) {
        java.util.Set<String> packages = new java.util.LinkedHashSet<>();
        for (MetaObject entity : loader.getMetaObjects()) {
            if (!appliesTo(entity)) continue;
            for (MetaField field : dtoComponentFields(entity)) {
                if (isStrictNetField(field)) {
                    packages.add(SpringNaming.splitFqn(entity.getName())[0]);
                    break;
                }
            }
        }
        for (String pkg : packages) writeNetBindingsFile(pkg, outRoot);
    }

    /** Write {@code MetaNetBindings.java} into {@code pkg}. The class is fixed (only the package
     *  header varies): two {@link com.fasterxml.jackson.databind.JsonDeserializer}s implementing the
     *  #234 Contract-A strict URI / IP-literal rules verified against the shared validation-conformance
     *  corpus. */
    private void writeNetBindingsFile(String pkg, Path outRoot) {
        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) src.append("package ").append(pkg).append(";\n\n");
        src.append("import com.fasterxml.jackson.core.JsonParser;\n");
        src.append("import com.fasterxml.jackson.databind.DeserializationContext;\n");
        src.append("import com.fasterxml.jackson.databind.JsonDeserializer;\n\n");
        src.append("import java.io.IOException;\n");
        src.append("import java.net.InetAddress;\n");
        src.append("import java.net.URI;\n");
        src.append("import java.net.URISyntaxException;\n\n");
        src.append("/** GENERATED (#234) — strict Jackson deserializers for field.uri / field.inet.\n");
        src.append(" *  Do not hand-edit; regenerated from metadata. Dependency-free (java.net + Jackson). */\n");
        src.append("public final class MetaNetBindings {\n\n");
        src.append("    private MetaNetBindings() {}\n\n");
        src.append("    /** field.uri — an ABSOLUTE URI carrying a scheme (leading/trailing whitespace trimmed,\n");
        src.append("     *  WHATWG). A relative reference (example.com, /path) or malformed value is rejected. */\n");
        src.append("    public static final class AbsoluteUriDeserializer extends JsonDeserializer<URI> {\n");
        src.append("        @Override\n");
        src.append("        public URI deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {\n");
        src.append("            String raw = p.getValueAsString();\n");
        src.append("            if (raw == null) return null;\n");
        src.append("            URI uri;\n");
        src.append("            try {\n");
        src.append("                uri = new URI(raw.trim());\n");
        src.append("            } catch (URISyntaxException e) {\n");
        src.append("                throw new IllegalArgumentException(\"field.uri: not a valid URI: \" + raw, e);\n");
        src.append("            }\n");
        src.append("            if (!uri.isAbsolute()) {\n");
        src.append("                throw new IllegalArgumentException(\n");
        src.append("                        \"field.uri: must be an absolute URI carrying a scheme: \" + raw);\n");
        src.append("            }\n");
        src.append("            return uri;\n");
        src.append("        }\n");
        src.append("    }\n\n");
        src.append("    /** field.inet — an IPv4 or IPv6 LITERAL only. Never a DNS lookup: a value containing\n");
        src.append("     *  ':' can only be an IPv6 literal (getByName parses it offline), otherwise a strict\n");
        src.append("     *  dotted-quad IPv4. Hostnames, CIDR, padding, out-of-range octets are rejected. */\n");
        src.append("    public static final class InetLiteralDeserializer extends JsonDeserializer<InetAddress> {\n");
        src.append("        @Override\n");
        src.append("        public InetAddress deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {\n");
        src.append("            String raw = p.getValueAsString();\n");
        src.append("            if (raw == null) return null;\n");
        src.append("            // No trim: IP-literal grammar has no whitespace, so padding is rejected.\n");
        src.append("            if (raw.indexOf(':') >= 0) {\n");
        src.append("                try {\n");
        src.append("                    return InetAddress.getByName(raw); // ':' => IPv6 literal — getByName does no DNS\n");
        src.append("                } catch (Exception e) {\n");
        src.append("                    throw new IllegalArgumentException(\"field.inet: not a valid IPv6 literal: \" + raw, e);\n");
        src.append("                }\n");
        src.append("            }\n");
        src.append("            return parseIpv4(raw);\n");
        src.append("        }\n\n");
        src.append("        private static InetAddress parseIpv4(String s) {\n");
        src.append("            String[] parts = s.split(\"\\\\.\", -1);\n");
        src.append("            if (parts.length != 4) {\n");
        src.append("                throw new IllegalArgumentException(\"field.inet: not a valid IPv4 literal: \" + s);\n");
        src.append("            }\n");
        src.append("            byte[] octets = new byte[4];\n");
        src.append("            for (int i = 0; i < 4; i++) {\n");
        src.append("                String part = parts[i];\n");
        src.append("                // #234 review H1: reject a leading-zero octet (010 / 01) — the\n");
        src.append("                // octal/decimal-parse ambiguity — matching Python ipaddress + the TS regex.\n");
        src.append("                if (part.isEmpty() || part.length() > 3\n");
        src.append("                        || (part.length() > 1 && part.charAt(0) == '0')) {\n");
        src.append("                    throw new IllegalArgumentException(\"field.inet: not a valid IPv4 literal: \" + s);\n");
        src.append("                }\n");
        src.append("                for (int j = 0; j < part.length(); j++) {\n");
        src.append("                    if (!Character.isDigit(part.charAt(j))) {\n");
        src.append("                        throw new IllegalArgumentException(\"field.inet: not a valid IPv4 literal: \" + s);\n");
        src.append("                    }\n");
        src.append("                }\n");
        src.append("                int v = Integer.parseInt(part);\n");
        src.append("                if (v > 255) {\n");
        src.append("                    throw new IllegalArgumentException(\"field.inet: IPv4 octet out of range: \" + s);\n");
        src.append("                }\n");
        src.append("                octets[i] = (byte) v;\n");
        src.append("            }\n");
        src.append("            try {\n");
        src.append("                return InetAddress.getByAddress(octets);\n");
        src.append("            } catch (Exception e) {\n");
        src.append("                throw new IllegalArgumentException(\"field.inet: not a valid IPv4 literal: \" + s, e);\n");
        src.append("            }\n");
        src.append("        }\n");
        src.append("    }\n");
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("MetaNetBindings.java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException("failed writing MetaNetBindings.java for package " + pkg + ": " + e, e);
        }
    }

    /** Write {@code <outRoot>/<pkg-as-dirs>/<Name>.java} for a materialized shared enum. */
    private void writeSharedEnumFile(Fr019SharedEnum.SharedEnum shared, Path outRoot, String body) {
        try {
            Path outFile = outRoot.resolve(shared.javaPackage().replace('.', '/'))
                                  .resolve(shared.name() + ".java");
            GeneratedFileWriter.write(outFile, body);
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing shared enum " + shared.name() + ".java: " + e, e);
        }
    }

    /**
     * Collect the nested {@code public enum <Name> { <members> }} declarations for the enum
     * fields in {@code fields} (the record's components), deduped by enum-type name (two fields
     * extending one abstract enum collapse onto ONE decl named for the super). Mirrors
     * {@code SpringPayloadGenerator.collectEnumDecls}.
     */
    private static List<String> collectEnumDecls(MetaObject owner, List<MetaField> fields) {
        List<String> decls = new ArrayList<>();
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (MetaField<?> field : fields) {
            if (!(field instanceof EnumField ef)) continue;
            // FR-019: a field resolving to a package-level shared enum (materialized standalone or
            // @provided externally) is referenced, never nested. Skip it here.
            if (Fr019SharedEnum.sharedEnumForField(field) != null) continue;
            String typeName = SpringTypeMapper.enumTypeName(owner, ef);
            if (!seen.add(typeName)) continue; // dedup shared abstract-enum types
            List<String> values = SpringTypeMapper.effectiveEnumValues(ef);
            decls.add("public enum " + typeName + " { " + String.join(", ", values) + " }");
        }
        return decls;
    }

    /** True iff {@code field} is {@code @required} — its own {@code @required} attr OR a
     *  {@code validator.required} child. The SINGLE required-predicate reused across the
     *  DTO's {@code @NotNull} and the FR-035 patch's present-null-on-@required → 400 rule
     *  (the FR-035 patch emit below), so the two cannot drift. */
    public static boolean isRequired(MetaField<?> field) {
        return attrBool(field, MetaField.ATTR_REQUIRED) || hasValidator(field, RequiredValidator.class);
    }

    /**
     * #195 — a field whose value is derived by an {@code origin.aggregate}
     * {@code @agg:any|all|collect} is COALESCE-guaranteed non-null in the synthesized
     * view (any&rarr;false, all&rarr;true, collect&rarr;empty-array), so its read type
     * is non-null even when the field is not {@code @required}. Drives {@code @NotNull}
     * in {@link #validationAnnotations} so a projection DTO's read shape agrees with its
     * view column — adopters no longer handle a null that never occurs.
     *
     * <p>{@code origin.first} is deliberately NOT here (an empty related set selects no
     * row &rarr; null); {@code origin.computed} nullability is expression-dependent, so
     * it stays the conservative nullable default. Mirrors the TS
     * {@code originGuaranteedNonNull} (codegen-ts {@code column-mapper}).</p>
     */
    public static boolean originGuaranteedNonNull(MetaField<?> field) {
        // ADR-0039: own — origin.* never inherits (ADR-0029), so an own-only read is correct.
        for (MetaData c : field.getChildren(MetaData.class, false)) {
            if (!(c instanceof MetaOrigin)) continue;
            if (!AggregateOrigin.SUBTYPE_AGGREGATE.equals(c.getSubType())) continue;
            String agg = ((MetaOrigin) c).getAgg();
            return MetaOrigin.AGG_ANY.equals(agg) || MetaOrigin.AGG_ALL.equals(agg)
                || MetaOrigin.AGG_COLLECT.equals(agg);
        }
        return false;
    }

    /**
     * Build the space-joined jakarta.validation annotation string for a record
     * component from the field's constraint metadata — both field attrs
     * ({@code @required}, {@code @maxLength}) and {@code validator.*} children
     * (length / regex / numeric / array). Returns {@code ""} when the field
     * carries no constraints.
     *
     * <p>Cross-port semantics (see the SP-C validator-parity contract):</p>
     * <ul>
     *   <li>required (field {@code @required} or {@code validator.required}) →
     *       {@code @NotNull}; a required non-array string additionally gets an
     *       implicit {@code @Size(min = 1)} (FR-036 Ruling 1: reject {@code null} +
     *       {@code ""}, ACCEPT whitespace-only) — never {@code @NotBlank}, which
     *       trims and would wrongly reject a whitespace value. An explicitly
     *       authored {@code validator.length @min} is always authoritative over
     *       that implicit floor (#224); {@code @min: 0} opts back to
     *       presence-only and emits no {@code @Size} minimum at all.</li>
     *   <li>{@code validator.length} + field {@code @maxLength} →
     *       {@code @Size(min=…, max=…)} on a NON-array string; the effective max is
     *       {@code min(validator.max, @maxLength)} (FR-036 A3 strictest-wins).</li>
     *   <li>{@code validator.regex @pattern} → {@code @Pattern(regexp=…)} (jakarta
     *       {@code matches()} is full-match — FR-036 Ruling 2, no anchoring needed).</li>
     *   <li>{@code validator.numeric @min/@max} → {@code @Min(…)} / {@code @Max(…)}.</li>
     *   <li>{@code validator.array @min/@max} → {@code @Size(min=…, max=…)} on the {@code List}.</li>
     * </ul>
     */
    /**
     * True when {@code field} participates in its owner's ASSIGNED primary key — an
     * {@code identity.primary} carrying no {@code @generation} (or an explicit
     * {@code assigned}) — and has no {@code @default} to fill it.
     *
     * <p>Such a key is create-REQUIRED regardless of {@code @required}: a natural key or
     * an externally-issued id has no other source, so a create body omitting it can only
     * fail at the database. An {@code increment}/{@code uuid} key is the opposite — the
     * server supplies it, so it must stay optional (and TS omits it from the insert shape
     * entirely). A key carrying a {@code @default} also stays optional: the column has
     * that default.</p>
     *
     * <p>Mirrors the TS {@code assignedPkFieldNames}; gated cross-port by the
     * {@code assigned-pk-missing} case in {@code fixtures/validation-conformance}.</p>
     */
    static boolean isAssignedPrimaryKeyField(MetaField<?> field) {
        if (!(field.getParent() instanceof MetaObject owner)) return false;
        PrimaryIdentity pk = owner.getPrimaryIdentity();
        if (pk == null || pk.isAutoGenerated()) return false;
        if (!pk.getFields().contains(field.getName())) return false;
        // ADR-0039: resolving — @default may be inherited via extends.
        return !field.hasMetaAttr(MetaField.ATTR_DEFAULT);
    }

    public static String validationAnnotations(MetaField<?> field) {
        // Issue #203: an @autoSet field is CRUD-owned (server stamps now() on insert/update),
        // so it is never caller-required and never caller-validated. Emit NO constraint
        // annotations — parity with TS, whose InsertSchema makes @autoSet fields
        // `.optional().transform(...)` (a @required @autoSet field would otherwise emit
        // @NotNull and wrongly 400 a POST that omits the server-filled timestamp).
        if (AutoSetSupport.isAutoSet(field)) return "";

        // FR-024 §7 (#214): a DERIVED field (origin.*) on a WRITE-THROUGH entity is view-computed
        // and read-only — never client-supplied. Java shares one <Entity>Dto for read AND create,
        // and the generated POST-create validates the whole DTO (SpringControllerGenerator), so a
        // guaranteed-non-null aggregate's @NotNull (from originGuaranteedNonNull, #195) would wrongly
        // 400 a create that omits the view-computed field. Emit NO client-validation constraints for
        // such a field (parity with the @autoSet early-return above). A PROJECTION is read-only
        // (isWriteThrough()=false), so its derived fields keep @NotNull for read-nullability agreement.
        if (field.isDerived() && field.getParent() instanceof MetaObject
                && ((MetaObject) field.getParent()).isWriteThrough()) {
            return "";
        }

        boolean isArray = field.isArrayType();
        boolean isString = field instanceof StringField;
        List<String> out = new ArrayList<>();

        boolean required = isRequired(field) || isAssignedPrimaryKeyField(field);
        // FR-036 Ruling 1: a @required value → @NotNull (rejects null). Non-empty for a
        // @required NON-ARRAY string is enforced by @Size(min>=1) in the string-length arm
        // below — NOT @NotBlank, which trims and would wrongly reject a whitespace-only value.
        // A @required array keeps @NotNull only (no @NotEmpty).
        // #195: an origin.aggregate any/all/collect field is COALESCE-guaranteed non-null on
        // read (any→false / all→true / collect→[]), so it is @NotNull even when not @required
        // (the non-empty @Size(min=1) floor below stays keyed on @required only — such fields
        // are boolean or array, never a non-array string).
        if (required || originGuaranteedNonNull(field)) {
            out.add("@NotNull");
        }

        // String character-length @Size — a NON-array string field only (FR-036 A3): a
        // field.string @isArray @maxLength must NOT carry a char-count @Size on its List
        // (element-count bounds come solely from the validator.array arm below). Combines
        // the explicit validator.length bounds with the field-level @maxLength.
        if (isString && !isArray) {
            Integer lengthMin = null;
            Integer lengthMax = null;
            LengthValidator length = validator(field, LengthValidator.class);
            if (length != null) {
                lengthMin = attrInt(length, LengthValidator.ATTR_MIN);
                lengthMax = attrInt(length, LengthValidator.ATTR_MAX);
            }
            Integer fieldMaxLength = attrInt(field, StringField.ATTR_MAX_LENGTH);
            if (fieldMaxLength != null) {
                // FR-036 A3 precedence: strictest-wins — min(validator.length @max, @maxLength).
                lengthMax = (lengthMax == null) ? fieldMaxLength : Math.min(lengthMax, fieldMaxLength);
            }
            if (required) {
                // FR-036 Ruling 1 non-empty floor — applies ONLY when no
                // validator.length @min was authored. An explicitly authored @min
                // is always AUTHORITATIVE over the implicit floor (#224 / ADR-0044):
                // @min: 0 opts back to presence-only and, per the cross-port
                // emission pin, emits NO minimum constraint at all (no
                // @Size(min=0)) — cleanest, deterministic output across ports.
                if (lengthMin == null) {
                    lengthMin = 1;
                } else if (lengthMin == 0) {
                    lengthMin = null;
                }
            }
            if (lengthMin != null || lengthMax != null) {
                out.add(sizeAnnotation(lengthMin, lengthMax));
            }
        }

        // Regex pattern.
        RegexValidator regex = validator(field, RegexValidator.class);
        if (regex != null) {
            String pattern = regex.resolvePattern();
            if (pattern != null) {
                out.add("@Pattern(regexp = \"" + escapeJavaString(pattern) + "\")");
            }
        }

        // Numeric value bounds.
        NumericValidator numeric = validator(field, NumericValidator.class);
        if (numeric != null) {
            Integer min = attrInt(numeric, NumericValidator.ATTR_MIN);
            Integer max = attrInt(numeric, NumericValidator.ATTR_MAX);
            if (min != null) out.add("@Min(" + min + ")");
            if (max != null) out.add("@Max(" + max + ")");
        }

        // Array element-count bounds → @Size on the List component.
        ArrayValidator array = validator(field, ArrayValidator.class);
        if (array != null) {
            Integer min = attrInt(array, ArrayValidator.ATTR_MIN);
            Integer max = attrInt(array, ArrayValidator.ATTR_MAX);
            if (min != null || max != null) {
                out.add(sizeAnnotation(min, max));
            }
        }

        // ADR-0036/0037 Wave 3 — @stringFormat on a plain string field. The canonical
        // matcher per format lives HERE in codegen (NOT author validator.regex), since
        // cross-language regex engines diverge. email → Jakarta @Email; hostname → a
        // canonical DNS-hostname @Pattern check.
        if (isString && !isArray && field.hasMetaAttr(StringField.ATTR_STRING_FORMAT)) {
            String format = String.valueOf(
                field.getMetaAttr(StringField.ATTR_STRING_FORMAT).getValue()).trim();
            if (StringField.STRING_FORMAT_EMAIL.equals(format)) {
                out.add("@Email");
            } else if (StringField.STRING_FORMAT_HOSTNAME.equals(format)) {
                out.add("@Pattern(regexp = \"" + escapeJavaString(HOSTNAME_REGEX) + "\")");
            }
        }

        return String.join(" ", out);
    }

    /**
     * Canonical DNS-hostname matcher for {@code @stringFormat: hostname} (ADR-0036/0037
     * Wave 3). Codegen-owned — one or more dot-separated labels, each 1–63 chars of
     * alphanumerics/hyphens not starting or ending with a hyphen. Mirrors the cross-port
     * hostname matcher (TS Zod hostname check).
     */
    static final String HOSTNAME_REGEX =
        "^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$";

    protected static String sizeAnnotation(Integer min, Integer max) {
        StringBuilder b = new StringBuilder("@Size(");
        boolean wrote = false;
        if (min != null) { b.append("min = ").append(min); wrote = true; }
        if (max != null) { if (wrote) b.append(", "); b.append("max = ").append(max); }
        return b.append(')').toString();
    }

    // --- metadata read helpers ----------------------------------------------

    protected static boolean attrBool(MetaField<?> field, String attr) {
        if (!field.hasMetaAttr(attr)) return false;
        Object raw = field.getMetaAttr(attr).getValue();
        if (raw instanceof Boolean b) return b;
        return Boolean.parseBoolean(String.valueOf(raw));
    }

    /** Read an int-valued attr from a node, trying each name in order; {@code null} when absent. */
    protected static Integer attrInt(MetaData node, String... attrNames) {
        for (String attr : attrNames) {
            if (node.hasMetaAttr(attr)) {
                try {
                    return Integer.valueOf(node.getMetaAttr(attr).getValueAsString().trim());
                } catch (NumberFormatException ignore) {
                    return null;
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static <V extends MetaValidator> V validator(MetaField<?> field, Class<V> type) {
        for (MetaData child : field.getChildren()) {
            if (type.isInstance(child)) return (V) child;
        }
        return null;
    }

    protected static boolean hasValidator(MetaField<?> field, Class<? extends MetaValidator> type) {
        return validator(field, type) != null;
    }

    /** Escape a regex/string literal for safe embedding in generated Java source. */
    protected static String escapeJavaString(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    // Whole files are written in execute(); the parent's print-writer pipeline is unused.
    @Override
    protected void writeSingleFile(MetaObject md, GeneratorIOWriter<?> writer) { /* unused */ }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getSingleWriter(
            MetaDataLoader loader, MetaObject md, PrintWriter pw) {
        return null;
    }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getFinalWriter(
            MetaDataLoader loader, OutputStream out) {
        return null;
    }

    @Override
    protected void writeFinalFile(Collection<MetaObject> metadata, GeneratorIOWriter<?> writer) { /* none */ }

    @Override
    protected String getSingleOutputFilePath(MetaObject md) {
        return SpringNaming.splitFqn(md.getName())[0].replace('.', '/');
    }

    @Override
    protected String getSingleOutputFilename(MetaObject md) {
        return SpringNaming.splitFqn(md.getName())[1] + "Dto.java";
    }
}
