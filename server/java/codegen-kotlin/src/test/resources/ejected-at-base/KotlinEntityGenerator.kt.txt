package com.metaobjects.generator.kotlin

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.kotlin when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.config.WireFormat
import com.metaobjects.generator.util.GeneratorUtil
import com.metaobjects.generator.kotlin.Fr019SharedEnum
import com.metaobjects.generator.kotlin.KotlinCrossFieldRules
import com.metaobjects.generator.kotlin.KotlinEnumEmitter
import com.metaobjects.generator.kotlin.KotlinGenUtil
import com.metaobjects.generator.kotlin.KotlinNaming
import com.metaobjects.generator.kotlin.KotlinTphPlan
import com.metaobjects.generator.kotlin.KotlinTypeMapper
import com.metaobjects.generator.kotlin.PackageMapping
import com.metaobjects.generator.kotlin.writer.KotlinClassName
import com.metaobjects.generator.kotlin.writer.KotlinTypeName
import com.metaobjects.generator.kotlin.writer.KotlinTypes
import com.metaobjects.generator.kotlin.writer.KotlinWriter

import com.metaobjects.MetaData
import com.metaobjects.field.DecimalField
import com.metaobjects.field.EnumField
import com.metaobjects.field.InetField
import com.metaobjects.field.DurationField
import com.metaobjects.field.MetaField
import com.metaobjects.field.MapField
import com.metaobjects.field.ObjectField
import com.metaobjects.field.StringField
import com.metaobjects.field.UriField
import com.metaobjects.generator.GeneratorIOWriter
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import com.metaobjects.validator.ArrayValidator
import com.metaobjects.validator.LengthValidator
import com.metaobjects.validator.MetaValidator
import com.metaobjects.validator.NumericValidator
import com.metaobjects.validator.RegexValidator
import com.metaobjects.validator.RequiredValidator
import java.io.OutputStream
import java.io.PrintWriter
import java.nio.file.Path
import java.nio.file.Paths
import com.metaobjects.generator.util.GeneratedFileWriter
import com.metaobjects.generator.util.RestSurfaceGate
import com.metaobjects.reporting.ReportReadModel

/**
 * Generator: one plain Kotlin data class (Jackson-compatible) per `object.entity` and
 * `object.value`. No kotlinx `@Serializable` — see [emit] for why.
 *
 * <p>Skips abstract objects and any subType other than `entity` or `value`. Each file is laid
 * out by [KotlinWriter] (ADR-0063); the parent class's print-style writer machinery is bypassed
 * in favour of a direct override of [execute].
 *
 * <p>Nested objects: when a parent field is a `field.object` with `@objectRef`, the parent
 * data class gets a typed property referencing the generated `object.value` data class
 * (e.g., `val address: Address`). The `@storage` attr (`flattened` / `jsonb`) does not
 * affect Kotlin type emission — it only affects the Exposed table's column shape.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root; package directories are
 *       created under it.</li>
 * </ul>
 */
open class KotlinEntityGenerator : MultiFileDirectGeneratorBase<MetaObject>() {

    override fun getFilterClass(): Class<MetaObject> = MetaObject::class.java

    /**
     * FR-019 per-port config for resolving `@provided` enum namespaces, parsed from the
     * `providedEnumNamespace` (single fallback) + `providedEnumPackages` (package→namespace map)
     * generator args. Empty by default; a referenced provided enum with no resolvable namespace is
     * a codegen-time error.
     */
    private var fr019Config = Fr019SharedEnum.ProvidedEnumConfig(null, emptyMap())

    /** Real work happens here — sidesteps the parent's print-style writer machinery. */
    override fun execute(loader: MetaDataLoader) {
        parseArgs()
        val outRoot = Paths.get(outDir.absolutePath)
        decimalWirePackages.clear()
        durationWirePackages.clear()
        // ADR-0019 Amendment 2: the project's wire setting, read from the loaded root.
        wire = WireFormat.of(loader.root)
        requestBodies = RestSurfaceGate.requestBodyShapes(loader)
        fr019Config = Fr019SharedEnum.ProvidedEnumConfig.fromArgs(args)
        // emitAbstractShapes (default OFF): when ON, an abstract entity is emitted as a Kotlin
        // `interface` shape (read-only properties) instead of being suppressed. It is NEVER
        // emitted as an instantiable data class — abstracts are scaffolding.
        val emitAbstractShapes = (getArg("emitAbstractShapes", "false") ?: "false").toBoolean()
        // Run-level dedupe of emitted enum-class files by enum FQN: two fields sharing an
        // abstract enum super (resolved by KotlinTypeMapper.enumTypeName) collapse onto one file.
        val emittedEnumFqns = mutableSetOf<String>()
        // Emit a data class for entities AND value objects. Value objects (object.value) are
        // referenced by field.object on entities; the value class must exist for the entity's
        // typed property to resolve.
        // Local-only abstract check (own attribute, not inherited) so concrete subtypes
        // extending an abstract base still emit normally.
        for (declared in loader.metaObjects) {
            if (!isSelected(declared)) continue
            // FR-044: a served report is emitted from its read model (one field per derived
            // column); any other report maps to null and emits nothing.
            val obj = RestSurfaceGate.restShapeOf(declared) ?: continue
            if (!emitsDataClass(obj)) continue
            if (KotlinGenUtil.isAbstractEntity(obj)) {
                if (emitAbstractShapes) emitAbstractShape(obj, outRoot, loader, emittedEnumFqns)
                continue
            }
            // FR-017 TPH: a discriminator subtype folds into its base's union data class +
            // discriminator enum. A per-subtype data class is dead and re-emits the inherited
            // enum under a spurious name. Mirror the controller/table skip — but FR-036 still
            // emits the subtype's annotated <Sub>Validation shape (the base controller's per-subtype
            // POST/PATCH validates present values against it; the union base is annotation-free).
            if (KotlinTphPlan.isTphSubtype(obj)) {
                emitTphSubtypeValidation(obj, outRoot, loader)
                continue
            }
            emit(obj, outRoot, loader, emittedEnumFqns)
        }
        // #234: emit the strict field.uri / field.inet Jackson deserializers ONCE per package that
        // has such a field (a same-package MetaNetJson the data-class properties bind through).
        emitNetJsonSupport(loader, outRoot)
        // ADR-0019 Amendment 1: the decimal wire rule, once per package that wrote a decimal property.
        for (pkg in decimalWirePackages) KotlinDecimalWireEmitter.write(pkg, outRoot, wire)
        // field.duration: the canonical ISO-8601 wire rule, once per package that wrote a duration property.
        for (pkg in durationWirePackages) KotlinDurationWireEmitter.write(pkg, outRoot)
    }

    /** Packages whose emitted data classes carry a duration property: each gets one `MetaDurationWire.kt`. */
    private val durationWirePackages = linkedSetOf<String>()

    /** Packages whose emitted data classes carry a decimal property: each gets one `MetaDecimalWire.kt`. */
    private val decimalWirePackages = linkedSetOf<String>()

    /** ADR-0019 Amendment 2: the project's wire setting (native unless `.metaobjects/config.json` says otherwise). */
    private var wire: WireFormat = WireFormat.DEFAULT

    /** Names of the classes bound from a write route's request body, for the current run. */
    private var requestBodies: Set<String> = emptySet()

