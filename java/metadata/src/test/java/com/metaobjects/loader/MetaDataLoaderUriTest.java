package com.metaobjects.loader;

import com.metaobjects.loader.uri.URIHelper;
import org.junit.Test;

import java.net.URISyntaxException;
import java.util.Arrays;

import static org.junit.Assert.assertNotNull;

/**
 * Loader URI-based tests — exercises {@link MetaDataLoader} with classpath resource URIs.
 *
 * <p>H3a Task 6: renamed from {@code SimpleLoaderTest} (package
 * {@code com.metaobjects.loader.simple}) to reflect that the class now
 * exercises {@link MetaDataLoader}, not the removed {@code SimpleLoader}.</p>
 */
public class MetaDataLoaderUriTest extends MetaDataLoaderTestBase {

    @Test
    public void testLoadSimpleTypes() throws URISyntaxException {
        MetaDataLoader loader = initLoader(Arrays.asList(
                URIHelper.toURI("model:resource:com/metaobjects/loader/simple/fruitbasket-metadata.json")
        ));
        assertNotNull("Loader should not be null", loader);
    }

}
