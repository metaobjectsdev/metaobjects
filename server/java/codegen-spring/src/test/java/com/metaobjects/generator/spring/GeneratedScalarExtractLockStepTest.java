package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * The generated extract mapper and the response record it constructs must agree on the Java
 * type of EVERY scalar field subtype, in the single AND the scalar-array position.
 *
 * <p>They did not, and the divergence is structural rather than a one-off: the response record
 * types its components through {@code SpringTypeMapper.javaTypeName} — which is richly
 * kind-typed ({@code BigDecimal}, {@code LocalDate}, {@code Instant}, {@code UUID},
 * {@code URI}, {@code InetAddress}, {@code Float}) — while
 * {@code SpringOutputParserGenerator.mapperArgForField} recognised only Integer/Long/Double/
 * Boolean and fell through to {@code ExtractMap.asString} for everything else, with every
 * scalar array going to {@code ExtractMap.asStringList}. Each mismatch is
 * <em>incompatible types</em> at compile time.
 *
 * <p>No {@code field.decimal} — nor any date, time, timestamp, uuid, uri or inet — appeared
 * anywhere in this module's test payloads, which is the only reason a gap this wide shipped.
 *
 * <p>One payload PER SUBTYPE, deliberately: javac reports only the FIRST incompatible argument
 * of a constructor invocation, so a fixture carrying every subtype in one record would report
 * one error and hide the rest. That masking is exactly what made this look like a
 * decimal-only defect when it was first reported.
 */
public class GeneratedScalarExtractLockStepTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /**
     * Every scalar {@code field.*} subtype a responding payload can carry. Structural subtypes
     * (object/map) are excluded — they route through the nested-payload arm, not a scalar reader.
     */
    private static final List<String> SCALAR_SUBTYPES = List.of(
            "string", "int", "long", "double", "float", "decimal", "boolean",
            "date", "time", "timestamp", "currency", "enum", "uuid", "uri", "inet");

    private static String fixture(String subType, boolean isArray) {
        String arr = isArray ? ", \"isArray\": true" : "";
        String extra = "enum".equals(subType) ? ", \"@values\": [\"A\", \"B\"]" : "";
        return """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "ProbePayload", "children": [
                { "field.string": { "name": "ref", "@required": true } },
                { "field.__ST__": { "name": "v"__ARR____EXTRA__ } }
            ] } },
            { "template.prompt": {
                "name": "Probe",
                "@payloadRef": "ProbePayload",
                "@responseRef": "ProbePayload",
                "@textRef": "ai/probe",
                "@format": "text",
                "@responseFormat": "json"
            } }
          ] }
        }
        """.replace("__ST__", subType).replace("__ARR__", arr).replace("__EXTRA__", extra);
    }

    @Test
    public void everyScalarSubtypeCompilesAsASingleComponent() throws Exception {
        assertAllCompile(false);
    }

    @Test
    public void everyScalarSubtypeCompilesAsAnArrayComponent() throws Exception {
        assertAllCompile(true);
    }

    private void assertAllCompile(boolean isArray) throws Exception {
        Map<String, String> failures = new LinkedHashMap<>();
        for (String subType : SCALAR_SUBTYPES) {
            String err = compileFor(subType, isArray);
            if (err != null) failures.put(subType, err);
        }
        if (!failures.isEmpty()) {
            StringBuilder sb = new StringBuilder(
                    "generated extract mapper does not compile for "
                    + failures.size() + " of " + SCALAR_SUBTYPES.size() + " scalar subtypes ("
                    + (isArray ? "ARRAY" : "SINGLE") + " position):\n");
            failures.forEach((st, e) -> sb.append("  field.").append(st).append(" -> ").append(e).append('\n'));
            fail(sb.toString());
        }
    }

    /** Generate + compile for one subtype; returns null on success, else the first error message. */
    private String compileFor(String subType, boolean isArray) throws Exception {
        String tag = subType + (isArray ? "-arr" : "-one");
        Path gen = tmp.newFolder("gen-" + tag).toPath();
        Path ws  = tmp.newFolder("ws-" + tag).toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "probe-" + tag, fixture(subType, isArray));

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());

        SpringPayloadGenerator payloadGen = new SpringPayloadGenerator();
        payloadGen.setArgs(args);
        payloadGen.execute(loader);

        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator();
        parserGen.setArgs(args);
        parserGen.execute(loader);

        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files for field." + subType, sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-" + tag).toPath();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of(
                "-classpath", System.getProperty("java.class.path"),
                "-d", classes.toString());

        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (ok) return null;

        List<String> msgs = new ArrayList<>();
        for (var d : diags.getDiagnostics()) {
            if (d.getKind() == javax.tools.Diagnostic.Kind.ERROR) msgs.add(d.getMessage(null));
        }
        return msgs.isEmpty() ? "compile failed with no ERROR diagnostic" : msgs.get(0);
    }
}