    /**
     * #234: emit the per-package `MetaNetJson.kt` support object (the strict field.uri / field.inet
     * Jackson deserializers a data-class property binds through via `@field:JsonDeserialize`), ONCE
     * for each package with such a field. Dependency-free (java.net + Jackson), so the generated code
     * still runs without any MetaObjects runtime.
     */
    private fun emitNetJsonSupport(loader: MetaDataLoader, outRoot: Path) {
        val packages = linkedSetOf<String>()
        for (obj in GeneratorUtil.ownMetaObjects(loader)) {
            // A report's row carries no deserializer (it is never bound from a request), so
            // a report is not counted here.
            if (obj.subType !in EMITTED_SUBTYPES) continue
            if (KotlinGenUtil.isAbstractEntity(obj)) continue
            if (KotlinTphPlan.isTphSubtype(obj)) continue
            if (obj.metaFields.any { isStrictNetField(it) }) {
                packages.add(PackageMapping.splitFqn(obj.name).first)
            }
        }
        for (pkg in packages) writeNetJsonSupportFile(pkg, outRoot)
    }

    /** Write `MetaNetJson.kt` into `pkg` — two `JsonDeserializer`s implementing the #234 Contract-A
     *  strict URI / IP-literal rules (verified against the shared validation-conformance corpus). The
     *  class body is fixed; only the package header varies. */
    private fun writeNetJsonSupportFile(pkg: String, outRoot: Path) {
        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$NET_JSON_SUPPORT.kt")
        GeneratedFileWriter.write(outFile, netJsonSupportSource(pkg))
    }

    /** The whole `MetaNetJson.kt` for [pkg]: its package line, the imports and the fixed body. */
    protected open fun netJsonSupportSource(pkg: String): String {
        val w = KotlinWriter().packageName(pkg)
        w.use("com.fasterxml.jackson.core.JsonParser")
        w.use("com.fasterxml.jackson.databind.DeserializationContext")
        w.use("com.fasterxml.jackson.databind.JsonDeserializer")
        w.use("java.net.InetAddress")
        w.use("java.net.URI")
        w.use("java.net.URISyntaxException")
        // Uses `+`-concatenated messages (no Kotlin string templates) so the snippet needs no `$`
        // escaping.
        w.text(
            """
            /** GENERATED (#234) — strict Jackson deserializers for field.uri / field.inet.
             *  Do not hand-edit; regenerated from metadata. Dependency-free (java.net + Jackson). */
            internal object MetaNetJson {
                /** field.uri — an ABSOLUTE URI carrying a scheme (leading/trailing whitespace trimmed,
                 *  WHATWG). A relative reference (example.com, /path) or malformed value is rejected. */
                class AbsoluteUriDeserializer : JsonDeserializer<URI>() {
                    override fun deserialize(p: JsonParser, ctxt: DeserializationContext): URI? {
                        val raw = p.valueAsString ?: return null
                        val uri = try {
                            URI(raw.trim())
                        } catch (e: URISyntaxException) {
                            throw IllegalArgumentException("field.uri: not a valid URI: " + raw, e)
                        }
                        require(uri.isAbsolute) { "field.uri: must be an absolute URI carrying a scheme: " + raw }
                        return uri
                    }
                }

                /** field.inet — an IPv4 or IPv6 LITERAL only. Never a DNS lookup: a value containing
                 *  ':' can only be an IPv6 literal (getByName parses it offline), otherwise a strict
                 *  dotted-quad IPv4. Hostnames, CIDR, padding, out-of-range octets are rejected. */
                class InetLiteralDeserializer : JsonDeserializer<InetAddress>() {
                    override fun deserialize(p: JsonParser, ctxt: DeserializationContext): InetAddress? {
                        val raw = p.valueAsString ?: return null
                        // No trim: IP-literal grammar has no whitespace, so padding is rejected.
                        if (raw.indexOf(':') >= 0) {
                            return try {
                                InetAddress.getByName(raw) // ':' => IPv6 literal — getByName does no DNS
                            } catch (e: Exception) {
                                throw IllegalArgumentException("field.inet: not a valid IPv6 literal: " + raw, e)
                            }
                        }
                        return parseIpv4(raw)
                    }

                    private fun parseIpv4(s: String): InetAddress {
                        val parts = s.split(".")
                        require(parts.size == 4) { "field.inet: not a valid IPv4 literal: " + s }
                        val octets = ByteArray(4)
                        for (i in 0 until 4) {
                            val part = parts[i]
                            // #234 review H1: reject a leading-zero octet (010 / 01) — the octal/decimal
                            // -parse ambiguity — matching Python ipaddress + the TS regex.
                            require(part.isNotEmpty() && part.length <= 3 && part.all { it.isDigit() }
                                && !(part.length > 1 && part[0] == '0')) {
                                "field.inet: not a valid IPv4 literal: " + s
                            }
                            val v = part.toInt()
                            require(v <= 255) { "field.inet: IPv4 octet out of range: " + s }
                            octets[i] = v.toByte()
                        }
                        return InetAddress.getByAddress(octets)
                    }
                }
            }
            """
        )
        return w.toString()
    }

    protected open fun emit(obj: MetaObject, outRoot: Path, loader: MetaDataLoader, emittedEnumFqns: MutableSet<String>) {
        // FR-044: a report's row gets no enum of its own. A derived enum field is typed by
        // the class already emitted for the entity it reads from, the same class the
        // report's Exposed table types the column by, so the generated row mapper compiles.
        // Empty for every other object.
        reportEnumClasses = KotlinGenUtil.reportEnumClasses(obj, loader, fr019Config)
        try {
            emitDataClass(obj, outRoot, loader, emittedEnumFqns)
        } finally {
            reportEnumClasses = emptyMap()
        }
    }

    /**
     * The enum classes of the report row being emitted, by derived field name, for the
     * duration of one [emit] call; empty outside it and for any object that is not a report.
     * It reaches [resolveElementType] this way, not as a parameter, because that function is
     * `protected open` and an adopter's subclass may override it.
     */
    private var reportEnumClasses: Map<String, KotlinClassName> = emptyMap()

    /**
     * One annotation on a generated declaration: its class, the use-site target it is written
     * with (`field`, `get`, `param`, or none) and its arguments as Kotlin text. An argument that
     * names a type names one in the file's own package or the annotation's own class, so it
     * needs no import of its own.
     */
    protected class AnnotationUse(
        val type: KotlinClassName,
        val siteTarget: String? = null,
        val arguments: List<String> = emptyList(),
    ) {
        /** `@site:Type(arg, arg)`, the type imported through [w]. */
        fun write(w: KotlinWriter): String {
            val site = if (siteTarget == null) "" else "$siteTarget:"
            val args = if (arguments.isEmpty()) "" else arguments.joinToString(", ", "(", ")")
            return "@" + site + type.write(w) + args
        }
    }

    /**
     * One constructor property of a generated class: its name, type, default (Kotlin text, or
     * null for none) and the annotations written above it.
     */
    protected class PropertyParam(
        val name: String,
        val type: KotlinTypeName,
        val default: String?,
        val annotations: List<AnnotationUse>,
    )

