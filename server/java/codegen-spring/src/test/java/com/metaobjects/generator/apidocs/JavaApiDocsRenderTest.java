package com.metaobjects.generator.apidocs;

import com.metaobjects.generator.spring.SpringTestFixtures;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * SP-2b render gate: proves {@link JavaApiDocsRenderer} turns the {@link JavaApiModel} IR into
 * Java-idiomatic api-doc markdown via the production JVM {@link com.metaobjects.render.Renderer}.
 *
 * <p>Presentation-only: the renderer never re-derives names (those come from the IR / the
 * {@code SpringNaming} seam) or paths ({@link DocsPaths}); this test only asserts the page
 * STRUCTURE (headings, the model cross-link line, java fences, the field table) is emitted.
 */
public class JavaApiDocsRenderTest extends SharedRegistryTestBase {

    private static final String PROJECT = "apidocs-fixture";

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private JavaApiModel model;

    @Before
    public void setUp() throws Exception {
        Path workspace = tempFolder.newFolder("apidocs-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "apidocs", readFixture());
        model = new JavaApiModelBuilder().build(loader, PROJECT);
    }

    @Test
    public void rendersUnitPageIndexAndAgentForm() {
        ApiUnit author = unit("Author");

        String page = new JavaApiDocsRenderer()
            .renderUnitPage(author, "../../../acme/shop/Author.md");
        assertTrue("entity page must carry the '# <Node> API' heading", page.contains("# Author API"));
        assertTrue("entity page must carry the Model / metadata cross-link",
            page.contains("**Model / metadata:** [Author](../../../acme/shop/Author.md)"));
        assertTrue("entity page must mention the AuthorRepository data-access symbol",
            page.contains("AuthorRepository"));
        assertTrue("entity page must use java fences", page.contains("```java"));
        assertTrue("entity page must render a field table for the DTO shape",
            page.contains("| Field | Type | Required |"));

        String index = new JavaApiDocsRenderer().renderIndex(model, DocsPaths.Layout.PACKAGE);
        assertTrue("index must link to the Author unit page", index.contains("[Author]("));

        String agent = new JavaApiDocsRenderer().renderAgentApi(model);
        assertTrue("agent form must carry the per-unit '## <Node>' heading", agent.contains("## Author"));
    }

    private static String readFixture() throws IOException {
        try (InputStream in = JavaApiDocsRenderTest.class
                .getResourceAsStream("/apidocs-fixture/meta.json")) {
            assertNotNull("apidocs-fixture/meta.json must be on the test classpath", in);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private ApiUnit unit(String node) {
        for (ApiUnit u : model.units()) {
            if (u.node().equals(node)) {
                return u;
            }
        }
        throw new AssertionError("no unit '" + node + "' in " + model.units());
    }
}
