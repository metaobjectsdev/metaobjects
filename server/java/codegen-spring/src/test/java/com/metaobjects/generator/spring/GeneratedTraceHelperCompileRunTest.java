package com.metaobjects.generator.spring;

import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * Gate for {@link LlmTraceHelperGenerator} (Slice 2): the per-entity Java
 * {@code <Entity>TraceHelper} with {@code record<Entity>(...)}.
 *
 * <p>Builds a small model — an abstract {@code LlmCallBase} (the 18 base fields),
 * a response {@code object.value}, and a concrete entity that {@code extends}
 * {@code LlmCallBase}, nests a {@code template.prompt} with {@code @responseRef},
 * and declares typed {@code voRequest}/{@code voResponse} {@code field.object}
 * columns (Slice 3 derivation isn't built yet, so they're declared explicitly).</p>
 *
 * <p>Then it (1) string-asserts the emitted structure ({@code record<Entity>},
 * the typed result record, the extract call, the {@code buildLlmCallRow} call, the
 * voRequest/voResponse sets, the recorder persist) AND (2) COMPILES the emitted
 * Java in-memory — {@code omdb} (and transitively {@code om}/{@code render}) is on
 * the test classpath, so the helper's FQN references to the Slice-1 recorder + the
 * runtime extract resolve. Also asserts the helper is SKIPPED for an entity whose
 * prompt has no {@code @responseRef}, and for an entity that does not derive from
 * {@code LlmCallBase}.</p>
 */
public class GeneratedTraceHelperCompileRunTest {

    private static final String PKG = "acme::ai";

    /**
     * Model: LlmCallBase (18 base fields, abstract) + GreetRequest/GreetResponse VOs
     * + a concrete GreetingCall extending LlmCallBase with a nested template.prompt
     * carrying @responseRef + typed voRequest/voResponse object columns.
     */
    private static final String META = "{ \"metadata.root\": {"
        + "  \"package\": \"" + PKG + "\","
        + "  \"children\": ["
        + "    { \"object.entity\": { \"name\": \"LlmCallBase\", \"abstract\": true, \"children\": ["
        + "      { \"field.uuid\":      { \"name\": \"traceId\" } },"
        + "      { \"field.uuid\":      { \"name\": \"spanId\" } },"
        + "      { \"field.uuid\":      { \"name\": \"parentSpanId\" } },"
        + "      { \"field.string\":    { \"name\": \"sessionId\" } },"
        + "      { \"field.string\":    { \"name\": \"callType\" } },"
        + "      { \"field.string\":    { \"name\": \"system\" } },"
        + "      { \"field.string\":    { \"name\": \"requestModel\" } },"
        + "      { \"field.string\":    { \"name\": \"responseModel\" } },"
        + "      { \"field.int\":       { \"name\": \"inputTokens\" } },"
        + "      { \"field.int\":       { \"name\": \"outputTokens\" } },"
        + "      { \"field.currency\":  { \"name\": \"costMinor\", \"@currency\": \"USD\" } },"
        + "      { \"field.int\":       { \"name\": \"latencyMs\" } },"
        + "      { \"field.string\":    { \"name\": \"finishReason\" } },"
        + "      { \"field.string\":    { \"name\": \"status\" } },"
        + "      { \"field.string\":    { \"name\": \"errorDetail\" } },"
        + "      { \"field.timestamp\": { \"name\": \"startedAt\" } },"
        + "      { \"field.string\":    { \"name\": \"llmRequest\",  \"@dbColumnType\": \"jsonb\" } },"
        + "      { \"field.string\":    { \"name\": \"llmResponse\", \"@dbColumnType\": \"jsonb\" } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"GreetRequest\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"name\", \"@required\": true } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"GreetResponse\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"greeting\", \"@required\": true } },"
        + "      { \"field.int\":    { \"name\": \"score\" } }"
        + "    ]}},"
        + "    { \"object.entity\": { \"name\": \"GreetingCall\","
        + "      \"extends\": \"" + PKG + "::LlmCallBase\", \"children\": ["
        + "      { \"source.rdb\":      { \"@table\": \"llm_call\", \"@role\": \"primary\" } },"
        + "      { \"identity.primary\": { \"name\": \"primary\", \"@fields\": [\"spanId\"] } },"
        + "      { \"field.object\": { \"name\": \"voRequest\",  \"@column\": \"voRequest\","
        + "                            \"@storage\": \"jsonb\", \"@objectRef\": \"" + PKG + "::GreetRequest\" } },"
        + "      { \"field.object\": { \"name\": \"voResponse\", \"@column\": \"voResponse\","
        + "                            \"@storage\": \"jsonb\", \"@objectRef\": \"" + PKG + "::GreetResponse\" } },"
        + "      { \"template.prompt\": { \"name\": \"greetingPrompt\","
        + "                              \"@payloadRef\": \"" + PKG + "::GreetRequest\","
        + "                              \"@responseRef\": \"" + PKG + "::GreetResponse\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void emitsRecordHelperAndCompiles() throws Exception {
        MetaDataLoader loader = newLoader("trace-emit", META);