    /**
     * One `@get:AssertTrue` cross-field property of an entity data class: the property's name,
     * the validator it checks and its Kotlin boolean expression.
     */
    protected class CrossFieldProperty(val name: String, val validator: MetaValidator, val expression: String)

    /**
     * Whether [obj] gets a data class: an entity, value object or projection, and the read
     * model of a served report (FR-044), whose row a query returns. A declared report node
     * never reaches here: [execute] maps it to its read model or drops it.
     */
    private fun emitsDataClass(obj: MetaObject): Boolean =
        obj.subType in EMITTED_SUBTYPES || obj is ReportReadModel

    private fun emitDataClass(obj: MetaObject, outRoot: Path, loader: MetaDataLoader, emittedEnumFqns: MutableSet<String>) {
        val reportRow = obj is ReportReadModel
        // Emit one Kotlin enum class file per `field.enum` child BEFORE the data class
        // so the resolved property type (a class name) points at a real file. Deduped per run.
        for (field in obj.metaFields) {
            // A report's enum field references an entity's class; nothing is materialized.
            if (reportRow) break
            if (field is EnumField) KotlinEnumEmitter.emitEnumFile(obj, field, outRoot, emittedEnumFqns, fr019Config)
        }
        // FR-017 TPH: the base union folds in subtype-only fields (below). A folded field.enum
        // resolves to a typed enum class, so its enum file must be emitted here (owner = base,
        // matching the fold's type resolution) — the declaring subtype is skipped in execute(), so
        // no other pass emits it. No-op for a non-TPH entity (collectSubtypeFields is empty).
        for (field in KotlinTphPlan.collectSubtypeFields(obj, loader)) {
            if (field is EnumField) KotlinEnumEmitter.emitEnumFile(obj, field, outRoot, emittedEnumFqns, fr019Config)
        }

        val (pkg, shortName) = PackageMapping.splitFqn(obj.name)

        // NO kotlinx @Serializable: entity/value/projection data classes are plain
        // (Jackson-compatible) data classes. The annotation was decorative — no build enables
        // the kotlinx-serialization compiler plugin for these, and the moment one did, every
        // class carrying a java.util.UUID / java.time.* / java.math.BigDecimal / java.net.* field
        // would fail to compile (kotlinx has no built-in serializer for those). Jackson (the codec
        // every consumer actually uses) round-trips them with zero per-type plumbing — including the
        // response parser, which decodes a model's reply straight into these classes (ADR-0056).
        // Only KotlinEnumEmitter's enums keep @Serializable, where it is harmless.
        val classAnnotations = mutableListOf<AnnotationUse>()
        // A request body DROPS an undeclared key, never rejects it, whatever
        // FAIL_ON_UNKNOWN_PROPERTIES the host's ObjectMapper carries. Only a write route's
        // entity and the value objects nested in it are one; a stored-proc argument class, a
        // response parser's decode target (ADR-0056), a prompt payload or a projection keeps
        // the host mapper's strictness.
        if (obj.name in requestBodies) {
            classAnnotations += AnnotationUse(JSON_IGNORE_PROPERTIES, null, listOf("ignoreUnknown = true"))
        }
        // `wire.nullMembers: omit` (ADR-0019 Amendment 2): a value object's null members are left
        // out. Under native/emit Jackson writes them as null with the key present.
        if (obj.subType == MetaObject.SUBTYPE_VALUE && wire.omitNullMembers()) {
            classAnnotations += AnnotationUse(JSON_INCLUDE, null, listOf("JsonInclude.Include.NON_NULL"))
        }

        // FR-017 TPH: a discriminator base's data class is the UNION of subtype columns and serves
        // as the partial-PATCH-friendly wire body — every property is nullable + defaulted + carries
        // NO validation (a per-subtype POST/PATCH supplies only its own columns; the DB column
        // nullability is the real constraint). Non-TPH entities keep their per-field required rules.
        val tphBase = KotlinTphPlan.isTphBase(obj, loader)
        // #214 FR-024 §7: on a WRITE-THROUGH entity the single read data class is ALSO the create
        // @RequestBody, so a DERIVED (origin.*) field — view-computed, never client-supplied — must
        // be a NULLABLE, default-null ctor param (else a guaranteed-non-null aggregate / @required
        // derived field is a non-null param with no default and a create body omitting the
        // view-computed value fails jackson-module-kotlin deserialization → HTTP 400). Its validation
        // annotations are suppressed too (no @field:NotNull to reject the omitted value). Mirrors the
        // Java port dropping @NotNull for derived-on-write-through. A projection is read-only
        // (not an entity), so its derived fields keep their origin-aware non-null read type. An
        // entity with no read view never reads a derived field back at all, so it defaults too:
        // its primary source is always writable (the loader refuses a read-only primary).
        val entityHost = obj.subType == MetaObject.SUBTYPE_ENTITY

        val params = mutableListOf<PropertyParam>()
        for (field in obj.metaFields) {
            val baseType = resolvePropertyType(field, obj, loader)
            val derivedReadOnly = entityHost && KotlinGenUtil.isDerivedField(field)
            // #195: a field derived by origin.aggregate @agg:any|all|collect is COALESCE-guaranteed
            // non-null in the synthesized read-model view (any→false, all→true, collect→[]), so its
            // read type is non-null even when the field is NOT @required — matching the Exposed view
            // column ([KotlinExposedTableGenerator]) so the read/write types stay consistent (the
            // PR-#80 nullable-column-vs-non-null-read-type invariant). origin.first / origin.computed
            // keep the conservative nullable default. #214 overrides this to nullable on a
            // write-through entity (the create-body relaxation above; the view column stays non-null,
            // which maps safely into a nullable property).
            // An ASSIGNED primary key is create-REQUIRED whatever @required says — the
            // caller is its only source (KotlinGenUtil.isAssignedPrimaryKeyField), so the
            // property stays non-null and a create body omitting it cannot bind.
            // A SERVER-OWNED-on-create field — the key an increment/uuid identity generates, or an
            // @autoSet column the CRUD path stamps — is never the caller's to send, and this one data
            // class is also the create @RequestBody. As a non-null param with no default it fails
            // jackson-module-kotlin deserialization on a body that correctly omits it, so EVERY
            // create answered 400 on an entity whose BaseEntity declares `id` @required — the shape
            // real models have. (A missing `Long` silently binds 0, which is how an increment key
            // hid it; a `UUID` cannot.) Same relaxation as a derived field on a write-through
            // entity: nullable, default null, no @field:NotNull. Rows read back always carry it.
            val serverOwned = KotlinGenUtil.isServerOwnedOnCreate(field, obj)
            val nullable = tphBase || derivedReadOnly || serverOwned || KotlinGenUtil.isNullableShapeProperty(field)
            val propType = if (nullable) baseType.copy(nullable = true) else baseType
            // A literal @default is the ctor default, as C#'s initializer and Python's model default
            // are: a create body that omits the field binds @default (a required one would otherwise
            // fail to bind, a nullable one would be written as an explicit NULL the column default
            // never sees). Not for the shapes whose ctor default is null on purpose (TPH union,
            // derived, server-owned).
            val literalDefault = if (tphBase || derivedReadOnly || serverOwned) null else literalDefault(field, baseType)
            val default = literalDefault ?: if (nullable) "null" else null
            val annotations = mutableListOf<AnnotationUse>()
            // FR-044: a report's row carries no constraint either. Nothing binds or validates
            // it (it is read from the view, never sent), and a `@Size(min = 1)` on a required
            // dimension would claim a rule the view does not have: an empty string is a group.
            if (!tphBase && !derivedReadOnly && !serverOwned && !reportRow) {
                annotations += validationAnnotations(field)
                // #234: a STRICT field.uri / field.inet property binds through the codegen-owned
                // literal deserializer (absolute-scheme URI / IPv4-or-IPv6 literal, no DNS), so a
                // malformed value is rejected at the wire tier — aligning with TS/Python strict.
                netDeserializeAnnotation(field, pkg)?.let { annotations += it }
                // Program D (spec §0): a field.object (value-object) member carries @field:Valid so a
                // parent validator.validate(bean) / @Valid cascades into the nested VO's own
                // constraints (the create-body POST path). jakarta validateValue does NOT cascade, so
                // the PATCH path validates present VO values explicitly in the controller. A dict-of-VO
                // MapField cascades the same way: @Valid on a Map validates each VALUE.
                if (field is ObjectField || (field is MapField && readObjectRef(field) != null)) {
                    annotations += constraint(VALID)
                }
            }
            annotations += decimalWireAnnotations(field, pkg, declaredRange = obj.subType == MetaObject.SUBTYPE_VALUE)
            annotations += durationWireAnnotations(field, pkg)
            params += PropertyParam(field.name, propType, default, annotations)
        }

        // FR-017 TPH: a discriminator base's data class carries the UNION of subtype columns (each
        // NULLABLE, no validation) so one wire shape backs the polymorphic + per-subtype endpoints.
        // collectSubtypeFields is empty for a non-TPH entity (the loop is then a no-op).
        for (field in KotlinTphPlan.collectSubtypeFields(obj, loader)) {
            val propType = resolvePropertyType(field, obj, loader).copy(nullable = true)
            params += PropertyParam(field.name, propType, "null", decimalWireAnnotations(field, pkg) + durationWireAnnotations(field, pkg))
        }

        // Entity-scoped cross-field validators: class-level Bean Validation on the full create body.
        // Not on the TPH union / a report row / a value object, and never on a PATCH body.
        val crossField = if (!tphBase && !reportRow && obj.subType == MetaObject.SUBTYPE_ENTITY) crossFieldProperties(obj) else emptyList()

        val w = KotlinWriter().packageName(pkg)
        val self = reserveOwnName(w, pkg, shortName)
        w.doc(GENERATED_DOC)
        for (annotation in classAnnotations) w.line(annotation.write(w))
        val builder = javaBuilderApplies(obj, params)
        writeConstructor(w, "data class $self(", params, hasBody = crossField.isNotEmpty() || builder)
        if (crossField.isNotEmpty() || builder) {
            var first = true
            for (property in crossField) {
                if (!first) w.blank()
                first = false
                writeCrossFieldProperty(w, property)
            }
            if (builder) {
                if (!first) w.blank()
                writeJavaBuilder(w, self, params)
            }
            w.close("}")
        }

        // Guarded: `<Entity>.kt` is the file an adopter is most likely to want to own. The KDoc
        // above carries the GENERATED marker, so our own output is still overwritten freely.
        GeneratedFileWriter.write(outputFile(outRoot, pkg, shortName), w.toString())
    }

