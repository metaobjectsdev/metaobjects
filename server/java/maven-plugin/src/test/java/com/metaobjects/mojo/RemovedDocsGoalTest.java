package com.metaobjects.mojo;

import org.apache.maven.plugin.Mojo;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugin.testing.MojoRule;
import org.codehaus.plexus.PlexusTestCase;
import org.junit.Rule;
import org.junit.Test;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

/**
 * An 8.0 pom is never run quietly into a build with no documentation (ADR-0034 Amendment 9).
 * The removed {@code docs} goal says what replaced it, and the goals that remain refuse the
 * {@code docs} goal's configuration by name, each with the sentence the amendment fixes.
 */
public class RemovedDocsGoalTest {

    private static final String MIGRATION =
            "See https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/docs-are-generators.md, section \"Java and Kotlin\".";

    @Rule
    public MojoRule rule = new MojoRule();

    private static File pom() {
        return new File(PlexusTestCase.getBasedir(), "src/test/resources/mojo/pom-docs-8-0.xml");
    }

    private static String refusalOf(Mojo mojo) throws Exception {
        try {
            mojo.execute();
        } catch (MojoFailureException e) {
            return e.getMessage();
        }
        fail(mojo.getClass().getSimpleName() + " ran an 8.0 pom");
        return null;
    }

    @Test
    public void theDocsGoalSaysItWasRemovedAndWhatWritesDocumentationNow() throws Exception {
        assertEquals(
                "metaobjects:docs was removed in 8.1.0. `mvn metaobjects:generate` writes documentation "
                    + "now: declare each docs generator as a <generator> entry in the plugin's "
                    + "<generators>. " + MIGRATION,
                // Built directly: Maven hands a goal only the <configuration> elements it declares,
                // and this one declares none. The test harness's configurator refuses the rest.
                refusalOf(new DocsMojo()));
    }

    @Test
    public void anExecutionThatBindsTheDocsGoalWithNoPhaseIsStillScheduled() throws Exception {
        // The 8.0 pom binds <goal>docs</goal> with no <phase>. Maven schedules such an execution
        // through the phase in the plugin descriptor, and skips it when there is none, so the
        // refusal above would never run. The descriptor is what Maven reads; the 8.0 goal said
        // generate-resources.
        assertEquals("generate-resources", descriptorPhaseOf("docs"));
    }

    private static String descriptorPhaseOf(String goal) throws Exception {
        try (InputStream in = RemovedDocsGoalTest.class.getClassLoader()
                .getResourceAsStream("META-INF/maven/plugin.xml")) {
            assertNotNull("plugin.xml descriptor must be generated before tests run", in);
            NodeList mojos = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(in)
                    .getDocumentElement().getElementsByTagName("mojo");
            for (int i = 0; i < mojos.getLength(); i++) {
                Element mojo = (Element) mojos.item(i);
                if (goal.equals(childText(mojo, "goal"))) {
                    return childText(mojo, "phase");
                }
            }
            fail("no <mojo> for goal '" + goal + "' in the plugin descriptor");
            return null;
        }
    }

    private static String childText(Element parent, String name) {
        for (org.w3c.dom.Node n = parent.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n instanceof Element && name.equals(n.getNodeName())) {
                return n.getTextContent().trim();
            }
        }
        return null;
    }

    @Test
    public void theGenerateGoalRefusesTheDocsGoalsConfigurationAndWritesNothing() throws Exception {
        assertEquals(
                "metaobjects:generate: found 1.0 docs configuration (<language>, <layout> in the plugin's "
                    + "<configuration>). Nothing reads it any more, so this run would write no "
                    + "documentation. Declare each docs generator as a <generator> entry in the plugin's "
                    + "<generators>. " + MIGRATION,
                refusalOf(rule.lookupMojo("generate", pom())));
        // Refused before the list ran: the pom's one code generator wrote nothing either.
        assertFalse(Files.exists(new File(PlexusTestCase.getBasedir(), "target/docs-8-0-test").toPath()));
    }

    @Test
    public void theVerifyGoalRefusesItToo() throws Exception {
        assertEquals(
                "metaobjects:verify: found 1.0 docs configuration (<language>, <layout> in the plugin's "
                    + "<configuration>). Nothing reads it any more, so this run would write no "
                    + "documentation. Declare each docs generator as a <generator> entry in the plugin's "
                    + "<generators>. " + MIGRATION,
                refusalOf(rule.lookupMojo("verify", pom())));
    }
}
