package com.metaobjects.generator.spring;

// Eject note (ADR-0034, JVM eject design): `mvn metaobjects:eject` copies this class beside
// every generator that imports it and renames its package. These siblings stay in
// com.metaobjects.generator.spring, so an explicit import, not same-package bare-name
// resolution, is what keeps the copy compiling.
import com.metaobjects.generator.spring.AutoSetSupport;
import com.metaobjects.generator.spring.SpringM2mSupport;
import com.metaobjects.generator.spring.SpringNaming;
import com.metaobjects.generator.spring.SpringTypeMapper;

import com.metaobjects.MetaData;
import com.metaobjects.config.WireFormat;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.generator.util.RestSurfaceGate;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.object.MetaObject;
import com.metaobjects.origin.AggregateOrigin;
import com.metaobjects.origin.MetaOrigin;
import com.metaobjects.validator.ArrayValidator;
import com.metaobjects.validator.LengthValidator;
import com.metaobjects.validator.MetaValidator;
import com.metaobjects.validator.NumericValidator;
import com.metaobjects.validator.RegexValidator;
import com.metaobjects.validator.RequiredValidator;

import java.util.ArrayList;
import java.util.List;

/**
 * The static helpers the Spring generators share: which fields a DTO / patch carries, the
 * value-object column predicates, component types, validation annotations, and the M:N
 * finder naming the repository declares and the controller calls.
 *
 * <p>They live here, in one public class, rather than on {@link SpringDtoGenerator} and
 * {@link SpringRepositoryGenerator}, so that a generator copied out by
 * {@code mvn metaobjects:eject} reaches them through one explicit import and never through
 * a sibling generator. An owned {@code routes} must not call a packaged {@code dto}: a call
 * on a same-package sibling does not compile in the copy, and one that did would run the
 * packaged generator's logic instead of the adopter's own.</p>
 *
 * <p>These are emit rules, so eject hands them over too. This file ships as an eject support
 * source ({@code GeneratorRegistry.EJECT_SUPPORT}): ejecting a generator that imports it
 * writes one copy beside the owned generators, in their package, and points their import at
 * that copy. No packaged class an owned generator reaches refers to this packaged class:
 * {@link AutoSetSupport}, {@link SpringTypeMapper}, {@link SpringNaming}, {@link SpringM2mSupport}
 * and {@link TphPlan} do not call into it ({@code OwnedPathNeverReachesPackagedSupportTest}),
 * so an owned generator runs owned rules only.</p>
 */
public final class SpringGeneratorSupport {