    /**
     * Claim [shortName], the class this file declares, so that an imported class with the same
     * simple name is written fully qualified rather than shadowing it. Returns the name to write.
     */
    private fun reserveOwnName(w: KotlinWriter, pkg: String, shortName: String): String =
        w.use(if (pkg.isEmpty()) shortName else "$pkg.$shortName")

    /** `<outRoot>/<package path>/<name>.kt`. */
    private fun outputFile(outRoot: Path, pkg: String, name: String): Path =
        (if (pkg.isEmpty()) outRoot else outRoot.resolve(pkg.replace('.', '/'))).resolve("$name.kt")

    /**
     * Write `[head]` and the primary constructor's properties, one per line with their
     * annotations above them. With [hasBody] the constructor ends `) {` and the caller writes the
     * body and closes it; otherwise it ends `)`.
     */
    private fun writeConstructor(w: KotlinWriter, head: String, params: List<PropertyParam>, hasBody: Boolean) {
        if (params.isEmpty()) {
            if (hasBody) w.open(head, ") {") else w.line(head, ")")
            return
        }
        w.open(head)
        for (p in params) {
            for (annotation in p.annotations) w.line(annotation.write(w))
            w.line("val ", KotlinWriter.escapeName(p.name), ": ", p.type.write(w), if (p.default == null) "" else " = " + p.default, ",")
        }
        if (hasBody) w.reopen(") {") else w.close(")")
    }

    /** One `@get:AssertTrue` property: true when the cross-field rule holds. */
    private fun writeCrossFieldProperty(w: KotlinWriter, property: CrossFieldProperty) {
        val name = property.validator.name
        w.doc("Cross-field validator ${name.replace("*/", "* /")} (class-level Bean Validation; the DB CHECK enforces the PATCH path).")
        w.line("@get:", w.use(JSON_IGNORE))
        w.line("@get:", w.use(ASSERT_TRUE), "(message = ", KotlinWriter.str("validator $name violated"), ")")
        w.line("@Suppress(", KotlinWriter.str("UNCHECKED_CAST"), ")")
        w.line("val ", property.name, ": Boolean")
        w.indented { w.line("get() = (", property.expression, ")") }
    }

    /**
     * FR-036 — emit the annotated per-subtype validation class {@code <Sub>Validation} for a concrete
     * TPH subtype. A discriminator base's union data class is annotation-free (a row of any other
     * subtype stores NULL in a subtype column, so the union carries no {@code @required}/
     * {@code @maxLength}), so the base controller's per-subtype POST/PATCH cannot enforce field
     * constraints against it. This lightweight, validation-ONLY data class (never persisted, never
     * the request body — the union stays the bound + persisted type) carries the subtype's settable
     * scalar fields ([KotlinTphPlan.subtypeSettableFields] — the SSOT the controller validates
     * against), each with the SAME {@code @field:} jakarta annotations [validationAnnotations]
     * produces for a non-TPH entity. Mirrors the Java port's standalone {@code <Sub>Dto}.
     *
     * <p>Skipped when the subtype has no settable scalar (nothing to validate; a Kotlin data class
     * needs at least one property) — the controller likewise emits no validation call there.
     *
     * <p>Property types resolve with the BASE as owner so a folded {@code field.enum} references the
     * base-emitted enum class (matching the union column + the value the controller binds). All
     * properties are nullable + defaulted: the shape is validated, never constructed, and a
     * {@code @NotNull} still fires on a null value (the create absent-{@code @required} check).
     */
    protected open fun emitTphSubtypeValidation(subtype: MetaObject, outRoot: Path, loader: MetaDataLoader) {
        val fields = KotlinTphPlan.subtypeSettableFields(subtype)
        if (fields.isEmpty()) return
        val base = KotlinTphPlan.discriminatorBaseOf(subtype) ?: return
        val (pkg, shortName) = PackageMapping.splitFqn(subtype.name)
        val className = KotlinNaming.tphSubtypeValidationName(shortName)

        val params = fields.map { field ->
            PropertyParam(field.name, resolvePropertyType(field, base, loader).copy(nullable = true), "null", validationAnnotations(field))
        }

        val w = KotlinWriter().packageName(pkg)
        val self = reserveOwnName(w, pkg, className)
        w.doc(
            GENERATED_DOC,
            "FR-036 validation-only shape for the $shortName TPH subtype: the base controller's",
            "per-subtype POST/PATCH validates present values against these field constraints",
            "(the folded union base data class is annotation-free). Never persisted or bound.",
        )
        writeConstructor(w, "data class $self(", params, hasBody = false)
        GeneratedFileWriter.write(outputFile(outRoot, pkg, className), w.toString())
    }

