package com.metaobjects.mojo;

import org.apache.maven.plugin.logging.SystemStreamLog;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * {@code metaobjects:verify} — the field authoring lint, end to end: logged as warnings in
 * its own section, never failing the build, and muted by {@code meta.verify.noFieldLint}.
 * The finding text is gated cross-port by {@link FieldLintConformanceTest}; this proves
 * the goal runs the lint and that a finding does not throw.
 */
public class MetaDataVerifyFieldLintTest {

    /** Captures the lint's {@code warn} lines so the test can read what the goal logged. */
    private static final class CapturingLog extends SystemStreamLog {
        final List<String> warnings = new ArrayList<>();

        @Override
        public void warn(CharSequence content) {
            // Only the lint's own lines: the goal also warns about things a bare,
            // unconfigured mojo lacks (a MojoExecution phase), which are not under test.
            String line = content.toString();
            if (line.contains("— fields:") || line.startsWith("  WARN_")) warnings.add(line);
        }
    }

    private static Path corpusCase(String name) {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/field-lint-conformance").resolve(name).resolve("input");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError("Could not locate fixtures/field-lint-conformance/" + name);
    }

    private static CapturingLog verify(String corpusCase, boolean noFieldLint) throws Exception {
        MetaDataVerifyMojo mojo = new MetaDataVerifyMojo();
        LoaderParam loader = LoaderParam.builder("verify-field-lint-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(corpusCase(corpusCase).toString())
                .withSource("meta.app.json")
                .build();
        mojo.setLoader(loader);
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
        // The templates gate over a model with no templates is clean, so anything that
        // throws here would be the lint failing the build.
        mojo.setMode("templates");
        mojo.setTemplateRoot(Files.createTempDirectory("verify-field-lint").toString());
        mojo.setNoFieldLint(noFieldLint);
        CapturingLog log = new CapturingLog();
        mojo.setLog(log);
        mojo.execute();
        return log;
    }

    @Test
    public void aMissingReferenceFieldIsAWarningAndTheBuildPasses() throws Exception {
        CapturingLog log = verify("reference-field-missing", false);
        assertEquals("metaobjects:verify — fields: 1 authoring warning(s) (advisory — does not fail the build):",
                log.warnings.get(0));
        assertTrue(log.warnings.get(1), log.warnings.get(1).startsWith(
                "  WARN_REFERENCE_FIELD_NOT_FOUND [acme::app::Item.owner_fk]: "));
    }

    @Test
    public void aDuplicateFieldIsReportedFromTheRawDocument() throws Exception {
        CapturingLog log = verify("duplicate-field-same-subtype", false);
        assertTrue(log.warnings.toString(), log.warnings.stream().anyMatch(
                w -> w.startsWith("  WARN_DUPLICATE_FIELD_NAME [acme::app::Item.label]: ")));
    }

    @Test
    public void cleanMetadataLogsNoSection() throws Exception {
        assertTrue(verify("clean", false).warnings.isEmpty());
    }

    @Test
    public void noFieldLintSilencesIt() throws Exception {
        assertTrue(verify("reference-field-missing", true).warnings.isEmpty());
    }
}