    private SpringGeneratorSupport() {}

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
    public static List<MetaField> settableFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : minusPk(entity, dtoComponentFields(entity), null)) {
            if (AutoSetSupport.isAutoSet(field)) continue;
            // FR-037 R1: both non-readWrite @mutability modes leave the PATCH settable
            // set — `readOnly` is never written at all, `writeOnce` is frozen after
            // create. A value presented for one is STRIPPED (simply not in the settable
            // set), never 400'd — the uniform behaviour of every excluded key here.
            if (isNonReadWriteMutability(field)) continue;
            // #484: a @formExclude / credential field is not writable through the HTTP boundary.
            if (isApiWriteDenied(field)) continue;
            out.add(field);
        }
        return out;
    }

    /** The {@code @formExclude} attribute (boolean): the field is left out of generated forms. */
    public static final String ATTR_FORM_EXCLUDE = "formExclude";

    /**
     * #484 — a credential: the field declares (or inherits, ADR-0039) a child {@code view.password}.
     * A credential is never returned by a generated route and never written through one.
     */
    public static boolean isCredentialField(MetaField field) {
        for (Object child : field.getViews()) {
            com.metaobjects.view.MetaView view = (com.metaobjects.view.MetaView) child;
            if (com.metaobjects.view.PresentationView.SUBTYPE_PASSWORD.equals(view.getSubType())) return true;
        }
        return false;
    }

    /**
     * #484 — true when a generated create / PATCH / PUT route must IGNORE a value for this field
     * (strip it, never reject it, so a form that submits every field still saves): its effective
     * {@code @formExclude} is true, or it is a {@link #isCredentialField credential}. Resolving
     * (ADR-0039): an inherited mark counts.
     */
    public static boolean isApiWriteDenied(MetaField field) {
        if (field.hasMetaAttr(ATTR_FORM_EXCLUDE, true)
                && "true".equalsIgnoreCase(field.getMetaAttr(ATTR_FORM_EXCLUDE, true).getValueAsString())) {
            return true;
        }
        return isCredentialField(field);
    }

    /** #484 — the distinct wire names of the credential fields among {@code fields}, in declared order. */
    public static List<String> credentialNames(java.util.Collection<? extends MetaField> fields) {
        java.util.Set<String> out = new java.util.LinkedHashSet<>();
        for (MetaField f : fields) if (isCredentialField(f)) out.add(f.getName());
        return new ArrayList<>(out);
    }

    /** #484 — the distinct wire names of the write-denied fields among {@code fields}. */
    public static java.util.Set<String> writeDeniedNames(java.util.Collection<? extends MetaField> fields) {
        java.util.Set<String> out = new java.util.LinkedHashSet<>();
        for (MetaField f : fields) if (isApiWriteDenied(f)) out.add(f.getName());
        return out;
    }

    /**
     * #484 — the write-denied names of {@code entity}, widened to its whole TPH hierarchy (the base
     * and every subtype) when it is in one: a mark on any declaration of a shared column counts.
     */
    public static java.util.Set<String> hierarchyWriteDeniedNames(MetaObject entity) {
        List<MetaField> fields = new ArrayList<>(entity.getMetaFields());
        MetaObject root = TphPlan.discriminatorRoot(entity);
        if (root != null) {
            fields.addAll(root.getMetaFields());
            fields.addAll(TphPlan.everySubtypeField(root, root.getLoader()));
        }
        return writeDeniedNames(fields);
    }

    /** #484 — the credential wire names of {@code entity}'s DTO components. */
    public static List<String> credentialNames(MetaObject entity) {
        return credentialNames(dtoComponentFields(entity));
    }

    /**
     * FR-037 R1 — true when the field's EFFECTIVE {@code @mutability} is anything other
     * than {@code readWrite}, i.e. it is excluded from the PATCH settable set. Resolving
     * (ADR-0039), so a mode inherited through {@code extends} is honoured.
     *
     * <p>The two modes differ on CREATE, not here: {@code readOnly} is additionally
     * dropped from the create shape, while {@code writeOnce} stays settable there
     * exactly once. That split lives in the create-shape emitters.</p>
     */
    public static boolean isNonReadWriteMutability(MetaField field) {
        return !MetaField.MUTABILITY_READ_WRITE.equals(field.getMutability());
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
        java.util.Set<String> denied = hierarchyWriteDeniedNames(entity);
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
            // FR-037 R1: the same exclusion as the vanilla overload above — ADR-0045
            // says the OUTERMOST generated write artifact enforces the mode, and TPH is
            // a separate code path (the 0.19.4 lesson), so it is stated here too rather
            // than assumed to fall out of the vanilla walk.
            if (isNonReadWriteMutability(field)) continue;
            // #484: a @formExclude / credential column, marked on any declaration in the hierarchy.
            if (denied.contains(field.getName())) continue;
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
    public static final String STORAGE_JSONB = "jsonb";

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

    /**
     * The DTO component fields of {@code entity} carrying a STAMPABLE {@code @autoSet}
     * (onCreate OR onUpdate) marker, in declared order — the fields {@code stampForInsert}
     * overwrites with {@code now()}. Reuses {@link #dtoComponentFields} so the set matches
     * the DTO record's component order exactly.
     */
    public static List<MetaField> stampFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : dtoComponentFields(entity)) {
            if (AutoSetSupport.isAutoSet(field) && AutoSetSupport.nowExpr(field) != null) out.add(field);
        }
        return out;
    }

    /**
     * The DTO component fields of {@code entity} carrying {@code @autoSet: onUpdate}, in
     * declared order — the fields stamped on update / patch ({@code onCreate} is skipped).
     */
    public static List<MetaField> onUpdateFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : dtoComponentFields(entity)) {
            if (AutoSetSupport.isOnUpdate(field) && AutoSetSupport.nowExpr(field) != null) out.add(field);
        }
        return out;
    }

    /** True iff {@code entity} declares at least one stampable {@code @autoSet} field. */
    public static boolean hasAutoSetFields(MetaObject entity) {
        return !stampFields(entity).isEmpty();
    }

    /** True iff {@code entity} declares at least one {@code @autoSet: onUpdate} field. */
    public static boolean hasOnUpdateFields(MetaObject entity) {
        return !onUpdateFields(entity).isEmpty();
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

    /** The {@code field.map @objectRef} columns of {@code entity}, in declared order — the map
     *  analog of {@link #valueObjectJsonbFields}. The controller runs the same nested-VO
     *  validation over their VALUES on PATCH. */
    public static List<MetaField> valueObjectMapFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : entity.getMetaFields()) {
            if (SpringTypeMapper.mapValueObjectRefOf(field) != null) out.add(field);
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

    /**
     * The {@code object.value} that {@code field} carries by reference, else {@code null}.
     * TWO field shapes carry one, and both must be reached:
     * <ul>
     *   <li>a {@code field.object @objectRef} jsonb column ({@link #isValueObjectJsonbField});</li>
     *   <li>a {@code field.map @objectRef} -- a {@code Map<String, VO>}. A map's storage is
     *       ALWAYS the single jsonb column, so unlike {@code field.object} it has no
     *       {@code @storage} axis to gate on.</li>
     * </ul>
     * Mirrors the C# {@code EntityGenerator.ReferencesValueObject} predicate, which already
     * spans both. Drives {@link SpringValueObjectGenerator}'s reachability walk (a VO reached
     * only through a map would otherwise never be EMITTED, leaving the DTO naming a record
     * that does not exist) and the {@code @Valid} cascade on the DTO component.
     */
    public static MetaObject valueObjectRefOf(MetaField<?> field) {
        if (isValueObjectJsonbField(field)) return ((ObjectField) field).getObjectRef();
        return SpringTypeMapper.mapValueObjectRefOf(field);
    }

    /**
     * Java DTO-record component type for {@code field} owned by {@code owner}. A
     * {@code field.enum} is typed as the value-constrained nested Java {@code enum}
     * ({@link SpringTypeMapper#enumTypeName}, single or {@code List<Enum>}) whose declaration
     * {@code SpringDtoGenerator.collectEnumDecls} emits inside the record body — parity with the other ports and
     * with {@link SpringValueObjectGenerator}. Other scalars delegate to {@link SpringTypeMapper};
     * array fields ({@code isArray=true}) are wrapped as {@code List<elementType>} (the wrapped
     * element type so an omitted JSON element deserialises to {@code null}).
     */
    public static String componentType(MetaField<?> field, MetaObject owner) {
        if (field instanceof EnumField) {
            return SpringTypeMapper.payloadJavaTypeName(field, owner, "");
        }
        String element = SpringTypeMapper.javaTypeName(field);
        return SpringTypeMapper.wrapsAsList(field) ? "java.util.List<" + element + ">" : element;
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
    public static boolean isAssignedPrimaryKeyField(MetaField<?> field) {
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
    public static final String HOSTNAME_REGEX =
        "^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$";

    public static String sizeAnnotation(Integer min, Integer max) {
        StringBuilder b = new StringBuilder("@Size(");
        boolean wrote = false;
        if (min != null) { b.append("min = ").append(min); wrote = true; }
        if (max != null) { if (wrote) b.append(", "); b.append("max = ").append(max); }
        return b.append(')').toString();
    }

    public static boolean attrBool(MetaField<?> field, String attr) {
        if (!field.hasMetaAttr(attr)) return false;
        Object raw = field.getMetaAttr(attr).getValue();
        if (raw instanceof Boolean b) return b;
        return Boolean.parseBoolean(String.valueOf(raw));
    }

    /** Read an int-valued attr from a node, trying each name in order; {@code null} when absent. */
    public static Integer attrInt(MetaData node, String... attrNames) {
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

    public static boolean hasValidator(MetaField<?> field, Class<? extends MetaValidator> type) {
        return validator(field, type) != null;
    }

    /** Escape a regex/string literal for safe embedding in generated Java source. */
    public static String escapeJavaString(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /**
     * True iff this generator emits a repository interface for {@code entity} — the same
     * shared {@link RestSurfaceGate#emitsRestSurface} decision the controller and the
     * filter allowlist make, because the controller delegates to this interface by name.
     *
     * <p>A READ-ONLY view-kind {@code object.projection} (F22) emits a repository too, but
     * a read-only one: list / count / findById and nothing that writes. See
     * {@code SpringRepositoryGenerator.emitReadOnly}.</p>
     */
    public static boolean repositoryAppliesTo(MetaObject entity) {
        return RestSurfaceGate.emitsRestSurface(entity);
    }

    /** Repository finder name for an M:N relationship: {@code tags} → {@code findTags}. */
    public static String m2mFinderName(String relationName) {
        if (relationName.isEmpty()) return "find";
        return "find" + Character.toUpperCase(relationName.charAt(0)) + relationName.substring(1);
    }

    /**
     * FR-017 x FR-018: the subtype-scoped M:N finder name, e.g. {@code ("tags", "Bridge")} →
     * {@code findTagsForBridge}. Distinct from {@link #m2mFinderName} because a TPH interface
     * may need BOTH the whole-table finder (base-declared relationship) AND a per-subtype one
     * for the exact same relation name (an inherited relationship resolved by more than one
     * subtype) — same naming shape as the existing {@code list<Suffix>}/{@code get<Suffix>}
     * per-subtype CRUD methods.
     */
    public static String m2mFinderNameForSubtype(String relationName, String discriminatorValue) {
        return m2mFinderName(relationName) + "For" + SpringNaming.capitalize(discriminatorValue);
    }

    /**
     * FW-8 follow-up (target-side TPH gate): the extra finder parameter clause for {@code nav} —
     * {@code ", String targetSubtype"} when {@code nav}'s target is a concrete TPH subtype,
     * empty otherwise. Threading this same {@code targetDiscriminatorValue() != null} test at
     * every finder declaration AND its matching controller call site (see
     * {@link SpringControllerGenerator}) is what keeps a widened finder's interface signature
     * and call site in agreement — a real disagreement here is a javac compile error, not a
     * silently-wrong runtime result, because each (relation name, source scope) pair is its own
     * distinct Java method (never a single shared seam multiple mounts must agree on the arity
     * of, unlike the Python port's one Protocol method per relation name).
     */
    public static String targetSubtypeParam(SpringM2mSupport.M2mNav nav) {
        return nav.targetDiscriminatorValue() != null ? ", String targetSubtype" : "";
    }

    /**
     * The matching CALL-SITE argument clause for {@link #targetSubtypeParam} — the quoted
     * discriminator literal when {@code nav}'s target is TPH, empty otherwise. Used by
     * {@link SpringControllerGenerator} at every M:N call site (unscoped base finder AND every
     * subtype-scoped {@code find<Rel>For<Disc>} finder) so each call site's argument count
     * always matches its own finder's declared parameter count.
     */
    public static String targetSubtypeCallArg(SpringM2mSupport.M2mNav nav) {
        return nav.targetDiscriminatorValue() != null
            ? ", \"" + nav.targetDiscriminatorValue() + "\""
            : "";
    }

    /** The element type string of a decimal component (see {@link #decimalJsonAnnotations}). */
    private static final String DECIMAL_TYPE = "java.math.BigDecimal";
    private static final String DECIMAL_LIST_TYPE = "java.util.List<java.math.BigDecimal>";

    /** True iff a record component of Java type {@code type} carries the decimal wire binding. */
    public static boolean isDecimalComponent(String type) {
        return DECIMAL_TYPE.equals(type) || DECIMAL_LIST_TYPE.equals(type);
    }

    /**
     * ADR-0019 Amendment 1 (W1/W2): the Jackson annotations binding a decimal record component to
     * the canonical serializer and the strict deserializer shipped in {@code runtimePackage}.
     * A {@code List<BigDecimal>} binds its elements ({@code contentUsing}). Empty for any other
     * type. The annotations ride on the component itself, so a host's {@code ObjectMapper}
     * options cannot change the bytes.
     */
    public static String decimalJsonAnnotations(String type, String runtimePackage, WireFormat wire) {
        if (!isDecimalComponent(type)) return "";
        String key = DECIMAL_LIST_TYPE.equals(type) ? "contentUsing" : "using";
        // ADR-0019 Amendment 2: the OUTPUT half is emitted only when the project asks for the
        // canonical string; under native the host ObjectMapper writes a BigDecimal as a number.
        // The INPUT half (strict deserializer, W2/W3) rides in every mode.
        String out = wire.decimalsAsString()
            ? "@JsonSerialize(" + key + " = CanonicalDecimalSerializer.class) " : "";
        return out + "@JsonDeserialize(" + key + " = CanonicalDecimalDeserializer.class)";
    }

    /**
     * {@link #decimalJsonAnnotations(String, String, WireFormat)} plus, for a field that declares
     * {@code @precision}, the {@code @DeclaredDecimal} the strict deserializer reads to refuse a
     * value the column cannot hold (W3).
     */
    public static String decimalJsonAnnotations(String type, String runtimePackage, MetaField<?> field,
            WireFormat wire) {
        String json = decimalJsonAnnotations(type, runtimePackage, wire);
        if (json.isEmpty()) return json;
        int[] bound = declaredDecimalBound(field);
        return bound == null ? json
            : "@DeclaredDecimal(precision = " + bound[0] + ", scale = " + bound[1] + ") " + json;
    }

    /**
     * The {@code {precision, scale}} a decimal field declares, or {@code null} when it declares no
     * {@code @precision}. An absent {@code @scale} beside a {@code @precision} is scale 0, as in SQL.
     */
    public static int[] declaredDecimalBound(MetaField<?> field) {
        // ADR-0039: effective properties - the resolving one-arg reads.
        if (field == null || !field.hasMetaAttr(MetaField.ATTR_PRECISION)) return null;
        int precision = Integer.parseInt(field.getMetaAttr(MetaField.ATTR_PRECISION).getValueAsString());
        int scale = field.hasMetaAttr(MetaField.ATTR_SCALE)
            ? Integer.parseInt(field.getMetaAttr(MetaField.ATTR_SCALE).getValueAsString()) : 0;
        return new int[] { precision, scale };
    }

    /**
     * The imports {@link #decimalJsonAnnotations} needs: the two Jackson annotations and the two
     * runtime classes they name (imported, so the ejected runtime package is what the output
     * names).
     */
    public static String decimalAnnotationImports(String runtimePackage, WireFormat wire) {
        String out = wire.decimalsAsString()
            ? "import com.fasterxml.jackson.databind.annotation.JsonSerialize;\n"
              + "import " + runtimePackage + ".CanonicalDecimalSerializer;\n" : "";
        return "import com.fasterxml.jackson.databind.annotation.JsonDeserialize;\n"
            + out
            + "import " + runtimePackage + ".CanonicalDecimalDeserializer;\n"
            + "import " + runtimePackage + ".DeclaredDecimal;\n";
    }
}