    /**
     * Emit an abstract entity as a Kotlin `interface` shape: one read-only `val` property per
     * field, reusing the same property-type resolution + required/nullable rules as [emit].
     * No `@Serializable` and no constructor — an interface is not instantiable, mirroring the
     * "abstract = scaffolding, never a write artifact" invariant while still giving concrete
     * subtypes a shared shape to implement. Enum-field files are still emitted so property
     * types resolve. Written to the same package path/file (`<Name>.kt`) as [emit] would use.
     */
    protected open fun emitAbstractShape(obj: MetaObject, outRoot: Path, loader: MetaDataLoader, emittedEnumFqns: MutableSet<String>) {
        for (field in obj.metaFields) {
            if (field is EnumField) KotlinEnumEmitter.emitEnumFile(obj, field, outRoot, emittedEnumFqns, fr019Config)
        }

        val (pkg, shortName) = PackageMapping.splitFqn(obj.name)
        val w = KotlinWriter().packageName(pkg)
        val self = reserveOwnName(w, pkg, shortName)
        w.doc(GENERATED_DOC)
        val fields = obj.metaFields
        if (fields.isEmpty()) {
            w.line("interface ", self)
        } else {
            w.block("interface $self {") {
                for (field in fields) {
                    val baseType = resolvePropertyType(field, obj, loader)
                    val nullable = !KotlinGenUtil.isRequiredField(field)
                    val propType = if (nullable) baseType.copy(nullable = true) else baseType
                    w.line("val ", KotlinWriter.escapeName(field.name), ": ", propType.write(w))
                }
            }
        }
        GeneratedFileWriter.write(outputFile(outRoot, pkg, shortName), w.toString())
    }

    /**
     * Resolve the Kotlin type for a single property. For `field.object` fields,
     * the type is a reference to the generated data class of the field's `@objectRef`
     * (e.g., `Address` for `field.object @objectRef="Address"`). For `field.enum`
     * fields, the type is the typed enum class generated alongside the entity
     * (e.g., `PlayerStatus` for `Player.status`). The `@storage` attr is intentionally
     * NOT consulted here — flattened vs jsonb only affects the persistence column shape,
     * not the in-memory shape.
     */
    /**
     * The Kotlin literal of a field's `@default` for its ctor default, or null when it has none
     * this can spell: an enum member (`Type.MEMBER`, a member of the effective `@values`), a
     * Boolean, a String, or an Int / Long / Double number. A SQL-expression default (`now()`,
     * anything function-like) is the database's to fill and gets none, as does an array.
     */
    protected open fun literalDefault(field: MetaField<*>, type: KotlinTypeName): String? {
        // ADR-0039: resolving — @default may be inherited via extends.
        if (!field.hasMetaAttr(MetaField.ATTR_DEFAULT) || field.isArrayType) return null
        val raw = field.getMetaAttr(MetaField.ATTR_DEFAULT).value ?: return null
        val text = raw.toString()
        if (field is com.metaobjects.field.EnumField) {
            // The members the enum class declares: its shared declaration's @values (FR-019), else its own.
            val declaration = com.metaobjects.field.EnumField.resolveSharedEnumDeclaration(field) as? com.metaobjects.field.EnumField ?: field
            val members = (runCatching { declaration.getMetaAttr(com.metaobjects.field.EnumField.ATTR_VALUES).value }.getOrNull() as? List<*>)
                ?.mapNotNull { it?.toString() } ?: return null
            return if (text in members) "${(type as? KotlinClassName)?.canonicalName ?: type}.$text" else null
        }
        return when ((type as? KotlinClassName)?.canonicalName) {
            "kotlin.Boolean" -> text.lowercase().takeIf { it == "true" || it == "false" }
            // A database expression (now(), gen_random_uuid()) is the database's to fill.
            "kotlin.String" -> if (com.metaobjects.generator.util.GeneratorUtil.isSqlExpressionDefault(text)) null
                else "\"" + KotlinGenUtil.kotlinStringLiteral(text) + "\""
            "kotlin.Int" -> text.toIntOrNull()?.toString()
            "kotlin.Long" -> text.toLongOrNull()?.let { "${it}L" }
            "kotlin.Double" -> text.toDoubleOrNull()?.toString()
            else -> null
        }
    }

    protected open fun resolvePropertyType(field: MetaField<*>, owner: MetaObject, loader: MetaDataLoader): KotlinTypeName {
        val element = resolveElementType(field, owner, loader)
        // @isArray fields are a List of the element type (List<T>). isArrayType()
        // covers both the `isArray: true` shorthand and a child @isArray attr.
        // Nullable handling is applied by the caller to the List itself (List<T>?),
        // not the elements — an array of non-null items.
        return if (field.isArrayType) KotlinTypes.LIST.parameterizedBy(element) else element
    }

    /** The Kotlin type for a single (non-array) element of [field]. */
    protected open fun resolveElementType(field: MetaField<*>, owner: MetaObject, loader: MetaDataLoader): KotlinTypeName {
        // FR-044: a report's derived enum field → the class of the entity field it reads.
        if (owner is ReportReadModel) reportEnumClasses[field.name]?.let { return it }
        // field.enum → the typed enum class generated alongside this entity, the shared one it
        // reaches, or (FR-019) the configured external class of a @provided one.
        KotlinTypeMapper.enumTypeName(field, owner, fr019Config)?.let { return it }
        if (field is ObjectField) {
            val ref = readObjectRef(field)
            val target = ref?.let { KotlinGenUtil.lookupCanonicalObject(loader, it) }
            if (target != null) {
                val (targetPkg, targetShort) = PackageMapping.splitFqn(target.name)
                return KotlinClassName(targetPkg, targetShort)
            }
        }
        // field.map → Map<String, V>. The value is the @valueType scalar (handled by
        // kotlinTypeName below) or, for an @objectRef map, the referenced VO data class —
        // which needs the loader to resolve, so build the Map<String, VO> here.
        if (field is MapField) {
            val ref = readObjectRef(field)
            val target = ref?.let { KotlinGenUtil.lookupCanonicalObject(loader, it) }
            if (target != null) {
                val (targetPkg, targetShort) = PackageMapping.splitFqn(target.name)
                return KotlinTypes.MAP.parameterizedBy(KotlinTypes.STRING, KotlinClassName(targetPkg, targetShort))
            }
        }
        return KotlinTypeMapper.kotlinTypeName(field)
    }

    /** Read the `@objectRef` attr off a field (own-only); null if absent. */
    private fun readObjectRef(field: MetaField<*>): String? {
        if (!field.hasMetaAttr(ObjectField.ATTR_OBJECTREF, true)) return null
        return runCatching { field.getMetaAttr(ObjectField.ATTR_OBJECTREF, true).valueAsString }
            .getOrNull()
    }

