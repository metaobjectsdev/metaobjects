package com.metaobjects.generator;

import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;
import org.junit.Assert;

import java.util.Collections;

/**
 * Basic test to verify that the test infrastructure is working.
 * H3a Task 5: retargeted from SimpleLoader to MetaDataLoader.
 */
public class BasicInfrastructureTest extends GeneratorTestBase {

    @Test
    public void testInfrastructureWorks() {
        // Test that we can create a loader
        MetaDataLoader loader = initLoader(Collections.emptyList());
        Assert.assertNotNull("Loader should not be null", loader);
        Assert.assertNotNull("Loader name should not be null", loader.getName());
    }
}