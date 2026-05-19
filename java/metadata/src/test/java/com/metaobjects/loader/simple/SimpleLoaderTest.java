package com.metaobjects.loader.simple;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import org.junit.Test;

import java.net.URISyntaxException;
import java.util.Arrays;

import static org.junit.Assert.assertNotNull;

/**
 * Loader tests — H3a Task 5: retargeted from SimpleLoader to MetaDataLoader.
 */
public class SimpleLoaderTest extends SimpleLoaderTestBase {

    @Test
    public void testLoadSimpleTypes() throws URISyntaxException {
        MetaDataLoader loader = initLoader(Arrays.asList(
                URIHelper.toURI("model:resource:com/metaobjects/loader/simple/fruitbasket-metadata.json")
        ));
        assertNotNull("Loader should not be null", loader);
    }

}
