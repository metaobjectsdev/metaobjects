package com.metaobjects.generator.util;

import com.metaobjects.generator.GeneratorTestBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.object.MetaObject;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Verifies {@link GeneratorUtil#isAbstract(com.metaobjects.MetaData)} reads the
 * canonical {@code isAbstract} MetaAttribute (the loader stores {@code abstract: true}
 * as a MetaAttribute named {@code isAbstract}), not the vestigial {@code _isAbstract}.
 */
public class GeneratorUtilAbstractTest extends GeneratorTestBase {

    // Deliberately field-free: the accessor reads the object's own `abstract`
    // flag, so the model only needs `object.entity` (a registered type). Avoiding
    // field subtypes keeps this unit test independent of the metadata-module
    // provider-bootstrap path (which other codegen-base tests don't exercise).
    private static final String MODEL = "{\n" +
        "  \"metadata.root\": {\n" +
        "    \"package\": \"acme\",\n" +
        "    \"children\": [\n" +
        "      { \"object.entity\": { \"name\": \"Base\", \"abstract\": true } },\n" +
        "      { \"object.entity\": { \"name\": \"Concrete\", \"extends\": \"Base\" } }\n" +
        "    ]\n" +
        "  }\n" +
        "}";

    @Test
    public void abstractAccessorReadsCanonicalIsAbstract() throws Exception {
        File tmp = File.createTempFile("gu-abstract", ".json");
        tmp.deleteOnExit();
        Files.write(tmp.toPath(), MODEL.getBytes(StandardCharsets.UTF_8));

        MetaDataLoader loader = initLoader(Collections.singletonList(
            URIHelper.toURI("model:file:" + tmp.getAbsolutePath())));

        MetaObject base = loader.getMetaObjectByName("acme::Base");
        MetaObject concrete = loader.getMetaObjectByName("acme::Concrete");

        assertTrue("abstract entity should be reported abstract",
            GeneratorUtil.isAbstract(base));
        assertFalse("concrete entity should NOT be reported abstract",
            GeneratorUtil.isAbstract(concrete));
    }
}
