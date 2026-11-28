package com.metaobjects.io.json;

import com.metaobjects.MetaRoot;
import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * The {@code GET /_meta/docs} helpers ({@code docs/features/metadata-api.md}): the body is the
 * model-alone docs view, the bytes {@code fixtures/explorer-conformance/model-alone/expected.json}
 * holds every port to, and the tag is the one TypeScript's mount sends.
 */
public class MetaDocsEndpointTest {

    static Path modelAlone() {
        for (Path p = Path.of("").toAbsolutePath(); p != null; p = p.getParent()) {
            Path c = p.resolve("fixtures/explorer-conformance/model-alone");
            if (Files.isDirectory(c)) return c;
        }
        throw new IllegalStateException("fixtures/explorer-conformance/model-alone not found");
    }

    static MetaRoot load(Path dir) {
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "meta_docs_endpoint");
        loader.init();
        loader.load(new DirectorySource(dir.resolve("project/metaobjects"), new DirectorySource.Options()).expandToList());
        assertTrue("clean load expected, got: " + loader.getErrors(), loader.getErrors().isEmpty());
        return loader.getRoot();
    }

    @Test
    public void routePathSitsBesideMeta() {
        assertEquals("/_meta/docs", MetaEndpoint.META_DOCS_ROUTE_PATH);
    }

    @Test
    public void bodyIsTheModelAloneDocsView() throws IOException {
        Path dir = modelAlone();
        String expected = Files.readString(dir.resolve("expected.json"), StandardCharsets.UTF_8);
        MetaRoot root = load(dir);
        assertEquals(expected, MetaEndpoint.metaDocsJson(root));
        MetaEndpoint.Docs docs = MetaEndpoint.docs(root);
        assertEquals(expected, docs.body());
        assertEquals(MetaEndpoint.metaDocsEtag(expected), docs.etag());
    }

    @Test
    public void etagIsTypeScriptsValue() {
        // metaDocsEtag(...) in @metaobjectsdev/runtime-ts gives these for the same strings.
        assertEquals("\"5-4f9f2cab\"", MetaEndpoint.metaDocsEtag("hello"));
        assertEquals("\"0-811c9dc5\"", MetaEndpoint.metaDocsEtag(""));
        assertEquals("\"7-0579d2da\"", MetaEndpoint.metaDocsEtag("héllo ✓"));
    }

    @Test
    public void ifNoneMatchNamesTheTagOrStar() {
        String tag = "\"5-4f9f2cab\"";
        assertTrue(MetaEndpoint.etagMatches(tag, tag));
        assertTrue(MetaEndpoint.etagMatches("\"x\", W/" + tag, tag));
        assertTrue(MetaEndpoint.etagMatches("*", tag));
        assertFalse(MetaEndpoint.etagMatches(null, tag));
        assertFalse(MetaEndpoint.etagMatches("", tag));
        assertFalse(MetaEndpoint.etagMatches("\"other\"", tag));
    }
}
