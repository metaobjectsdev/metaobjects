package com.metaobjects.mojo;

import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugin.logging.SystemStreamLog;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * {@code metaobjects:verify} — the requirement gate, end to end: the diagnostics, the summary
 * and the failure. The codes, paths and message text are gated cross-port by
 * {@code RequirementCheckConformanceTest} in the metadata module; this proves the goal runs
 * the gate, prints what it found, and fails the build on an error and on nothing else.
 */
public class MetaDataVerifyRequirementsTest {

    private static final String PREFIX = "metaobjects:verify — ";

    /** Every line the goal logs, at every level, in order. */
    private static final class CapturingLog extends SystemStreamLog {
        final List<String> infos = new ArrayList<>();
        final List<String> warnings = new ArrayList<>();
        final List<String> errors = new ArrayList<>();

        @Override public void info(CharSequence content) { infos.add(content.toString()); }
        @Override public void warn(CharSequence content) { warnings.add(content.toString()); }
        @Override public void error(CharSequence content) { errors.add(content.toString()); }

        List<String> all() {
            List<String> all = new ArrayList<>(infos);
            all.addAll(warnings);
            all.addAll(errors);
            return all;
        }

        long count(String fragment) {
            return all().stream().filter(l -> l.contains(fragment)).count();
        }
    }

    /** A mojo whose environment the test controls. */
    private static final class TestMojo extends MetaDataVerifyMojo {
        private final Function<String, String> env;

        TestMojo(Function<String, String> env) { this.env = env; }

        @Override String getEnv(String name) { return env.apply(name); }
    }

    private static final String ORDER_ENTITY = """
        { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } } ] } }""";

    private static String requirement(String name, String status, String implementedBy) {
        return """
            { "requirement.functional": { "name": "%s", "@level": 4, "@status": "%s",
                "@statement": "An order is recorded.", "@counterexample": "A placed order has no row."%s } }"""
            .formatted(name, status, implementedBy == null ? "" : ", \"@implementedBy\": [\"" + implementedBy + "\"]");
    }

    private static Path model(String... children) throws IOException {
        Path dir = Files.createTempDirectory("verify-requirements");
        dir.toFile().deleteOnExit();
        Path file = dir.resolve("meta.app.json");
        file.toFile().deleteOnExit();
        Files.writeString(file, "{ \"metadata.root\": { \"package\": \"acme::shop\", \"children\": [\n"
            + String.join(",\n", children) + "\n] } }", StandardCharsets.UTF_8);
        return dir;
    }

    /** One goal run: everything it logged, and the failure it ended in, if any. */
    private record Run(CapturingLog log, MojoFailureException failure) {}

    private static Run run(Path dir, String mode, boolean requireImplementers,
                           Function<String, String> env) throws Exception {
        TestMojo mojo = new TestMojo(env);
        mojo.setLoader(LoaderParam.builder("verify-requirements-test")
            .withClassname("com.metaobjects.loader.MetaDataLoader")
            .withSourceDir(dir.toString())
            .withSource("meta.app.json")
            .build());
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
        mojo.setMode(mode);
        mojo.setTemplateRoot(Files.createTempDirectory("verify-requirements-templates").toString());
        mojo.setRequireImplementers(requireImplementers);
        CapturingLog log = new CapturingLog();
        mojo.setLog(log);
        try {
            mojo.execute();
            return new Run(log, null);
        } catch (MojoFailureException e) {
            return new Run(log, e);
        }
    }

    private static final Function<String, String> NO_ENV = name -> null;

    @Test
    public void aModelWithNoRequirementLogsNothingAndDoesNotFail() throws Exception {
        for (String mode : new String[]{"templates", "codegen"}) {
            Run run = run(model(ORDER_ENTITY), mode, false, NO_ENV);
            assertNull(mode, run.failure());
            assertEquals(mode + ": " + run.log().all(), 0,
                run.log().all().stream().filter(l -> l.contains("requirements:") || l.contains("_REQUIREMENT_")).count());
            assertTrue(mode + ": " + run.log().errors, run.log().errors.isEmpty());
        }
    }

