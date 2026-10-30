package com.metaobjects.mojo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Eject reads a pom with Maven's model reader: a name in a comment declares nothing. */
public class EjectPomReadingTest {

    private static final String POM = "<project>\n"
        + "  <!-- <artifactId>metaobjects-maven-plugin</artifactId> -->\n"
        + "  <modelVersion>4.0.0</modelVersion>\n"
        + "  <dependencies><dependency><groupId>g</groupId><artifactId>real-dep</artifactId></dependency></dependencies>\n"
        + "  <build>\n"
        + "    <!-- <sourceDirectory>old/src</sourceDirectory> -->\n"
        + "    <sourceDirectory>\n      src/main/java\n    </sourceDirectory>\n"
        + "    <plugins><plugin><artifactId>real-plugin</artifactId></plugin></plugins>\n"
        + "  </build>\n"
        + "</project>";

    @Test
    public void commentedArtifactIsNotDeclared() {
        assertFalse(MetaDataEjectMojo.declares(POM, "metaobjects-maven-plugin"));
        assertTrue(MetaDataEjectMojo.declares(POM, "real-dep"));
        assertTrue(MetaDataEjectMojo.declares(POM, "real-plugin"));
    }

    @Test
    public void sourceDirectoryIgnoresCommentsAndWhitespace() {
        assertEquals("src/main/java", MetaDataEjectMojo.declaredSourceDirectory(POM));
        assertNull(MetaDataEjectMojo.declaredSourceDirectory("<project/>"));
    }

    @Test
    public void malformedPomDeclaresNothing() {
        assertFalse(MetaDataEjectMojo.declares("<project><dependencies>", "real-dep"));
    }
}
