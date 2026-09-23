package com.metaobjects.mojo;

import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.kotlin.KotlinRenderHelperGenerator;
import com.metaobjects.generator.spring.SpringRenderHelperGenerator;
import com.metaobjects.generator.template.TemplateScopeGenerator;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import java.io.File;
import java.util.Map;

import static org.junit.Assert.assertEquals;

/**
 * A relative path in a generator's {@code <args>} resolves against the MODULE, not the
 * shell. 1.0.5 fixed this for the loader's {@code <sourceDir>} and left generator args on
 * the JVM's working directory, so {@code mvn -f ports/java/pom.xml compile} run from any
 * other directory failed: {@code render-helper drift: ... unresolved (provider returned no
 * text)} for {@code <templateRoot>../../prompts</templateRoot>}, while the same build from
 * the module's own directory passed. {@code outputDir} had the same flaw and wrote the
 * generated tree beside the shell instead of into the module.
 */
public class RelativeGeneratorArgPathsTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private MetaDataGeneratorMojo mojo;
    private File basedir;

    @Before
    public void setUp() throws Exception {
        basedir = tempFolder.newFolder("module");
        mojo = new MetaDataGeneratorMojo();
        mojo.setLoader(new LoaderParam());
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(basedir);
        mojo.project = project;
    }

    private Map<String, String> merged(Map<String, String> args) {
        GeneratorParam p = new GeneratorParam();
        p.setClassname("unused");
        p.setArgs(args);
        return mojo.mergeAndOverwriteArgs(p);
    }

    private String underBasedir(String relative) {
        return basedir.toPath().resolve(relative).normalize().toString();
    }

    @Test
    public void relativePathArgsResolveAgainstTheModuleBasedir() {
        Map<String, String> args = merged(Map.of(
                GeneratorBase.ARG_OUTPUTDIR, "target/generated-sources/java",
                SpringRenderHelperGenerator.ARG_TEMPLATE_ROOT, "../../prompts",
                TemplateScopeGenerator.ARG_TEMPLATES_DIR, "templates"));

        assertEquals(underBasedir("target/generated-sources/java"), args.get(GeneratorBase.ARG_OUTPUTDIR));
        assertEquals(underBasedir("../../prompts"), args.get(SpringRenderHelperGenerator.ARG_TEMPLATE_ROOT));
        assertEquals(underBasedir("templates"), args.get(TemplateScopeGenerator.ARG_TEMPLATES_DIR));
    }

    @Test
    public void absolutePathsAndNonPathArgsAreLeftAlone() throws Exception {
        String abs = tempFolder.newFolder("elsewhere").getAbsolutePath();
        Map<String, String> args = merged(Map.of(
                GeneratorBase.ARG_OUTPUTDIR, abs,
                "packageName", "acme.generated"));

        assertEquals(abs, args.get(GeneratorBase.ARG_OUTPUTDIR));
        assertEquals("acme.generated", args.get("packageName"));
    }

    /** PATH_ARGS lists the render helper's key once; both ports must keep reading that key. */
    @Test
    public void kotlinAndSpringRenderHelpersShareTheTemplateRootKey() {
        assertEquals(SpringRenderHelperGenerator.ARG_TEMPLATE_ROOT, KotlinRenderHelperGenerator.ARG_TEMPLATE_ROOT);
    }
}
