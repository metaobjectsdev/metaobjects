package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.field.EnumField;
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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Generator: one {@code <TemplateShortName>Parser} Java class per
 * {@code template.output} declaration, emitting a Jackson-backed throw-only
 * parser around the {@code @payloadRef} payload record produced by
 * {@link SpringPayloadGenerator} (no payload-shape re-declaration).
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
 *       public static &lt;TemplateShortName&gt;Payload parse(String text) throws JsonProcessingException {
 *           return MAPPER.readValue(text, &lt;TemplateShortName&gt;Payload.class);
 *       }
 *   }
 * </pre>
 *
 * <p>Skips and defensive cases (mirrors the cross-port behavior):
 * <ul>
 *   <li>{@code template.prompt} is ignored — only outputs need parsing.</li>
 *   <li>Missing {@code @payloadRef} — skipped (loader's validation pass
 *       normally rejects this first; defensive only).</li>
 *   <li>{@code @payloadRef} resolves to a non-VO target (e.g. {@code object.entity}) —
 *       skipped (same contract as {@link SpringPayloadGenerator}).</li>
 *   <li>Outputs are processed in stable name order for deterministic emission.</li>
 * </ul>
 *
 * <p>The emitted file's package matches {@link SpringPayloadGenerator}'s
 * ({@code <entity-pkg>.prompts}) so the payload record import is implicit
 * (same-package reference).
 *
 * <p><b>Tolerant extract — two flavours (FR-010 / FR-011 + Plan 2.1).</b> For
 * {@code @format: json|xml} outputs the parser also emits tolerant best-effort
 * {@code extractLenient(...)} entry points (never-throwing; lost/malformed components
 * are null in the typed payload + classified in the report):
 * <ul>
 *   <li><b>Self-contained</b> {@code extractLenient(String[, ExtractOptions])} — drives
 *       a baked {@link com.metaobjects.render.extract.ExtractSchema} literal +
 *       {@code ExtractMap} reads. No runtime loader needed, but it does NOT
 *       populate nested-object / array-of-object components (those stay null —
 *       the historical FR-010 gap). Kept for back-compat callers that have no
 *       {@code MetaDataLoader} and only need the scalar/enum surface.</li>
 *   <li><b>Runtime-delegating</b> {@code extractLenient(MetaDataLoader, String[, ExtractOptions])}
 *       — resolves this payload's {@code MetaObject} by its baked FQN from the
 *       supplied loader and delegates to
 *       {@link com.metaobjects.object.extract.MetaObjectExtractor}, which assembles
 *       the full object graph (nested objects + arrays-of-objects + enum coercion
 *       + generalized {@code @default}) reflection-free via the Phase A object
 *       model. The assembled {@code ValueObject} graph (a {@code Map<String,Object>})
 *       is then mapped into the typed payload record graph by generated
 *       {@code from<Payload>(Map)} helpers. This is the codegen-wrapping-runtime
 *       pattern (a generated DAO calling OMDB) and CLOSES the nested gap.</li>
 * </ul>
 *
 * <p><b>Consumer dependency (delegating extract).</b> The runtime-delegating
 * {@code extractLenient(MetaDataLoader, ...)} overload references
 * {@code com.metaobjects.object.extract.MetaObjectExtractor} (module
 * {@code metaobjects-om}) and {@code com.metaobjects.loader.MetaDataLoader}
 * ({@code metaobjects-metadata}) in addition to the {@code metaobjects-render}
 * extract engine. Consumers wanting nested extraction must have {@code metaobjects-om}
 * (which transitively brings {@code render} + {@code metadata}) on the classpath.
 * The self-contained {@code extractLenient(String)} needs only {@code metaobjects-render}.
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

        // Stable name order — matches the other ports' deterministic emission.
        List<MetaTemplate> outputs = new ArrayList<>();
        for (MetaData child : loader.getRoot().getChildren()) {
            if (child instanceof MetaTemplate t && TemplateConstants.SUBTYPE_OUTPUT.equals(t.getSubType())) {
                outputs.add(t);
            }
        }
        outputs.sort((a, b) -> a.getName().compareTo(b.getName()));

        for (MetaTemplate tmpl : outputs) {
            emit(tmpl, loader, outRoot);
        }
    }

    protected void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot) {
        String payloadRef = template.getPayloadRef();
        if (payloadRef == null || payloadRef.isEmpty()) {
            return; // loader validation normally catches this first
        }
        MetaObject payloadVo = resolveValueObject(loader, payloadRef);
        if (payloadVo == null) {
            return; // not a VO — same contract as SpringPayloadGenerator
        }

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = templatePkg.isEmpty() ? "prompts" : templatePkg + ".prompts";
        // PascalCase the class names — templates authored in camelCase
        // (e.g. `npcTurn`) yield Java-idiomatic `NpcTurnParser` /
        // `NpcTurnPayload`. Pairs with SpringPayloadGenerator's matching
        // capitalisation so the parser's payload-class reference stays
        // consistent.
        String capitalized = capitalizeFirst(templateShort);
        String parserClass = capitalized + "Parser";
        String payloadClass = capitalized + "Payload";

        StringBuilder src = new StringBuilder();
        src.append("// GENERATED — DO NOT EDIT — parser for template.output `")
           .append(template.getName()).append("`\n");
        src.append("package ").append(outPkg).append(";\n\n");
        src.append("import com.fasterxml.jackson.core.JsonProcessingException;\n");
        src.append("import com.fasterxml.jackson.databind.ObjectMapper;\n");
        String format = template.getFormat();
        boolean emitExtractLenient = TemplateConstants.FORMAT_JSON.equalsIgnoreCase(format)
            || TemplateConstants.FORMAT_XML.equalsIgnoreCase(format);
        if (emitExtractLenient) {
            src.append("import com.metaobjects.render.extract.FieldKind;\n");
            src.append("import com.metaobjects.render.extract.FieldSpec;\n");
            src.append("import com.metaobjects.render.extract.Format;\n");
            src.append("import com.metaobjects.render.extract.Extract;\n");
            src.append("import com.metaobjects.render.extract.ExtractMap;\n");
            src.append("import com.metaobjects.render.extract.ExtractSchema;\n");
        }
        src.append("\n");
        src.append("/** Parser for LLM responses matching the `")
           .append(templateShort).append("` template.output. */\n");
        src.append("public final class ").append(parserClass).append(" {\n\n");
        src.append("    private static final ObjectMapper MAPPER = new ObjectMapper();\n\n");
        src.append("    private ").append(parserClass).append("() { /* no instances */ }\n\n");
        src.append("    /**\n");
        src.append("     * Parse an LLM response into a typed {@link ")
           .append(payloadClass).append("}.\n");
        src.append("     *\n");
        src.append("     * @throws JsonProcessingException when the input is not valid JSON for the payload schema.\n");
        src.append("     */\n");
        src.append("    public static ").append(payloadClass).append(" parse(String text) throws JsonProcessingException {\n");
        src.append("        return MAPPER.readValue(text, ").append(payloadClass).append(".class);\n");
        src.append("    }\n");
        if (emitExtractLenient) {
            String schemaLit = ExtractSchemaEmitter.schemaLiteral(payloadVo, format, payloadClass);
            String ctorArgs = ExtractSchemaEmitter.constructorArgs(payloadVo, payloadClass);
            String formatEnum = TemplateConstants.FORMAT_XML.equalsIgnoreCase(format)
                ? "Format.XML" : "Format.JSON";
            String payloadFqn = payloadVo.getName();

            // ---- Self-contained, scalar/enum-only extract (back-compat; nested stays null) ----
            src.append("\n");
            src.append("    private static final ExtractSchema EXTRACT_SCHEMA =\n");
            src.append("        ").append(schemaLit).append(";\n");
            src.append("\n");
            src.append("    /**\n");
            src.append("     * Self-contained tolerant extraction; never throws. Components are null where\n");
            src.append("     * lost/malformed. Does NOT populate nested-object / array-of-object components\n");
            src.append("     * (use the {@code extractLenient(MetaDataLoader, String)} overload for full nested extraction).\n");
            src.append("     */\n");
            src.append("    public static com.metaobjects.render.extract.ExtractionResult<").append(payloadClass).append("> extractLenient(String text) {\n");
            src.append("        return extractLenient(text, com.metaobjects.render.extract.ExtractOptions.defaults());\n");
            src.append("    }\n");
            src.append("\n");
            src.append("    public static com.metaobjects.render.extract.ExtractionResult<").append(payloadClass).append("> extractLenient(String text, com.metaobjects.render.extract.ExtractOptions opts) {\n");
            src.append("        com.metaobjects.render.extract.ExtractionOutcome o = Extract.extract(text, EXTRACT_SCHEMA, opts);\n");
            src.append("        java.util.Map<String, Object> d = o.data();\n");
            src.append("        ").append(payloadClass).append(" data = new ").append(payloadClass).append("(\n");
            src.append("                ").append(ctorArgs).append(");\n");
            src.append("        return new com.metaobjects.render.extract.ExtractionResult<>(data, o.report());\n");
            src.append("    }\n");

            // ---- Runtime-delegating extract (closes the nested gap, Plan 2.1) ----
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
            src.append("        // ValueObjects / List<ValueObject> — map it into the typed payload record graph.\n");
            src.append("        @SuppressWarnings(\"unchecked\")\n");
            src.append("        java.util.Map<String, Object> d = (java.util.Map<String, Object>) raw.data();\n");
            src.append("        return new com.metaobjects.render.extract.ExtractionResult<>(from").append(payloadClass).append("(d), raw.report());\n");
            src.append("    }\n");

            // ---- Generated ValueObject(Map) -> typed-record mappers (payload + nested, deduped) ----
            emitMapperMethods(src, payloadVo, loader, payloadClass);
            appendMapperHelpers(src);
        }
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve(parserClass + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + parserClass + ".java for template " + template.getName() + ": " + e, e);
        }
    }

    /**
     * Emit one {@code private static <PayloadClass> from<PayloadClass>(Map<String,Object> d)}
     * mapper per value-object reachable from {@code rootVo} (the payload + every nested VO),
     * deduped by FQN. Each mapper reconstructs the typed record from an assembled
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
    protected void emitMapperMethods(StringBuilder src, MetaObject rootVo,
                                   MetaDataLoader loader, String rootPayloadClass) {
        Set<String> emitted = new LinkedHashSet<>();
        emitMapper(src, rootVo, loader, rootPayloadClass, emitted);
    }

    protected void emitMapper(StringBuilder src, MetaObject vo, MetaDataLoader loader,
                            String payloadClass, Set<String> emitted) {
        if (!emitted.add(vo.getName())) {
            return; // already emitted (dedupe + cycle guard)
        }

        // Discover nested mappers to emit AFTER this one (declaration order is irrelevant
        // for static methods, but keeping a stable post-order is tidy + deterministic).
        List<MetaObject> nestedVos = new ArrayList<>();

        StringBuilder body = new StringBuilder();
        body.append("\n");
        body.append("    /** Map an assembled ValueObject (Map) into a typed {@link ")
            .append(payloadClass).append("}. Generated; null-tolerant. */\n");
        body.append("    private static ").append(payloadClass)
            .append(" from").append(payloadClass).append("(java.util.Map<String, Object> d) {\n");
        body.append("        if (d == null) return null;\n");
        body.append("        return new ").append(payloadClass).append("(\n");

        List<MetaField> fields = new ArrayList<>(vo.getMetaFields());
        for (int i = 0; i < fields.size(); i++) {
            MetaField<?> field = fields.get(i);
            String arg = mapperArgForField(field, vo, payloadClass, loader, nestedVos);
            body.append("                ").append(arg);
            if (i < fields.size() - 1) body.append(',');
            body.append('\n');
        }
        body.append("        );\n");
        body.append("    }\n");
        src.append(body);

        // Recurse into nested payloads (post-order, deduped).
        for (MetaObject nested : nestedVos) {
            String nestedClass = nestedPayloadClass(nested);
            emitMapper(src, nested, loader, nestedClass, emitted);
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
                                     MetaDataLoader loader, List<MetaObject> nestedVos) {
        String name = field.getName();

        // Nested object / array-of-objects (but NOT enum, which is a string-backed scalar).
        boolean isObjectField = field instanceof ObjectField || MetaDataUtil.hasObjectRef(field);
        if (isObjectField && !(field instanceof EnumField)) {
            MetaObject target = MetaDataUtil.getObjectRef(field);
            if (target != null && MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) {
                nestedVos.add(target);
                String nestedClass = nestedPayloadClass(target);
                if (field.isArrayType()) {
                    // List<NestedPayload>: map each element Map; the assembled value is a List.
                    // from<Nested> is a static method in scope within this generated parser class.
                    return "mapObjectList(d, \"" + name + "\", m -> from" + nestedClass + "(m))";
                }
                // Single nested object: cast the element to a Map and recurse.
                return "from" + nestedClass + "(asMap(d.get(\"" + name + "\")))";
            }
            // Non-VO target / unresolved ref — defensive: leave null (matches payload-VO contract).
            return "null";
        }

        // Enum fields: the assembled value is a validated member string; the STRICT payload
        // component is the generated nested Java enum. Bridge string → enum via
        // `<Payload>.<Enum>.valueOf(s)` (per-element for arrays, dropping nulls). Checked BEFORE
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
            // lenient payload rather than NPE-ing on Enum.valueOf(null).
            return "java.util.Optional.ofNullable(ExtractMap.asString(d, \"" + name + "\"))"
                + ".map(" + enumType + "::valueOf).orElse(null)";
        }

        // Scalar arrays.
        if (field.isArrayType()) {
            return "ExtractMap.asStringList(d, \"" + name + "\")";
        }

        // Scalars.
        if (field instanceof com.metaobjects.field.IntegerField) return "ExtractMap.asInt(d, \"" + name + "\")";
        if (field instanceof com.metaobjects.field.LongField)    return "ExtractMap.asLong(d, \"" + name + "\")";
        if (field instanceof com.metaobjects.field.DoubleField)  return "ExtractMap.asDouble(d, \"" + name + "\")";
        if (field instanceof com.metaobjects.field.BooleanField) return "ExtractMap.asBool(d, \"" + name + "\")";
        return "ExtractMap.asString(d, \"" + name + "\")";
    }

    /** {@code <CapitalizedShortName>Payload} — mirrors {@link SpringPayloadGenerator}'s nested naming. */
    protected static String nestedPayloadClass(MetaObject vo) {
        return capitalizeFirst(SpringNaming.splitFqn(vo.getName())[1]) + "Payload";
    }

    /**
     * Append the two shared private-static helpers the runtime-delegating mappers rely on:
     * {@code asMap} (null-tolerant {@code Object -> Map<String,Object>} cast) and
     * {@code mapObjectList} (map each element of an assembled {@code List} via a per-element
     * function, skipping non-Map elements). Emitted once per parser class.
     */
    protected static void appendMapperHelpers(StringBuilder src) {
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
    }

    /**
     * Uppercase the first character of {@code s}; pass through unchanged when
     * empty or already capitalised. Pairs with {@link SpringPayloadGenerator}'s
     * matching helper so the {@code <PayloadClass>} reference in the parser
     * matches the actual generated file name.
     */
    private static String capitalizeFirst(String s) {
        if (s == null || s.isEmpty()) return s;
        char c0 = s.charAt(0);
        if (Character.isUpperCase(c0)) return s;
        return Character.toUpperCase(c0) + s.substring(1);
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

    /** Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities). */
    protected static MetaObject resolveValueObject(MetaDataLoader loader, String ref) {
        for (MetaObject obj : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) continue;
            if (obj.getName().equals(ref)) return obj;
            String[] split = SpringNaming.splitFqn(obj.getName());
            if (split[1].equals(ref)) return obj;
        }
        return null;
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
        return capitalizeFirst(SpringNaming.splitFqn(md.getName())[1]) + "Parser.java";
    }
}