    @Test
    public void aDanglingLiveReferenceFailsTheBuildAfterLoggingTheCodePathAndSummary() throws Exception {
        Run run = run(model(ORDER_ENTITY, requirement("Recorded", "live", "Ordr")), "templates", false, NO_ENV);
        assertNotNull("the build must fail", run.failure());
        assertTrue(run.log().errors.toString(), run.log().errors.contains(
            "  ERR_REQUIREMENT_DANGLING_REF [Recorded]: 'Ordr' does not resolve in the loaded model "
                + "(status 'live' \u2014 the model moved and the requirement is stale)."));
        assertTrue(run.log().infos.toString(), run.log().infos.contains(PREFIX
            + "requirements: 1 entries (1 functional, 0 architectural) \u2014 1 live; "
            + "0/1 entities claimed, counted over 1 metadata file(s)."));
        assertTrue(run.log().errors.toString(), run.log().errors.contains(PREFIX + "requirements: 1 error(s)."));
    }

    @Test
    public void warningsAloneDoNotFailTheBuild() throws Exception {
        // A live L4 that names nothing: WARN_REQUIREMENT_NOTHING_IMPLEMENTS, and Order is unclaimed.
        Run run = run(model(ORDER_ENTITY, requirement("Recorded", "live", null)), "templates", false, NO_ENV);
        assertNull(run.failure());
        assertTrue(run.log().warnings.toString(), run.log().warnings.stream().anyMatch(
            w -> w.startsWith("  WARN_REQUIREMENT_NOTHING_IMPLEMENTS [Recorded]: ")));
        assertTrue(run.log().warnings.toString(), run.log().warnings.stream().anyMatch(
            w -> w.startsWith("  WARN_REQUIREMENT_OBJECT_UNCLAIMED: no requirement claims 'acme::shop::Order'.")));
        assertTrue(run.log().errors.toString(), run.log().errors.isEmpty());
    }

    @Test
    public void requireImplementersTurnsTheNothingImplementsWarningIntoAFailure() throws Exception {
        Path dir = model(ORDER_ENTITY, requirement("Recorded", "live", null));

        Run byParameter = run(dir, "templates", true, NO_ENV);
        assertNotNull("the parameter must fail the build", byParameter.failure());
        assertTrue(byParameter.log().errors.toString(), byParameter.log().errors.stream().anyMatch(
            e -> e.startsWith("  WARN_REQUIREMENT_NOTHING_IMPLEMENTS [Recorded]: ")));
        assertTrue(byParameter.log().errors.toString(),
            byParameter.log().errors.contains(PREFIX + "requirements: 1 error(s)."));
        // Only that one code is raised: the other warning keeps its severity.
        assertTrue(byParameter.log().warnings.toString(), byParameter.log().warnings.stream().anyMatch(
            w -> w.startsWith("  WARN_REQUIREMENT_OBJECT_UNCLAIMED: ")));

        assertNotNull("META_REQUIRE_IMPLEMENTERS=1 must fail the build",
            run(dir, "templates", false, name -> "META_REQUIRE_IMPLEMENTERS".equals(name) ? "1" : null).failure());
        assertNull("only the value 1 turns the switch on",
            run(dir, "templates", false, name -> "META_REQUIRE_IMPLEMENTERS".equals(name) ? "0" : null).failure());
    }

    @Test
    public void theGateRunsOnceWhicheverGateTheModeRan() throws Exception {
        Path dir = model(ORDER_ENTITY, requirement("Recorded", "live", "Order"));
        for (String mode : new String[]{"templates", "codegen"}) {
            Run run = run(dir, mode, false, NO_ENV);
            assertNull(mode, run.failure());
            assertEquals(mode + ": " + run.log().all(), 1, run.log().count(PREFIX + "requirements: 1 entries"));
        }
    }

    @Test
    public void aRequirementErrorStillFailsTheBuildInCodegenMode() throws Exception {
        Run run = run(model(ORDER_ENTITY, requirement("Recorded", "live", "Ordr")), "codegen", false, NO_ENV);
        assertNotNull("the build must fail", run.failure());
        assertEquals(run.log().all().toString(), 1, run.log().count(PREFIX + "requirements: 1 error(s)."));
    }
}
