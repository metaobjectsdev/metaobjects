package com.metaobjects.mojo;

import com.metaobjects.generator.kotlin.GeneratorInfo;
import com.metaobjects.generator.kotlin.GeneratorLayer;
import com.metaobjects.generator.kotlin.GeneratorTier;
import com.metaobjects.generator.kotlin.KotlinNamesGenerator;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/** A Java caller of the six-argument {@code GeneratorInfo} constructor, as 1.0 shipped it, still links. */
public class KotlinGeneratorInfoJavaCallerTest {

    @Test
    public void theSixArgumentConstructorStillExistsAndLeavesNothingToCopyWithIt() {
        GeneratorInfo info = new GeneratorInfo("names", "d", GeneratorTier.NATIVE, GeneratorLayer.MODEL,
                KotlinNamesGenerator::new, "META-INF/metaobjects/reference/kotlin/KotlinNamesGenerator.kt");
        assertEquals("names", info.getName());
        assertEquals(java.util.List.of(), info.getEjectWith());
        // And the five-argument form it was a default-argument overload of.
        assertNull(new GeneratorInfo("names", "d", GeneratorTier.NATIVE, GeneratorLayer.MODEL,
                KotlinNamesGenerator::new).getEjectResourcePath());
    }
}