    // === entity-scoped cross-field validators ==================================

    /**
     * One `@get:AssertTrue @get:JsonIgnore val isXxxValid: Boolean` per entity-scoped cross-field
     * validator (comparison / requiredWhen / presentIff / atLeastOne / exactlyOne, with @condition). Null-safe in the DB CHECK
     * sense (SQL NULL = Kotlin null; "" is not null). A validator naming a missing field is
     * skipped. Body-declared, so it stays out of the data class's equals / copy / constructor.
     */
    protected open fun crossFieldProperties(obj: MetaObject): List<CrossFieldProperty> {
        val out = mutableListOf<CrossFieldProperty>()
        val used = mutableSetOf<String>()
        for ((v, expr) in KotlinCrossFieldRules.rules(obj) { KotlinWriter.escapeName(it.name) }) {
            val base = v.name.map { if (it.isLetterOrDigit() || it == '_') it else '_' }.joinToString("")
                .ifEmpty { "CrossField" }.replaceFirstChar { it.uppercaseChar() }
            var name = "is${base}Valid"
            var n = 2
            while (!used.add(name)) name = "is${base}${n++}Valid"
            out.add(CrossFieldProperty(name, v, expr))
        }
        return out
    }

    // === validation (SP-C validator parity, Unit 5) =========================

    /**
     * Build the `@field:`-site-targeted jakarta.validation annotations for a generated
     * property from the field's constraint metadata — both field attrs (`@required`,
     * `@maxLength`) and `validator.*` children (length / regex / numeric / array).
     * Returns an empty list when the field carries no constraints.
     *
     * <p>The Kotlin entity data class IS the controller request body
     * (`@RequestBody dto: <Entity>` in [KotlinSpringControllerGenerator]); these
     * annotations make Spring's `@Valid` enforce the constraints at the boundary.
     * Site target is `field` because jakarta's reflective
     * validator reads the backing field, not the Kotlin property/getter.
     *
     * <p>Cross-port semantics (the SP-C validator-parity contract — mirrors the Spring
     * port's `SpringDtoGenerator`):
     * <ul>
     *   <li>required (field `@required` or `validator.required`) → `@NotNull`. FR-036 Pin 1:
     *       NO `@NotBlank` — a `@required` string is NON-EMPTY BY DEFAULT (rejects null / "")
     *       but WHITESPACE-ONLY is ACCEPTED, so the implicit non-empty floor is a
     *       `@Size(min >= 1)` on the string-length annotation (which `@NotBlank`'s trim-based
     *       check would over-reject). An explicitly authored `validator.length @min` is always
     *       authoritative over that implicit floor (#224); `@min: 0` opts back to
     *       presence-only and emits no `@Size` minimum at all.</li>
     *   <li>`validator.length @min/@max` folded with field `@maxLength` (strictest-wins on max)
     *       into ONE `@Size(min=…, max=…)` — non-array strings only.</li>
     *   <li>`validator.regex @pattern` → `@Pattern(regexp=…)`.</li>
     *   <li>`validator.numeric @min/@max` → `@Min(…)` / `@Max(…)`.</li>
     *   <li>`validator.array @min/@max` → `@Size(min=…, max=…)` on the `List`.</li>
     * </ul>
     */
    protected open fun validationAnnotations(field: MetaField<*>): List<AnnotationUse> {
        val isArray = field.isArrayType
        val isString = field is StringField
        val out = mutableListOf<AnnotationUse>()

        val required = KotlinGenUtil.isRequiredField(field) || hasValidator(field, RequiredValidator::class.java) ||
            KotlinGenUtil.isAssignedPrimaryKeyField(field)
        if (required) {
            // FR-036 Pin 1: @required → @NotNull only. NO @NotBlank (it rejects whitespace-only,
            // which the cross-port owner ruling ACCEPTS). The non-empty floor for a required
            // non-array string is a @Size(min >= 1) folded into the string-length block below.
            out.add(constraint(NOT_NULL))
        }

        // String length (non-array strings only): ONE @Size folding validator.length @min/@max,
        // the field-level @maxLength cap, and — for a required string — a min of at least 1.
        // Guarded by isString && !isArray so a string-ARRAY's @maxLength never emits a char-count
        // @Size on the List (its element-count @Size comes from validator.array below).
        if (isString && !isArray) {
            var lengthMin: Int? = null
            var lengthMax: Int? = null
            validator(field, LengthValidator::class.java)?.let { length ->
                lengthMin = attrInt(length, LengthValidator.ATTR_MIN)
                lengthMax = attrInt(length, LengthValidator.ATTR_MAX)
            }
            // A3 strictest-wins: the effective max is the SMALLER of @maxLength and
            // validator.length @max (either may be absent).
            attrInt(field, StringField.ATTR_MAX_LENGTH)?.let { cap ->
                lengthMax = lengthMax?.let { minOf(it, cap) } ?: cap
            }
            // FR-036 Pin 1: a required string is non-empty by default → fold in an
            // implicit min of 1, but ONLY when no validator.length @min was
            // authored. An explicitly authored @min is always AUTHORITATIVE over
            // that implicit floor (#224 / ADR-0044): @min: 0 opts back to
            // presence-only and, per the cross-port emission pin, emits NO minimum
            // constraint at all (no @Size(min=0)) — cleanest, deterministic output
            // across ports.
            if (required) {
                lengthMin = when (lengthMin) {
                    null -> 1
                    0 -> null
                    else -> lengthMin
                }
            }
            if (lengthMin != null || lengthMax != null) {
                out.add(sizeAnnotation(lengthMin, lengthMax))
            }
        }

        // Regex pattern.
        validator(field, RegexValidator::class.java)?.let { regex ->
            regex.resolvePattern()?.let { pattern ->
                out.add(AnnotationUse(PATTERN, SITE_FIELD, listOf("regexp = " + KotlinWriter.str(pattern))))
            }
        }

        // Numeric value bounds.
        validator(field, NumericValidator::class.java)?.let { numeric ->
            attrInt(numeric, NumericValidator.ATTR_MIN)?.let { min ->
                out.add(AnnotationUse(MIN, SITE_FIELD, listOf("value = ${min.toLong()}")))
            }
            attrInt(numeric, NumericValidator.ATTR_MAX)?.let { max ->
                out.add(AnnotationUse(MAX, SITE_FIELD, listOf("value = ${max.toLong()}")))
            }
        }

        // Array element-count bounds → @Size on the List property.
        validator(field, ArrayValidator::class.java)?.let { array ->
            val min = attrInt(array, ArrayValidator.ATTR_MIN)
            val max = attrInt(array, ArrayValidator.ATTR_MAX)
            if (min != null || max != null) out.add(sizeAnnotation(min, max))
        }

        // ADR-0036/0037 Wave 3 — @stringFormat on a plain string field. The canonical
        // matcher per format lives HERE in codegen (NOT author validator.regex), since
        // cross-language regex engines diverge. email → @field:Email; hostname → a
        // canonical DNS-hostname @field:Pattern check.
        if (isString && !isArray && field.hasMetaAttr(StringField.ATTR_STRING_FORMAT)) {
            when (field.getMetaAttr(StringField.ATTR_STRING_FORMAT).value?.toString()?.trim()) {
                StringField.STRING_FORMAT_EMAIL -> out.add(constraint(EMAIL))
                StringField.STRING_FORMAT_HOSTNAME ->
                    out.add(AnnotationUse(PATTERN, SITE_FIELD, listOf("regexp = " + KotlinWriter.str(HOSTNAME_REGEX))))
            }
        }

        return out
    }

