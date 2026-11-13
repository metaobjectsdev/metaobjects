package com.metaobjects.mojo;

import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugin.logging.SystemStreamLog;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * {@code metaobjects:verify} - the business-rules gate (ADR-0063), end to end: the summary line,
 * the diagnostics and the failure. The codes, paths and message text are gated cross-port by
 * {@code RulesCheckConformanceTest} in the metadata module.
 */
public class MetaDataVerifyRulesTest {

    private static final String PREFIX = "metaobjects:verify — ";

    private static final class CapturingLog extends SystemStreamLog {
        final List<String> infos = new ArrayList<>();
        final List<String> warnings = new ArrayList<>();
        final List<String> errors = new ArrayList<>();

        @Override public void info(CharSequence c) { infos.add(c.toString()); }
        @Override public void warn(CharSequence c) { warnings.add(c.toString()); }
        @Override public void error(CharSequence c) { errors.add(c.toString()); }
    }

    private static final String PLAIN = """
        { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } } ] } }""";

    /** A lifecycle whose "lost" state nothing reaches, and no operation. */
    private static final String LIFECYCLE = """
        { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "name": "src", "@table": "orders" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            { "field.enum": { "name": "status", "@values": ["draft", "open", "lost"], "@default": "draft",
                "children": [
                  { "transition.action": { "name": "submit", "@from": ["draft"], "@to": "open" } } ] } } ] } }""";

    private static Path model(String settings, String... children) throws Exception {
        Path dir = Files.createTempDirectory("verify-rules");
        dir.toFile().deleteOnExit();
        Files.writeString(dir.resolve("meta.app.json"), "{ \"metadata.root\": { \"package\": \"acme::shop\", \"children\": [\n"
            + String.join(",\n", children) + "\n] } }", StandardCharsets.UTF_8);
        if (settings != null) {
            Files.createDirectories(dir.resolve(".metaobjects"));
            Files.writeString(dir.resolve(".metaobjects/config.json"), settings, StandardCharsets.UTF_8);
        }
        return dir;
    }

    private record Run(CapturingLog log, MojoFailureException failure) {}

    private static Run run(Path dir) throws Exception {
        MetaDataVerifyMojo mojo = new MetaDataVerifyMojo();
        mojo.setLoader(LoaderParam.builder("verify-rules-test")
            .withClassname("com.metaobjects.loader.MetaDataLoader")
            .withSourceDir(dir.toString())
            .withSource("meta.app.json")
            .build());
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
        mojo.setMode("templates");
        mojo.setTemplateRoot(Files.createTempDirectory("verify-rules-templates").toString());
        CapturingLog log = new CapturingLog();
        mojo.setLog(log);
        try {
            mojo.execute();
            return new Run(log, null);
        } catch (MojoFailureException e) {
            return new Run(log, e);
        }
    }

    @Test
    public void aModelWithNoOperationAndNoTransitionLogsNothing() throws Exception {
        Run run = run(model(null, PLAIN));
        assertNull(run.failure());
        assertTrue(run.log().infos.stream().noneMatch(l -> l.contains("rules:")));
    }

    @Test
    public void anUnreachableStateWarnsAndPrintsTheSummaryByDefault() throws Exception {
        Run run = run(model(null, LIFECYCLE));
        assertNull(run.failure());
        assertTrue(run.log().infos.toString(), run.log().infos.contains(
            PREFIX + "rules: 0 operation(s), 1 lifecycle(s) with 1 transition(s)."));
        assertTrue(run.log().warnings.toString(), run.log().warnings.stream().anyMatch(
            w -> w.startsWith("  WARN_LIFECYCLE_UNREACHABLE_STATE [acme::shop::Order.status]: ")));
    }

    @Test
    public void unreachableAsErrorFailsTheBuild() throws Exception {
        Run run = run(model("{ \"schema_version\": 1, \"verify\": { \"lifecycle\": { \"unreachable\": \"error\" } } }", LIFECYCLE));
        assertNotNull("the build must fail", run.failure());
        assertTrue(run.log().errors.toString(), run.log().errors.stream().anyMatch(
            e -> e.startsWith("  WARN_LIFECYCLE_UNREACHABLE_STATE [acme::shop::Order.status]: ")));
        assertTrue(run.log().errors.toString(), run.log().errors.contains(PREFIX + "rules: 1 error(s)."));
    }
}
