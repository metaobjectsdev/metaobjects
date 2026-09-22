package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MapField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.TemplateConstants;
import com.metaobjects.util.MetaDataUtil;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import com.metaobjects.generator.util.GeneratedFileWriter;

/**
 * Generator: one {@code <TemplateShortName>Parser} Java class per RESPONDING
 * {@code template.prompt} declaration (ADR-0052 — one carrying {@code @responseRef}),
 * emitting a Jackson-backed throw-only parser that returns the {@code @responseRef} value
 * object's own record — the one {@link SpringValueObjectGenerator} emits (ADR-0056). This
 * generator declares no record of its own. <b>Requires {@link SpringValueObjectGenerator} in
 * the same run.</b>
 *
 * <p>FR-006 — the Java port of the cross-language template-output parser
 * codegen. See {@code docs/superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md}
 * and ADR-0010 for the cross-port contract; this generator is the Spring/Java
 * sibling of TS's {@code outputParser()}, C#'s {@code OutputParserGenerator},
 * Python's {@code OutputParserGenerator}, and Kotlin's
 * {@code KotlinOutputParserGenerator}.
 *
 * <p>API shape (idiomatic Java/Spring throw-only per ADR-0010 §3 — matches
 * the Jackson convention; consumers wrap with their own try/catch when they
 * need explicit error handling):
 * <pre>
 *   public final class &lt;TemplateShortName&gt;Parser {
 *       private static final ObjectMapper MAPPER = new ObjectMapper();
 *
 *       private &lt;TemplateShortName&gt;Parser() {}
 *
 *       // Throws com.fasterxml.jackson.core.JsonProcessingException on bad input.
 *       public static &lt;ResponseVo&gt; parse(String text) throws JsonProcessingException {
 *           return MAPPER.readValue(text, &lt;ResponseVo&gt;.class);
 *       }
 *   }
 * </pre>
 *
 * <p>Skips and defensive cases (mirrors the cross-port behavior):
 * <ul>
 *   <li>{@code template.output} is ignored — it renders OUTBOUND and parses nothing.</li>
 *   <li>A {@code template.prompt} with no {@code @responseRef} — nothing elicits a
 *       typed reply, so there is nothing to parse.</li>
 *   <li>A {@code @responseRef} that does not resolve to a payload target (an
 *       {@code object.value} or sourceless {@code object.projection}) — skipped fail-closed.</li>
 *   <li>Outputs are processed in stable name order for deterministic emission.</li>
 * </ul>
 *
 * <p>The emitted file lands in the template's {@code <pkg>.prompts} package and names the
 * value object's record fully qualified.
 *
 * <p><b>Tolerant extract — one metadata-driven path (FR-010 / FR-011 + Plan 2.1).</b>
 * For {@code @format: json|xml} outputs the parser also emits a tolerant best-effort
 * {@code extractLenient(MetaDataLoader, String[, ExtractOptions])} entry point
 * (never-throwing; lost/malformed components are null in the typed payload +
 * classified in the report). It resolves this payload's {@code MetaObject} by its
 * baked FQN from the supplied loader and delegates to
 * {@link com.metaobjects.object.extract.MetaObjectExtractor}, which assembles the
 * full object graph (nested objects + arrays-of-objects + enum coercion +
 * generalized {@code @default}) reflection-free via the Phase A object model,
 * reading the live {@code MetaField} metadata directly (so {@code extends}
 * inheritance "just works" — no baked snapshot to drift). The assembled
 * {@code ValueObject} graph (a {@code Map<String,Object>}) is then mapped into the
 * value objects' records by generated {@code from<Vo>(Map)} helpers. This
 * is the codegen-wrapping-runtime pattern (a generated DAO calling OMDB).
 *
 * <p><b>Consumer dependency (delegating extract).</b> The
 * {@code extractLenient(MetaDataLoader, ...)} overload references
 * {@code com.metaobjects.object.extract.MetaObjectExtractor} (module
 * {@code metaobjects-om}) and {@code com.metaobjects.loader.MetaDataLoader}
 * ({@code metaobjects-metadata}) in addition to the {@code metaobjects-render}
 * extract engine. Consumers must have {@code metaobjects-om} (which transitively
 * brings {@code render} + {@code metadata}) on the classpath.
 *
 * <p><b>Consumer dependency.</b> The emitted parser file imports from
 * {@code com.fasterxml.jackson.databind.ObjectMapper} and
 * {@code com.fasterxml.jackson.core.JsonProcessingException}. Consumers
 * must have Jackson on their classpath; Spring Boot's
 * {@code spring-boot-starter-web} brings Jackson automatically. See
 * {@code KNOWN_GAPS.md} for the consumer-wiring contract.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringOutputParserGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());

        // ADR-0052: the direction rule lives in FindInbound, never re-derived here.
        for (MetaTemplate tmpl : FindInbound.inboundTemplates(loader)) {
            emit(tmpl, loader, outRoot);
        }
    }

    /**
     * True iff this generator emits a response parser for {@code node}: a
     * {@code template.prompt} carrying a {@code @responseRef} that resolves (against
     * {@code loader}) to an {@code object.value}. Single source of truth shared by the
     * generator loop AND the api-docs builder.
     *
     * <p>ADR-0052: {@code template.output} is OUTBOUND ONLY and gets no parser. It had
     * NO format filter at all here, so a markdown document template got a generated
     * Jackson {@code readValue} — a method that could never work — for text the system
     * had just rendered itself.
     */
    public static boolean appliesTo(MetaData node, MetaDataLoader loader) {
        return FindInbound.isInbound(node, loader);
    }

    protected void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot) {
        FindInbound.InboundShape shape = FindInbound.responseShape(loader, template);
        if (shape == null) {
            return; // no @responseRef, or it does not resolve to a VO
        }
        MetaObject payloadVo = shape.vo();

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = SpringNaming.promptsPackage(templatePkg);
        // PascalCase the class name — templates authored in camelCase (e.g. `npcTurn`)
        // yield a Java-idiomatic `NpcTurnParser`.
        String parserClass = SpringNaming.parserName(templateShort);
        SpringNaming.requireReferenceable(outPkg, payloadVo, "template '" + template.getName() + "'");
        // Per-template coercion state. Carried as fields rather than added parameters so every
        // protected seam here (emitMapperMethods / emitMapper / mapperArgForField — ADR-0002
        // extension points) can participate without a signature change for them. Reset per
        // template because one loader run emits a parser per responding prompt.
        this.usedCoercions = new java.util.LinkedHashSet<>();
        this.currentParserClass = parserClass;
        // ADR-0052: the shape parsed INTO is @responseRef — the reply — never @payloadRef,
        // which types the request this prompt renders outbound. ADR-0056: it is the response
        // value object's own record, referenced fully qualified.
        String payloadClass = SpringNaming.valueObjectRef(payloadVo);
        // The mapper-name map is a PURE function of the response VO — threaded through the
        // emit chain rather than parked on the instance (ADR-0056's name rule; a field here
        // would let an emitMapper called outside emit() read a stale template's names).
        Map<String, String> mapperNames = mapperNames(payloadVo);

        StringBuilder src = new StringBuilder();
        src.append("// GENERATED — DO NOT EDIT — response parser for template.prompt `")
           .append(template.getName()).append("`\n");
        src.append(SpringNaming.packageHeader(outPkg));
        // ADR-0053: the reply's syntax is @responseFormat (json|xml, default json) — never
        // @format, which is the syntax of the rendered prompt BODY. The old @format gate is
        // what made a text-bodied prompt with a JSON reply emit a strict parser and no
        // extract at all — the common case, silently unserved.
        String format = FindInbound.responseFormatOf(template);
        // The strict Jackson tier is JSON-ONLY, by construction: strict all-or-nothing
        // semantics layered over the REPAIRING XML reader would throw or accept based on
        // how much repair happened, which is not a contract anyone can reason about. So an
        // XML reply gets the tolerant extract and nothing strict.
        boolean emitStrict = !FindInbound.isXml(format);
        // Every responding prompt gets the tolerant tier — declaring a response shape IS
        // the request for one.
        boolean emitExtractLenient = true;
        if (emitStrict) {
            src.append("import com.fasterxml.jackson.core.JsonProcessingException;\n");
            src.append("import com.fasterxml.jackson.databind.ObjectMapper;\n");
        }
        if (emitExtractLenient) {
            src.append("import com.metaobjects.render.extract.Format;\n");
            src.append("import com.metaobjects.render.extract.ExtractMap;\n");
        }
        src.append("\n");
        src.append("/** Parser for LLM responses matching the `")
           .append(templateShort).append("` template.prompt. */\n");
        src.append("public final class ").append(parserClass).append(" {\n\n");
        if (emitStrict) {
            // Fails on an unknown property (Jackson's default). findAndRegisterModules picks up
            // jackson-datatype-jsr310 when present, so a java.time component binds.
            src.append("    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();\n\n");
        }
        src.append("    private ").append(parserClass).append("() { /* no instances */ }\n\n");
        if (emitStrict) {
            src.append("    /**\n");
            src.append("     * Parse an LLM response into a typed {@link ")
               .append(payloadClass).append("}.\n");
            src.append("     *\n");
            src.append("     * @throws JsonProcessingException when the input is not valid JSON for the response schema.\n");
            src.append("     */\n");
            src.append("    public static ").append(payloadClass).append(" parse(String text) throws JsonProcessingException {\n");
            src.append("        return MAPPER.readValue(text, ").append(payloadClass).append(".class);\n");
            src.append("    }\n");
        }
        if (emitExtractLenient) {
            String formatEnum = FindInbound.isXml(format) ? "Format.XML" : "Format.JSON";
            String payloadFqn = payloadVo.getName();

            // ---- Runtime-delegating extract (the single metadata-driven extract path) ----
            src.append("\n");
            src.append("    /** Payload FQN this parser extracts — resolved against the supplied loader at runtime. */\n");
            src.append("    public static final String PAYLOAD_FQN = \"").append(escapeJava(payloadFqn)).append("\";\n");
            src.append("\n");
            src.append("    /**\n");
            src.append("     * Tolerant best-effort extraction delegating to the runtime\n");
            src.append("     * {@link com.metaobjects.object.extract.MetaObjectExtractor}; never throws.\n");
            src.append("     * Fully populates nested-object and array-of-object components (unlike the\n");
            src.append("     * self-contained {@code extractLenient(String)} overload). Resolves this payload's\n");
            src.append("     * {@code MetaObject} by {@link #PAYLOAD_FQN} from {@code loader}.\n");
            src.append("     */\n");
            src.append("    public static com.metaobjects.render.extract.ExtractionResult<").append(payloadClass).append("> extractLenient(com.metaobjects.loader.MetaDataLoader loader, String text) {\n");
            src.append("        return extractLenient(loader, text, com.metaobjects.render.extract.ExtractOptions.defaults());\n");
            src.append("    }\n");
            src.append("\n");
            src.append("    public static com.metaobjects.render.extract.ExtractionResult<").append(payloadClass).append("> extractLenient(com.metaobjects.loader.MetaDataLoader loader, String text, com.metaobjects.render.extract.ExtractOptions opts) {\n");
            src.append("        com.metaobjects.object.MetaObject mo = loader.getMetaObjectByName(PAYLOAD_FQN);\n");
            src.append("        com.metaobjects.render.extract.ExtractionResult<Object> raw =\n");
            src.append("            com.metaobjects.object.extract.MetaObjectExtractor.extract(mo, text, ").append(formatEnum).append(", opts);\n");
            src.append("        // The assembled graph is a ValueObject (a Map<String,Object>) with nested\n");
            src.append("        // ValueObjects / List<ValueObject> — map it into the value objects' records.\n");
            src.append("        @SuppressWarnings(\"unchecked\")\n");
            src.append("        java.util.Map<String, Object> d = (java.util.Map<String, Object>) raw.data();\n");
            src.append("        return new com.metaobjects.render.extract.ExtractionResult<>(from").append(mapperNames.get(payloadVo.getName())).append("(d), raw.report());\n");
            src.append("    }\n");

            // ---- Generated ValueObject(Map) -> value-object record mappers (root + nested, deduped) ----
            emitMapperMethods(src, payloadVo, mapperNames);
            // AFTER the mappers: emitting them is what populates usedCoercions.
            appendMapperHelpers(src, usedCoercions);
        }
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve(parserClass + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + parserClass + ".java for template " + template.getName() + ": " + e, e);
        }
    }

    /**
     * Emit one {@code private static <Vo> from<Name>(Map<String,Object> d)} mapper per value
     * object reachable from {@code rootVo} (the response + every nested VO), deduped by FQN.
     * {@code <Vo>} is the value object's own record, fully qualified; {@code <Name>} comes from
     * {@link #mapperNames}. Each mapper reconstructs the typed record from an assembled
     * {@code ValueObject} (which IS a {@code Map<String,Object>}): scalars/enums via
     * {@code ExtractMap}, a single nested object by recursing into its mapper, and an
     * array-of-objects by mapping each element {@code Map}.
     *
     * <p>This is what closes the FR-010 nested gap for the runtime-delegating overload:
     * the runtime already assembled the nested graph; these mappers only translate the
     * generic {@code ValueObject} graph into the generated typed-record graph. Cycle/depth
     * bounding is handled upstream by {@code MetaObjectExtractor}, so the per-FQN dedupe set
     * here also stops the emitter from recursing forever on a cyclic value-object graph.</p>
     */
    protected void emitMapperMethods(StringBuilder src, MetaObject rootVo, Map<String, String> mapperNames) {
        Set<String> emitted = new LinkedHashSet<>();
        emitMapper(src, rootVo, mapperNames, emitted);
    }

    protected void emitMapper(StringBuilder src, MetaObject vo, Map<String, String> mapperNames, Set<String> emitted) {
        if (!emitted.add(vo.getName())) {
            return; // already emitted (dedupe + cycle guard) — vo.getName() is already the
                     // FQN (Java's MetaObject.getName() is package-qualified), so this key
                     // is never bare — a cross-package same-short-name collision does NOT
                     // silently drop the second VO's mapper (unlike the #219/#244 bare-key
                     // dedupe bug other ports hit here).
        }

        // Discover nested mappers to emit AFTER this one (declaration order is irrelevant
        // for static methods, but keeping a stable post-order is tidy + deterministic).
        List<MetaObject> nestedVos = new ArrayList<>();

        String payloadClass = SpringNaming.valueObjectRef(vo);
        StringBuilder body = new StringBuilder();
        body.append("\n");
        body.append("    /** Map an assembled ValueObject (Map) into a typed {@link ")
            .append(payloadClass).append("}. Generated; null-tolerant. */\n");
        body.append("    private static ").append(payloadClass)
            .append(" from").append(mapperNames.get(vo.getName()))
            .append("(java.util.Map<String, Object> d) {\n");
        body.append("        if (d == null) return null;\n");
        body.append("        return new ").append(payloadClass).append("(\n");

        List<MetaField> fields = new ArrayList<>(vo.getMetaFields());
        for (int i = 0; i < fields.size(); i++) {
            MetaField<?> field = fields.get(i);
            String arg = mapperArgForField(field, vo, payloadClass, mapperNames, nestedVos);
            body.append("                ").append(arg);
            if (i < fields.size() - 1) body.append(',');
            body.append('\n');
        }
        body.append("        );\n");
        body.append("    }\n");
        src.append(body);

        // Recurse into nested value objects (post-order, deduped).
        for (MetaObject nested : nestedVos) {
            emitMapper(src, nested, mapperNames, emitted);
        }
    }

    /**
     * Build the constructor-argument expression that reads {@code field} from the assembled
     * {@code Map<String,Object> d}. Scalars/enums/scalar-arrays go through {@code ExtractMap};
     * nested objects recurse into their generated mapper; arrays-of-objects map each element.
     * Records the discovered nested VO(s) into {@code nestedVos} so the caller emits their mappers.
     */
    @SuppressWarnings("rawtypes")
    protected String mapperArgForField(MetaField<?> field, MetaObject owner, String payloadClass,
                                     Map<String, String> mapperNames, List<MetaObject> nestedVos) {
        String name = field.getName();

        // A keyed map of values is not something the lenient extract populates: leave it null,
        // with the record's Map component typed exactly as the value-object generator declared it.
        if (field instanceof MapField) {
            return "null /* FR-010: map extract deferred */";
        }

        // Nested object / array-of-objects (but NOT enum, which is a string-backed scalar).
        boolean isObjectField = field instanceof ObjectField || MetaDataUtil.hasObjectRef(field);
        if (isObjectField && !(field instanceof EnumField)) {
            MetaObject target = MetaDataUtil.getObjectRef(field);
            if (target != null && MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) {
                nestedVos.add(target);
                String nestedMapper = "from" + mapperNames.get(target.getName());
                if (field.isArrayType()) {
                    // List<Nested>: map each element Map; the assembled value is a List.
                    // from<Nested> is a static method in scope within this generated parser class.
                    return "mapObjectList(d, \"" + name + "\", m -> " + nestedMapper + "(m))";
                }
                // Single nested object: cast the element to a Map and recurse.
                return nestedMapper + "(asMap(d.get(\"" + name + "\")))";
            }
            // Non-VO target / unresolved ref — defensive: leave null.
            return "null";
        }

        // Enum fields: the assembled value is a validated member string; the record component
        // is the enum nested in the value object's record. Bridge string → enum via
        // `<Vo>.<Enum>.valueOf(s)` (per-element for arrays, dropping nulls). Checked BEFORE
        // the generic scalar-array branch (enum-before-isArray). Safe: @values == the generated
        // constants and the engine validated the member.
        if (field instanceof EnumField ef) {
            String enumType = payloadClass + "." + SpringTypeMapper.enumTypeName(owner, ef);
            if (field.isArrayType()) {
                // asStringList returns null when the array is absent/malformed — guard with an
                // empty list so the stream never NPEs.
                return "java.util.Optional.ofNullable(ExtractMap.asStringList(d, \"" + name + "\"))"
                    + ".orElseGet(java.util.List::of).stream()"
                    + ".filter(java.util.Objects::nonNull).map(" + enumType + "::valueOf)"
                    + ".collect(java.util.stream.Collectors.toList())";
            }
            // Scalar enum: null-safe valueOf — an absent/lost enum stays null in the (never-throws)
            // lenient result rather than NPE-ing on Enum.valueOf(null).
            return "java.util.Optional.ofNullable(ExtractMap.asString(d, \"" + name + "\"))"
                + ".map(" + enumType + "::valueOf).orElse(null)";
        }

        // Scalar arrays: coerce each element to the record's DECLARED element type. The
        // element coercion is chosen by the same function that chose the declared type
        // (coercerFor <-> SpringTypeMapper.javaTypeName), so the two cannot drift.
        if (field.isArrayType()) {
            String coercer = coercerFor(field);
            // A String-typed element needs no coercion — keep the long-standing asStringList
            // call so output for string (and enum-as-string) arrays is byte-identical.
            if (COERCE_STRING.equals(coercer)) return "ExtractMap.asStringList(d, \"" + name + "\")";
            usedCoercions.add(coercer);
            usedCoercions.add(COERCE_LIST);
            return "coerceList(d, \"" + name + "\", " + currentParserClass + "::" + coercer + ")";
        }

        // Scalars: the four kinds the extract ENGINE itself produces (FieldKind INT/LONG/
        // DOUBLE/BOOLEAN) read straight through ExtractMap; everything else the engine hands
        // back as a String while the record declares a richer type, so it needs a coercion.
        if (field instanceof com.metaobjects.field.IntegerField) return "ExtractMap.asInt(d, \"" + name + "\")";
        if (field instanceof com.metaobjects.field.LongField && !(field instanceof com.metaobjects.field.CurrencyField))
            return "ExtractMap.asLong(d, \"" + name + "\")";
        if (field instanceof com.metaobjects.field.DoubleField)  return "ExtractMap.asDouble(d, \"" + name + "\")";
        if (field instanceof com.metaobjects.field.BooleanField) return "ExtractMap.asBool(d, \"" + name + "\")";

        String coercer = coercerFor(field);
        // String-typed component: read straight through, so output stays byte-identical for
        // field.string / field.enum and for the @lenient uri/inet degradations.
        if (COERCE_STRING.equals(coercer)) return "ExtractMap.asString(d, \"" + name + "\")";
        usedCoercions.add(coercer);
        return coercer + "(d.get(\"" + name + "\"))";
    }

    // -------------------------------------------------------------------------
    // Scalar coercion — pairing the reader to the record's DECLARED component type
    // -------------------------------------------------------------------------
    //
    // The extract ENGINE is deliberately narrow: FieldKind is
    // {STRING, INT, LONG, DOUBLE, BOOLEAN, ENUM, OBJECT}, and MetaObjectExtractor.scalarKind
    // maps every other subtype to STRING. So for a field.decimal / date / time / timestamp /
    // currency / uuid / uri / inet / float the assembled value is a String — while the
    // generated record declares BigDecimal / LocalDate / LocalTime / Instant / Long / UUID /
    // URI / InetAddress / Float via SpringTypeMapper.javaTypeName.
    //
    // That mismatch was a COMPILE failure, not a silent one: 9 of 15 scalar subtypes as a
    // single component and 13 of 15 as an array emitted `incompatible types`. It went
    // unnoticed because no test payload in this module carried any of them, and because javac
    // reports only the FIRST bad argument of a constructor invocation — so even a fixture with
    // several would have looked like one defect.
    //
    // The fix keeps the record STRICTLY typed (ADR-0052/0056: a responding prompt's reply is
    // the value object's own record, and a caller asking for a declared decimal should get a
    // BigDecimal) and coerces on the way in, in the generated parser. Deliberately NOT
    // by widening ExtractMap: these coercions are parser-local, and the lenient tier's
    // never-throws contract is easier to keep honest next to the mappers that depend on it.
    //
    // coercerFor() below MUST stay in lock-step with SpringTypeMapper.javaTypeName — it is the
    // same instanceof chain, in the same order, answering "what reader produces that type".
    // GeneratedScalarExtractLockStepTest compiles generated output for every scalar subtype in
    // both positions, so a new subtype cannot silently take a reader that does not match.

    private static final String COERCE_STRING   = "coerceString";
    private static final String COERCE_LIST     = "coerceList";

    /** Coercion helpers the CURRENT template's mappers referenced; only these are emitted. */
    private java.util.Set<String> usedCoercions = new java.util.LinkedHashSet<>();
    /** The current template's parser class name — the qualifier for a {@code ::coerceX} method ref. */
    private String currentParserClass = "";

    /**
     * The generated coercion-helper name producing the Java type
     * {@link SpringTypeMapper#javaTypeName} declares for {@code field} — or
     * {@link #COERCE_STRING} when the declared type is already {@code String} (no coercion
     * needed; the caller reads straight through {@code ExtractMap.asString}).
     *
     * <p>For an ARRAY field this answers for the ELEMENT: {@code javaTypeName} returns the
     * element type and {@link SpringDtoGenerator#componentType} does the {@code List<...>} wrap.</p>
     */
    private static String coercerFor(MetaField<?> field) {
        if (field instanceof EnumField) return COERCE_STRING;              // string-backed wire form
        if (field instanceof com.metaobjects.field.IntegerField)  return "coerceInt";
        if (field instanceof com.metaobjects.field.CurrencyField)                       return "coerceLong"; // minor units
        if (field instanceof com.metaobjects.field.LongField)     return "coerceLong";
        if (field instanceof com.metaobjects.field.DoubleField)   return "coerceDouble";
        if (field instanceof com.metaobjects.field.FloatField)                          return "coerceFloat";
        if (field instanceof com.metaobjects.field.DecimalField)                        return "coerceDecimal";
        if (field instanceof com.metaobjects.field.BooleanField)  return "coerceBool";
        if (field instanceof com.metaobjects.field.DateField)                           return "coerceDate";
        if (field instanceof com.metaobjects.field.TimeField)                           return "coerceTime";
        if (field instanceof com.metaobjects.field.TimestampField)
            // Mirrors javaTypeName's split: plain timestamp is an absolute Instant; the
            // @localTime opt-out is a zone-less LocalDateTime, which Instant cannot parse.
            return SpringTypeMapper.javaTypeName(field).endsWith("LocalDateTime")
                ? "coerceLocalDateTime" : "coerceInstant";
        if (field instanceof com.metaobjects.field.UuidField)                           return "coerceUuid";
        // #234: a @lenient uri/inet degrades to a plain String in the record — ask
        // javaTypeName rather than re-deriving that rule here.
        if (field instanceof com.metaobjects.field.UriField)
            return SpringTypeMapper.javaTypeName(field).endsWith("URI") ? "coerceUri" : COERCE_STRING;
        if (field instanceof com.metaobjects.field.InetField)
            return SpringTypeMapper.javaTypeName(field).endsWith("InetAddress")
                ? "coerceInet" : COERCE_STRING;
        return COERCE_STRING;
    }

    /**
     * The {@code from<Name>} mapper-method suffix for each value object reachable from
     * {@code rootVo}, keyed by FQN. A value object's short name when it is unique in this closure;
     * package-qualified ({@code acme::alpha::Note} → {@code AcmeAlphaNote}) for every member of a
     * same-short-name group, because the mappers share one parser class. These are private
     * method names only — the TYPES are the value objects' own records, which their packages
     * already tell apart (ADR-0056).
     */
    protected static Map<String, String> mapperNames(MetaObject rootVo) {
        List<MetaObject> closure = new ArrayList<>();
        collectClosure(rootVo, closure, new LinkedHashSet<>());
        Map<String, Integer> shortCounts = new java.util.HashMap<>();
        for (MetaObject vo : closure) shortCounts.merge(SpringNaming.splitFqn(vo.getName())[1], 1, Integer::sum);
        Map<String, String> names = new java.util.LinkedHashMap<>();
        for (MetaObject vo : closure) {
            String[] split = SpringNaming.splitFqn(vo.getName());
            String name = shortCounts.get(split[1]) == 1
                ? SpringNaming.capitalize(split[1])
                : packageQualified(split[0], split[1]);
            names.put(vo.getName(), name);
        }
        return names;
    }

    private static void collectClosure(MetaObject vo, List<MetaObject> out, Set<String> seen) {
        if (!seen.add(vo.getName())) return;
        out.add(vo);
        for (MetaField<?> field : vo.getMetaFields()) {
            if (field instanceof MapField || field instanceof EnumField) continue;
            if (!(field instanceof ObjectField || MetaDataUtil.hasObjectRef(field))) continue;
            MetaObject target = MetaDataUtil.getObjectRef(field);
            if (target != null && MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) {
                collectClosure(target, out, seen);
            }
        }
    }

    private static String packageQualified(String javaPkg, String shortName) {
        StringBuilder sb = new StringBuilder();
        for (String seg : javaPkg.split("\\.")) {
            if (!seg.isEmpty()) sb.append(SpringNaming.capitalize(seg));
        }
        return sb.append(SpringNaming.capitalize(shortName)).toString();
    }

    /**
     * Append the two shared private-static helpers the runtime-delegating mappers rely on:
     * {@code asMap} (null-tolerant {@code Object -> Map<String,Object>} cast) and
     * {@code mapObjectList} (map each element of an assembled {@code List} via a per-element
     * function, skipping non-Map elements). Emitted once per parser class.
     */
    protected static void appendMapperHelpers(StringBuilder src) {
        appendMapperHelpers(src, java.util.Set.of());
    }

    /**
     * As {@link #appendMapperHelpers(StringBuilder)}, plus the scalar coercion helpers named in
     * {@code usedCoercions}. Only the ones the mappers actually call are emitted: an unused
     * private static method is dead weight in every generated parser and trips the
     * unused-private lint some adopters build with.
     */
    protected static void appendMapperHelpers(StringBuilder src, java.util.Set<String> usedCoercions) {
        src.append("\n");
        src.append("    /** Null-tolerant cast of an assembled value to a Map (a ValueObject IS a Map). */\n");
        src.append("    @SuppressWarnings(\"unchecked\")\n");
        src.append("    private static java.util.Map<String, Object> asMap(Object v) {\n");
        src.append("        return (v instanceof java.util.Map) ? (java.util.Map<String, Object>) v : null;\n");
        src.append("    }\n");
        src.append("\n");
        src.append("    /** Map each element of an assembled List<Map> via {@code fn}; null/absent -> null; non-Map elements skipped. */\n");
        src.append("    private static <T> java.util.List<T> mapObjectList(\n");
        src.append("            java.util.Map<String, Object> d, String key,\n");
        src.append("            java.util.function.Function<java.util.Map<String, Object>, T> fn) {\n");
        src.append("        Object v = d == null ? null : d.get(key);\n");
        src.append("        if (!(v instanceof java.util.List<?> list)) return null;\n");
        src.append("        java.util.List<T> out = new java.util.ArrayList<>(list.size());\n");
        src.append("        for (Object elem : list) {\n");
        src.append("            java.util.Map<String, Object> m = asMap(elem);\n");
        src.append("            if (m != null) out.add(fn.apply(m));\n");
        src.append("        }\n");
        src.append("        return out;\n");
        src.append("    }\n");
        appendCoercionHelpers(src, usedCoercions);
    }

    /**
     * Emit the scalar coercion helpers named in {@code used}. Every one is NEVER-THROWS: the
     * lenient tier's whole contract is that one malformed component becomes null rather than
     * losing the entire extract, so a bad date string must not take the other twenty fields
     * with it.
     */
    private static void appendCoercionHelpers(StringBuilder src, java.util.Set<String> used) {
        if (used.isEmpty()) return;
        src.append("\n");
        src.append("    // ---- scalar coercions (generated; never throw — a malformed value becomes null) ----\n");

        if (used.contains(COERCE_LIST)) {
            src.append("\n");
            src.append("    /** Coerce each element of an assembled List via {@code fn}; null/absent -> null. */\n");
            src.append("    private static <T> java.util.List<T> coerceList(\n");
            src.append("            java.util.Map<String, Object> d, String key, java.util.function.Function<Object, T> fn) {\n");
            src.append("        Object v = d == null ? null : d.get(key);\n");
            src.append("        if (!(v instanceof java.util.List<?> list)) return null;\n");
            src.append("        java.util.List<T> out = new java.util.ArrayList<>(list.size());\n");
            src.append("        for (Object elem : list) out.add(fn.apply(elem));\n");
            src.append("        return out;\n");
            src.append("    }\n");
        }
        // A number arrives either already-typed (a JSON number the engine boxed) or as the
        // String the engine produces for a STRING-kind field — both are accepted.
        emitNumeric(src, used, "coerceInt",    "Integer", "intValue",    "Integer.parseInt");
        emitNumeric(src, used, "coerceLong",   "Long",    "longValue",   "Long.parseLong");
        emitNumeric(src, used, "coerceDouble", "Double",  "doubleValue", "Double.parseDouble");
        emitNumeric(src, used, "coerceFloat",  "Float",   "floatValue",  "Float.parseFloat");

        if (used.contains("coerceDecimal")) {
            src.append("\n");
            src.append("    private static java.math.BigDecimal coerceDecimal(Object v) {\n");
            src.append("        if (v instanceof java.math.BigDecimal b) return b;\n");
            src.append("        if (v == null) return null;\n");
            src.append("        try {\n");
            // Via toString(), never doubleValue(): new BigDecimal(0.1d) is
            // 0.1000000000000000055511151231257827, and precision is the entire reason the
            // model said `decimal` instead of `double`.
            src.append("            return new java.math.BigDecimal(v.toString().trim());\n");
            src.append("        } catch (NumberFormatException e) { return null; }\n");
            src.append("    }\n");
        }
        if (used.contains("coerceBool")) {
            src.append("\n");
            src.append("    private static Boolean coerceBool(Object v) {\n");
            src.append("        if (v instanceof Boolean b) return b;\n");
            src.append("        if (v == null) return null;\n");
            src.append("        String s = v.toString().trim();\n");
            src.append("        if (\"true\".equalsIgnoreCase(s)) return Boolean.TRUE;\n");
            src.append("        if (\"false\".equalsIgnoreCase(s)) return Boolean.FALSE;\n");
            src.append("        return null;\n");
            src.append("    }\n");
        }
        // The temporal coercions take an extra `java.util.Date` arm: MetaField.setObject routes
        // through DataConverter, so by the time the assembled ValueObject reaches these the value
        // is ALREADY a java.util.Date — not the wire String. The String arm still matters for a
        // value that arrived through some other path, and costs one instanceof.
        emitTemporal(src, used, "coerceDate",          "java.time.LocalDate",     "java.time.LocalDate.parse",     ".atZone(java.time.ZoneId.systemDefault()).toLocalDate()");
        emitTemporal(src, used, "coerceTime",          "java.time.LocalTime",     "java.time.LocalTime.parse",     ".atZone(java.time.ZoneId.systemDefault()).toLocalTime()");
        emitTemporal(src, used, "coerceInstant",       "java.time.Instant",       "java.time.Instant.parse",       "");
        emitTemporal(src, used, "coerceLocalDateTime", "java.time.LocalDateTime", "java.time.LocalDateTime.parse", ".atZone(java.time.ZoneId.systemDefault()).toLocalDateTime()");
        emitParsed(src, used, "coerceUuid", "java.util.UUID", "java.util.UUID.fromString", "IllegalArgumentException");

        if (used.contains("coerceUri")) {
            src.append("\n");
            src.append("    private static java.net.URI coerceUri(Object v) {\n");
            src.append("        if (v instanceof java.net.URI u) return u;\n");
            src.append("        if (v == null) return null;\n");
            src.append("        try { return new java.net.URI(v.toString().trim()); }\n");
            src.append("        catch (java.net.URISyntaxException e) { return null; }\n");
            src.append("    }\n");
        }
        if (used.contains("coerceInet")) {
            src.append("\n");
            src.append("    /** IP LITERALS only — see the guard below. */\n");
            src.append("    private static java.net.InetAddress coerceInet(Object v) {\n");
            src.append("        if (v instanceof java.net.InetAddress a) return a;\n");
            src.append("        if (v == null) return null;\n");
            src.append("        String s = v.toString().trim();\n");
            // InetAddress.getByName() performs a DNS LOOKUP for anything that is not an IP
            // literal. A parser reading untrusted model output must never make a network call
            // (latency, and an attacker-chosen hostname becomes an outbound request), so a
            // non-literal is rejected outright rather than resolved. Java 21 has no
            // literal-only parser — InetAddress.ofLiteral is 22+ — hence the shape guard.
            src.append("        if (!s.matches(\"[0-9.]+|[0-9A-Fa-f:.%\\\\[\\\\]]+\")) return null;\n");
            src.append("        try { return java.net.InetAddress.getByName(s); }\n");
            src.append("        catch (java.net.UnknownHostException e) { return null; }\n");
            src.append("    }\n");
        }
    }

    /** A Number-or-String numeric coercion: {@code <boxed> <name>(Object)}. */
    private static void emitNumeric(StringBuilder src, java.util.Set<String> used,
                                    String name, String boxed, String numberAccessor, String parser) {
        if (!used.contains(name)) return;
        src.append("\n");
        src.append("    private static ").append(boxed).append(" ").append(name).append("(Object v) {\n");
        src.append("        if (v instanceof Number n) return n.").append(numberAccessor).append("();\n");
        src.append("        if (v == null) return null;\n");
        src.append("        try { return ").append(parser).append("(v.toString().trim()); }\n");
        src.append("        catch (NumberFormatException e) { return null; }\n");
        src.append("    }\n");
    }

    /**
     * A temporal coercion: already-typed value straight through, a {@code java.util.Date} (what
     * DataConverter produced during assembly) converted via its instant, else parsed from the
     * wire String. {@code fromInstant} is the suffix applied to {@code d.toInstant()} — empty
     * when the target IS an Instant.
     */
    private static void emitTemporal(StringBuilder src, java.util.Set<String> used,
                                      String name, String type, String parser, String fromInstant) {
        if (!used.contains(name)) return;
        src.append("\n");
        src.append("    private static ").append(type).append(" ").append(name).append("(Object v) {\n");
        src.append("        if (v instanceof ").append(type).append(" t) return t;\n");
        src.append("        if (v == null) return null;\n");
        src.append("        if (v instanceof java.util.Date d) return d.toInstant()").append(fromInstant).append(";\n");
        src.append("        try { return ").append(parser).append("(v.toString().trim()); }\n");
        src.append("        catch (java.time.format.DateTimeParseException e) { return null; }\n");
        src.append("    }\n");
    }

    /** A parse-from-String coercion that passes an already-typed value straight through. */
    private static void emitParsed(StringBuilder src, java.util.Set<String> used,
                                   String name, String type, String parser, String thrown) {
        if (!used.contains(name)) return;
        src.append("\n");
        src.append("    private static ").append(type).append(" ").append(name).append("(Object v) {\n");
        src.append("        if (").append(type).append(".class.isInstance(v)) return ").append(type).append(".class.cast(v);\n");
        src.append("        if (v == null) return null;\n");
        src.append("        try { return ").append(parser).append("(v.toString().trim()); }\n");
        src.append("        catch (").append(thrown).append(" e) { return null; }\n");
        src.append("    }\n");
    }


    /** Escape a value for embedding inside a Java double-quoted string literal. */
    private static String escapeJava(String value) {
        StringBuilder sb = new StringBuilder(value.length() + 4);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"':  sb.append("\\\""); break;
                case '\t': sb.append("\\t"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                default:   sb.append(c);
            }
        }
        return sb.toString();
    }

    /**
     * Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities)
     * under the ADR-0042 package-local contract (#228) — was a package-BLIND bare-name
     * scan over every loaded {@code object.value} (first match wins, load-order-dependent);
     * now delegates to the shared {@link SpringNaming#resolveValueObjectRef} so a bare
     * {@code @payloadRef} binds the referrer's OWN package first, agreeing with the
     * loader's own {@code ValidationPhase} validation of the same ref.
     */
    protected static MetaObject resolveValueObject(MetaDataLoader loader, String ref, String referrerPkg) {
        return SpringNaming.resolveValueObjectRef(loader, ref, referrerPkg);
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
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
        return SpringNaming.parserName(SpringNaming.splitFqn(md.getName())[1]) + ".java";
    }
}