    /** A no-member `@field:`-targeted constraint annotation (e.g. `@field:NotNull`). */
    private fun constraint(type: KotlinClassName): AnnotationUse = AnnotationUse(type, SITE_FIELD)

    /**
     * #234: true iff `field` is a STRICT (non-`@lenient`) field.uri / field.inet — the properties
     * whose data-class component binds through the generated [NET_JSON_SUPPORT] literal deserializer.
     * A `@lenient` uri/inet degrades to a plain String ([KotlinTypeMapper.kotlinTypeName]) with NO
     * deserializer, so it is NOT strict.
     */
    /**
     * ADR-0019 Amendment 1 (W1/W2): a `field.decimal` property is written as a canonical JSON string
     * and read from a string or number in the JSON-number grammar, through the generated same-package
     * `MetaDecimalWire` (no MetaObjects import). The serializer sits on the getter and the deserializer on the
     * constructor parameter, the two places Jackson's Kotlin module looks. `contentUsing` for an
     * `@isArray` property (the elements are the decimals).
     */
    private fun decimalWireAnnotations(field: MetaField<*>, pkg: String, declaredRange: Boolean = false): List<AnnotationUse> {
        if (field !is DecimalField) return emptyList()
        decimalWirePackages.add(pkg)
        val wireClass = KotlinDecimalWireEmitter.FILE_NAME
        val member = if (field.isArrayType) "contentUsing" else "using"
        val annotations = mutableListOf<AnnotationUse>()
        // The output half only under `wire.decimals: string`; native lets Jackson write the BigDecimal.
        if (wire.decimalsAsString()) {
            annotations += AnnotationUse(JSON_SERIALIZE, SITE_GET, listOf("$member = $wireClass.Serializer::class"))
        }
        annotations += AnnotationUse(JSON_DESERIALIZE, SITE_PARAM, listOf("$member = $wireClass.Deserializer::class"))
        // C1: a decimal inside a (jsonb) value object has no controller range check of its own, so the
        // deserializer enforces the field's declared @precision/@scale: nothing rounded, excess is a 400.
        // Only a declared precision bounds it, as with a top-level decimal.
        if (declaredRange && !KotlinTypeMapper.isUnboundedDecimal(field)) {
            annotations += AnnotationUse(
                KotlinClassName(pkg, wireClass, "Declared"), SITE_PARAM,
                listOf("precision = ${KotlinTypeMapper.decimalPrecision(field)}", "scale = ${KotlinTypeMapper.decimalScale(field)}"),
            )
        }
        return annotations
    }

    /**
     * `field.duration`: a `java.time.Duration` property is written as the canonical ISO-8601 string
     * and read from the accepted form only, through the generated same-package `MetaDurationWire`
     * (no MetaObjects import). Only under `wire.durations: iso`; under native the host
     * ObjectMapper's own java.time handling applies. Both halves in iso mode: a host ObjectMapper's JavaTimeModule
     * writes a Duration as decimal seconds (or `Duration.toString()`, which differs for a negative
     * span), and `Duration.parse` accepts more than the accepted form. The serializer sits on the
     * getter and the deserializer on the constructor parameter; `contentUsing` for an `isArray`.
     */
    private fun durationWireAnnotations(field: MetaField<*>, pkg: String): List<AnnotationUse> {
        // wire.durations: native (the default) leaves the host ObjectMapper's own java.time handling.
        if (field !is DurationField || !wire.durationsIso()) return emptyList()
        durationWirePackages.add(pkg)
        val wireClass = KotlinDurationWireEmitter.FILE_NAME
        val member = if (field.isArrayType) "contentUsing" else "using"
        return listOf(
            AnnotationUse(JSON_SERIALIZE, SITE_GET, listOf("$member = $wireClass.Serializer::class")),
            AnnotationUse(JSON_DESERIALIZE, SITE_PARAM, listOf("$member = $wireClass.Deserializer::class")),
        )
    }

    private fun isStrictNetField(field: MetaField<*>): Boolean =
        (field is UriField || field is InetField) && !KotlinTypeMapper.lenientNetField(field)

    /**
     * #234: the `@field:JsonDeserialize(using = …)` annotation binding a STRICT field.uri /
     * field.inet property to the same-`pkg` generated `MetaNetJson` deserializer — an
     * absolute-scheme URI or an IPv4/IPv6 literal (never a DNS lookup). `contentUsing` for an
     * `@isArray` property (the ELEMENTS deserialize strictly). Null for any other field.
     */
    private fun netDeserializeAnnotation(field: MetaField<*>, pkg: String): AnnotationUse? {
        if (!isStrictNetField(field)) return null
        val deserializer = if (field is UriField) "AbsoluteUriDeserializer" else "InetLiteralDeserializer"
        val member = if (field.isArrayType) "contentUsing" else "using"
        return AnnotationUse(JSON_DESERIALIZE, SITE_FIELD, listOf("$member = $NET_JSON_SUPPORT.$deserializer::class"))
    }

    /** `@field:Size(min = …, max = …)` — each bound omitted when null. */
    private fun sizeAnnotation(min: Int?, max: Int?): AnnotationUse {
        val bounds = buildList {
            if (min != null) add("min = $min")
            if (max != null) add("max = $max")
        }
        return AnnotationUse(SIZE, SITE_FIELD, bounds)
    }

    /** Read an int-valued attr from a node, trying each name in order; null when absent/unparseable. */
    private fun attrInt(node: MetaData, vararg attrNames: String): Int? {
        for (attr in attrNames) {
            if (node.hasMetaAttr(attr)) {
                return runCatching { node.getMetaAttr(attr).valueAsString.trim().toInt() }.getOrNull()
            }
        }
        return null
    }

    private fun <V : MetaValidator> validator(field: MetaField<*>, type: Class<V>): V? {
        // ADR-0039: resolving member iteration — getChildren(type) walks the extends
        // super chain, so a concrete field inherits validators from an abstract base.
        // A raw field.children read would miss inherited validators.
        for (child in field.getChildren(MetaValidator::class.java, true)) {
            if (type.isInstance(child)) return type.cast(child)
        }
        return null
    }

    private fun hasValidator(field: MetaField<*>, type: Class<out MetaValidator>): Boolean =
        validator(field, type) != null

