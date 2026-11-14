package com.metaobjects.mojo;

import org.apache.maven.plugin.logging.SystemStreamLog;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * {@code metaobjects:verify} — the advisory {@code unbounded-list-pages}: a project that generates
 * REST controllers and sets no {@code api.pagination} is told so, as a warning that never fails
 * the build; setting it, or generating no controller, silences it.
 */
public class MetaDataVerifyUnboundedListAdvisoryTest {

    private static final class CapturingLog extends SystemStreamLog {
        final List<String> warnings = new ArrayList<>();

        @Override
        public void warn(CharSequence content) {
            if (content.toString().contains("unbounded-list-pages")) warnings.add(content.toString());
        }
    }

    private static Path cleanCase() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/field-lint-conformance/clean/input");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError("Could not locate fixtures/field-lint-conformance/clean");
    }

    /** A project directory holding the clean model and, when given, a {@code .metaobjects/config.json}. */
    private static Path project(String configJson) throws Exception {
        Path dir = Files.createTempDirectory("verify-unbounded");
        Files.copy(cleanCase().resolve("meta.app.json"), dir.resolve("meta.app.json"));
        if (configJson != null) {
            Files.createDirectories(dir.resolve(".metaobjects"));
            Files.writeString(dir.resolve(".metaobjects/config.json"), configJson);
        }
        return dir;
    }

    private static CapturingLog verify(Path project, boolean generatesRoutes) throws Exception {
        return verify(project, generatesRoutes, false);
    }

    private static CapturingLog verify(Path project, boolean generatesRoutes, boolean noFieldLint) throws Exception {
        MetaDataVerifyMojo mojo = new MetaDataVerifyMojo();
        mojo.setNoFieldLint(noFieldLint);
        mojo.setLoader(LoaderParam.builder("verify-unbounded-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(project.toString())
                .withSource("meta.app.json")
                .build());
        List<GeneratorParam> generators = new ArrayList<>();
        if (generatesRoutes) {
            GeneratorParam g = new GeneratorParam();
            g.setClassname("com.metaobjects.generator.spring.SpringControllerGenerator");
            generators.add(g);
        }
        mojo.setGenerators(generators);
        mojo.setGlobals(java.util.Collections.emptyMap());
        mojo.setMode("templates");
        mojo.setTemplateRoot(Files.createTempDirectory("verify-unbounded-templates").toString());
        CapturingLog log = new CapturingLog();
        mojo.setLog(log);
        mojo.execute();   // an advisory never throws
        return log;
    }

    @Test
    public void controllersWithoutAPageSizeAreAdvisedAndTheBuildPasses() throws Exception {
        CapturingLog log = verify(project("{\"schema_version\": 1}"), true);
        assertEquals(log.warnings.toString(), 1, log.warnings.size());
        assertTrue(log.warnings.get(0), log.warnings.get(0).contains("api.pagination"));
    }

    @Test
    public void aPageSizeSilencesIt() throws Exception {
        String cfg = "{\"schema_version\": 1, \"api\": {\"pagination\": {\"defaultLimit\": 50, \"maxLimit\": 1000}}}";
        assertTrue(verify(project(cfg), true).warnings.isEmpty());
    }

    @Test
    public void noControllerNoAdvisory() throws Exception {
        assertTrue(verify(project("{\"schema_version\": 1}"), false).warnings.isEmpty());
    }

    @Test
    public void turningTheFieldLintOffDoesNotSilenceIt() throws Exception {
        CapturingLog log = verify(project("{\"schema_version\": 1}"), true, true);
        assertEquals(log.warnings.toString(), 1, log.warnings.size());
    }
}