        MetaObject call = loader.getMetaObjectByName(PKG + "::GreetingCall");
        assertNotNull("GreetingCall must load", call);

        Path gen = tmp.newFolder("gen").toPath();
        LlmTraceHelperGenerator generator = new LlmTraceHelperGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        generator.setArgs(args);
        generator.execute(loader);

        Path helper = gen.resolve("acme/ai/GreetingCallTraceHelper.java");
        assertTrue("GreetingCallTraceHelper.java must be emitted at " + helper, Files.exists(helper));
        String src = Files.readString(helper);

        // --- structure assertions (mirror the TS trace-helper test) ---
        assertTrue("package", src.contains("package acme.ai;"));
        assertTrue("final class", src.contains("public final class GreetingCallTraceHelper"));
        assertTrue("typed result record",
            src.contains("public record GreetingCallTraceResult("));
        assertTrue("record<Entity> method",
            src.contains("public static GreetingCallTraceResult recordGreetingCall("));
        // takes loader + recorder + LlmCallInput
        assertTrue("loader param", src.contains("com.metaobjects.loader.MetaDataLoader loader"));
        assertTrue("recorder param",
            src.contains("com.metaobjects.manager.db.ai.LlmCallRecorder recorder"));
        assertTrue("input param",
            src.contains("com.metaobjects.manager.db.ai.LlmCallInput input"));
        // resolves both MetaObjects by their baked FQNs
        assertTrue("resolves trace MO", src.contains("getMetaObjectByName(\"acme::ai::GreetingCall\")"));
        assertTrue("resolves response MO", src.contains("getMetaObjectByName(\"acme::ai::GreetResponse\")"));
        // runtime extract + lost-required gate
        assertTrue("extract call",
            src.contains("com.metaobjects.object.extract.MetaObjectExtractor.extract(responseMo, input.llmResponseText())"));
        assertTrue("lost-required gate", src.contains("hasLostRequired()"));
        // base row builder
        assertTrue("buildLlmCallRow call",
            src.contains("com.metaobjects.manager.db.ai.LlmTraceRowBuilder.buildLlmCallRow(traceMo, effective)"));
        // typed columns set via the field SPI
        assertTrue("voRequest set", src.contains("getMetaField(\"voRequest\").setObject(row, input.llmRequest())"));
        assertTrue("voResponse set", src.contains("getMetaField(\"voResponse\").setObject(row, voResponse)"));
        // persist once via recorder
        assertTrue("recorder persist", src.contains("recorder.record(row);"));
        // record<Entity> only — no call<Entity>
        assertFalse("call<Entity> must NOT be emitted (BYO caller)", src.contains("callGreetingCall"));