    private companion object {
        /** MetaObject subtypes this generator emits a Kotlin data class for.
         *  FR-024 (ADR-0028): object.projection included — a derived read-only
         *  representation still needs its data class for query results. */
        val EMITTED_SUBTYPES = setOf(
            MetaObject.SUBTYPE_ENTITY,
            MetaObject.SUBTYPE_VALUE,
            MetaObject.SUBTYPE_PROJECTION,
        )

        // jakarta.validation.constraints annotation types (SP-C validator parity).
        private const val JAKARTA_CONSTRAINTS = "jakarta.validation.constraints"
        val NOT_NULL = KotlinClassName(JAKARTA_CONSTRAINTS, "NotNull")
        val SIZE = KotlinClassName(JAKARTA_CONSTRAINTS, "Size")
        val PATTERN = KotlinClassName(JAKARTA_CONSTRAINTS, "Pattern")
        val MIN = KotlinClassName(JAKARTA_CONSTRAINTS, "Min")
        val MAX = KotlinClassName(JAKARTA_CONSTRAINTS, "Max")
        val EMAIL = KotlinClassName(JAKARTA_CONSTRAINTS, "Email")
        val ASSERT_TRUE = KotlinClassName(JAKARTA_CONSTRAINTS, "AssertTrue").canonicalName

        /** The use-site targets the annotations are written with. */
        const val SITE_FIELD = "field"
        const val SITE_GET = "get"
        const val SITE_PARAM = "param"

        /** The KDoc line every generated class carries: the GENERATED marker. */
        const val GENERATED_DOC = "GENERATED — do not hand-edit. Regenerated from metadata."

        private const val JACKSON_ANNOTATION = "com.fasterxml.jackson.annotation"
        val JSON_IGNORE_PROPERTIES = KotlinClassName(JACKSON_ANNOTATION, "JsonIgnoreProperties")
        val JSON_INCLUDE = KotlinClassName(JACKSON_ANNOTATION, "JsonInclude")
        val JSON_IGNORE = KotlinClassName(JACKSON_ANNOTATION, "JsonIgnore").canonicalName

        /** Program D: `@field:Valid` on a value-object member so a parent `@Valid` / whole-bean
         *  validate cascades into the nested VO's own constraints (lives in `jakarta.validation`,
         *  NOT `jakarta.validation.constraints`). */
        val VALID = KotlinClassName("jakarta.validation", "Valid")

        /** #234: `@field:JsonDeserialize(using = …)` binds a STRICT field.uri / field.inet property
         *  to the same-package [NET_JSON_SUPPORT] literal deserializer. */
        val JSON_DESERIALIZE = KotlinClassName("com.fasterxml.jackson.databind.annotation", "JsonDeserialize")
        val JSON_SERIALIZE = KotlinClassName("com.fasterxml.jackson.databind.annotation", "JsonSerialize")
        /** The per-package generated support object holding the #234 strict Jackson deserializers. */
        const val NET_JSON_SUPPORT = "MetaNetJson"


        /**
         * Canonical DNS-hostname matcher for `@stringFormat: hostname` (ADR-0036/0037 Wave 3).
         * Codegen-owned (NOT author `validator.regex`) — one or more dot-separated labels, each
         * 1–63 chars of alphanumerics/hyphens not starting/ending with a hyphen. Byte-identical
         * to the Spring port's `SpringGeneratorSupport.HOSTNAME_REGEX`.
         */
        const val HOSTNAME_REGEX =
            "^(?=.{1,253}\$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\$"
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    // execute() writes whole files; the parent's print-writer pipeline is unused.
    override fun writeSingleFile(md: MetaObject, writer: GeneratorIOWriter<*>?) { /* unused */ }
    override fun <T : GeneratorIOWriter<*>?> getSingleWriter(
        loader: MetaDataLoader?, md: MetaObject?, pw: PrintWriter?
    ): T? = null
    override fun <T : GeneratorIOWriter<*>?> getFinalWriter(
        loader: MetaDataLoader?, out: OutputStream?
    ): T? = null
    override fun writeFinalFile(metadata: MutableCollection<MetaObject>?, writer: GeneratorIOWriter<*>?) { /* none */ }
    override fun getSingleOutputFilePath(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).first.replace('.', '/')
    override fun getSingleOutputFilename(md: MetaObject): String =
        PackageMapping.splitFqn(md.name).second + ".kt"

    /**
     * Whether the class gets a nested `Builder` plus a `@JvmStatic builder()` factory.
     *
     * Kotlin default arguments are a COMPILER feature, not a bytecode one. A data class whose
     * properties are all defaulted exposes only three constructors to Java — the full N-arg one,
     * a synthetic bitmask one Java cannot call, and (when every parameter is defaulted) a no-arg
     * one that yields an all-null instance of an IMMUTABLE class. So a Java caller setting 3 of
     * 14 fields had to pass 14 arguments with 11 nulls, and a generated value object replacing a
     * hand-written Lombok `@Builder` made its Java call sites strictly worse (#365). Kotlin
     * callers were never affected — named arguments cover it — which is why every existing test
     * here, all Kotlin-side, missed it.
     *
     * A nested builder rather than `@JvmOverloads`: overloads are positional, so they only help a
     * caller whose omissions are all TRAILING, and a 14-member class would emit 15 constructors
     * to say so. A builder needs no dependency (deliberately NOT Lombok — generated code must not
     * force a third-party annotation processor on an adopter) and reads the same from both
     * languages.
     *
     * Every backing field is nullable even where the property is not: a builder is filled
     * incrementally, so it cannot hold the constructor's non-null guarantee. `build()` restores it
     * with `requireNotNull`, naming the property — the same trade every builder makes, and the
     * data-class constructor remains the real enforcement point.
     */
    private fun javaBuilderApplies(obj: MetaObject, params: List<PropertyParam>): Boolean {
        if (params.isEmpty()) return false
        // NOT on an object.projection. A projection is a DERIVED read-only representation —
        // it arrives from a view query and nothing constructs one, so a builder would be an
        // affordance for something callers must not do. It would also put `var` backing fields
        // into a type KotlinProjectionCompileTest requires to be immutable, which is how this
        // exclusion was found rather than reasoned about.
        if (obj.subType == MetaObject.SUBTYPE_PROJECTION) return false
        // Nor on a report's row (FR-044), for the same reason: it arrives from the view.
        return obj !is ReportReadModel
    }

    /** Write the nested `Builder` class and the companion's `builder()` factory for class [self]. */
    private fun writeJavaBuilder(w: KotlinWriter, self: String, params: List<PropertyParam>) {
        w.doc("Fluent builder — lets a JAVA caller set a subset of properties.")
        w.block("class Builder {") {
            for (p in params) {
                w.line("private var ", KotlinWriter.escapeName(p.name), ": ", p.type.copy(nullable = true).write(w), " = null")
            }
            for (p in params) {
                val name = KotlinWriter.escapeName(p.name)
                w.blank()
                w.block("fun $name(v: ${p.type.copy(nullable = true).write(w)}): Builder {") {
                    w.line("this.", name, " = v")
                    w.line("return this")
                }
            }
            w.blank()
            // `build()` restores each non-null property's guarantee with requireNotNull, naming the
            // property. The writer breaks the argument list only between arguments, never inside
            // the message's string literal (#388).
            val args = params.map { p ->
                val name = KotlinWriter.escapeName(p.name)
                if (p.type.isNullable) "$name = $name"
                else "$name = requireNotNull($name) { ${KotlinWriter.str("${p.name} is required")} }"
            }
            w.line("fun build(): ", self, " = ", KotlinWriter.call(self, *args.toTypedArray()))
        }
        w.blank()
        w.block("companion object {") {
            w.line("@", w.use("kotlin.jvm.JvmStatic"))
            w.line("fun builder(): Builder = Builder()")
        }
    }
}