        // --- compile the emitted Java in-memory (omdb + om + render on test classpath) ---
        compileGenerated(gen);
    }

    @Test
    public void skipsEntityWithoutResponseRef() throws Exception {
        // Same model but the prompt drops @responseRef → no helper. The prompt's
        // @responseRef clause is the trailing comma-attr before the closing braces.
        // Replace the @payloadRef-comma + @responseRef tail with just @payloadRef + close.
        String withResponseRef =
            "\"@payloadRef\": \"" + PKG + "::GreetRequest\","
            + "                              \"@responseRef\": \"" + PKG + "::GreetResponse\" } }";
        assertTrue("fixture must contain the @responseRef tail to remove",
            META.contains(withResponseRef));
        String meta = META.replace(withResponseRef,
            "\"@payloadRef\": \"" + PKG + "::GreetRequest\" } }");
        assertFalse("fixture must no longer declare @responseRef", meta.contains("@responseRef"));
        MetaDataLoader loader = newLoader("trace-skip-noref", meta);

        Path gen = tmp.newFolder("gen-noref").toPath();
        LlmTraceHelperGenerator generator = new LlmTraceHelperGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        generator.setArgs(args);
        generator.execute(loader);

        assertFalse("no helper when prompt has no @responseRef",
            Files.exists(gen.resolve("acme/ai/GreetingCallTraceHelper.java")));
    }

    @Test
    public void skipsEntityNotDerivedFromLlmCallBase() throws Exception {
        String meta = "{ \"metadata.root\": {"
            + "  \"package\": \"" + PKG + "\","
            + "  \"children\": ["
            + "    { \"object.value\": { \"name\": \"PlainResponse\", \"children\": ["
            + "      { \"field.string\": { \"name\": \"text\", \"@required\": true } }"
            + "    ]}},"
            + "    { \"object.entity\": { \"name\": \"PlainEntity\", \"children\": ["
            + "      { \"source.rdb\":      { \"@table\": \"plain\", \"@role\": \"primary\" } },"
            + "      { \"identity.primary\": { \"name\": \"primary\", \"@fields\": [\"id\"] } },"
            + "      { \"field.string\": { \"name\": \"id\", \"@required\": true } },"
            + "      { \"template.prompt\": { \"name\": \"p\","
            + "                              \"@payloadRef\": \"" + PKG + "::PlainResponse\","
            + "                              \"@responseRef\": \"" + PKG + "::PlainResponse\" } }"
            + "    ]}}"
            + "  ]"
            + "}}";
        MetaDataLoader loader = newLoader("trace-skip-nobase", meta);

        Path gen = tmp.newFolder("gen-nobase").toPath();
        LlmTraceHelperGenerator generator = new LlmTraceHelperGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        generator.setArgs(args);
        generator.execute(loader);

        assertFalse("no helper for an entity that does not extend LlmCallBase",
            Files.exists(gen.resolve("acme/ai/PlainEntityTraceHelper.java")));
    }

    /**
     * #228 checkpoint 4 — {@code resolveValueObject}'s pre-fix bare-tail-fallback bug
     * (the #219/#244 "wrong node despite a VALID FQN target" pattern): the old
     * implementation checked, PER CANDIDATE in loader iteration order, "does this
     * object's bare short name equal the ref's bare tail?" — so a same-bare-named
     * DECOY {@code object.value} visited BEFORE the true FQN target would win
     * immediately, even though the correctly-FQN-qualified target also exists and
     * loads later. Package {@code acme::other} declares a decoy {@code GreetResponse}
     * (loaded FIRST); {@code acme::ai} declares its OWN {@code GreetResponse} and an
     * FQN {@code @responseRef: "acme::ai::GreetResponse"} that unambiguously names it.
     * Asserts the generated helper derives its typed result record from {@code acme::ai}'s
     * shape ({@code greeting}/{@code score}) — never the decoy's ({@code otherField}).
     */
    @Test
    public void responseRefFqnBindsOwnPackageNotABareTailDecoyLoadedFirst() throws Exception {
        String decoyMeta = "{ \"metadata.root\": {"
            + "  \"package\": \"acme::other\","
            + "  \"children\": ["
            + "    { \"object.value\": { \"name\": \"GreetResponse\", \"children\": ["
            + "      { \"field.string\": { \"name\": \"otherField\", \"@required\": true } }"
            + "    ]}}"
            + "  ]"
            + "}}";

        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "trace-responseref-fqn");
        loader.init();
        // Decoy loads FIRST — under the pre-fix bare-tail-fallback bug this would win.
        loader.load(List.of(
            new InMemoryStringSource(decoyMeta, "trace-responseref-fqn/meta.other.json"),
            new InMemoryStringSource(META, "trace-responseref-fqn/meta.ai.json")));

        Path gen = tmp.newFolder("gen-responseref-fqn").toPath();
        LlmTraceHelperGenerator generator = new LlmTraceHelperGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        generator.setArgs(args);
        generator.execute(loader);

        Path helper = gen.resolve("acme/ai/GreetingCallTraceHelper.java");
        assertTrue("GreetingCallTraceHelper.java must be emitted at " + helper, Files.exists(helper));
        String src = Files.readString(helper);

        // The baked FQN string is the load-bearing proof: LlmTraceHelperGenerator bakes
        // the RESOLVED responseVo's OWN name (not the raw @responseRef attr verbatim), so
        // a pre-fix bare-tail-fallback mis-resolution to the decoy would have baked
        // "acme::other::GreetResponse" here instead.
        assertTrue("must resolve + bake acme::ai's OWN GreetResponse FQN; saw:\n" + src,
            src.contains("getMetaObjectByName(\"acme::ai::GreetResponse\")"));
        assertFalse("must NEVER bind/bake the decoy acme::other::GreetResponse; saw:\n" + src,
            src.contains("acme::other") || src.contains("otherField"));

        // Compile it too — proves the resolved MetaObject is a real, loadable node
        // (not just a text match), same rigor as the other tests in this file.
        compileGenerated(gen);
    }

    // -----------------------------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------------------------

    private MetaDataLoader newLoader(String name, String meta) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, name);
        loader.init();
        loader.load(List.of(new InMemoryStringSource(meta, name + "/meta.json")));
        return loader;
    }

    private void compileGenerated(Path gen) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-" + gen.getFileName()).toPath();
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());

        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated trace helper failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null) {
                    sb.append("    at ").append(d.getSource().getName())
                      .append(':').append(d.getLineNumber()).append('\n');
                }
            }
            for (File src : sources) {
                sb.append("\n=== ").append(src.getName()).append(" ===\n");
                sb.append(Files.readString(src.toPath())).append('\n');
            }
            fail(sb.toString());
        }
    }
}
