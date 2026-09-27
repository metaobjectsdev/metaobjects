package com.metaobjects.object.extract;

import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.ObjectClassRegistry;
import com.metaobjects.render.extract.ExtractOptions;
import com.metaobjects.render.extract.ExtractionResult;
import com.metaobjects.render.extract.FieldExtraction;
import com.metaobjects.render.extract.FieldSpec;
import com.metaobjects.render.extract.Format;
import org.junit.After;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;

/**
 * validator.array (@min/@max) on an array field reaches the extract engine: a reply with too
 * many elements keeps the first @max, and one with too few is MALFORMED and counted in
 * malformedRequired, so the strict gate fails. Mirrors the TypeScript
 * extract-object-array-bounds test.
 */
public class MetaObjectExtractorArrayBoundsTest {

    private static final String META = "{ \"metadata.root\": { \"package\": \"app\", \"children\": ["
        + "{ \"object.value\": { \"name\": \"Suggestion\", \"children\": ["
        + "  { \"field.string\": { \"name\": \"tags\", \"@required\": true, \"isArray\": true, \"children\": ["
        + "    { \"validator.array\": { \"name\": \"threeTags\", \"@min\": 3, \"@max\": 3 } } ] } } ] } } ] } }";

    private static MetaObject suggestion(String name) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "array-bounds-" + name);
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "array-bounds/meta.json")));
        return loader.getMetaObjectByName("app::Suggestion");
    }

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    public void schemaCarriesTheBounds() {
        FieldSpec tags = MetaObjectExtractor.extractSchemaFor(suggestion("schema")).fields().get(0);
        assertEquals(Integer.valueOf(3), tags.minItems());
        assertEquals(Integer.valueOf(3), tags.maxItems());
    }

    @Test
    public void tooManyKeepsTheFirstMax() {
        MetaObject mo = suggestion("many");
        ExtractionResult<Object> result = MetaObjectExtractor.extract(
                mo, "{\"tags\":[\"a\",\"b\",\"c\",\"d\",\"e\"]}", Format.JSON, ExtractOptions.defaults());
        assertEquals(FieldExtraction.EXTRACTED, result.report().states().get("tags"));
        assertEquals(List.of("a", "b", "c"), mo.getMetaField("tags").getObjectArray(result.data()));
    }

    @Test
    public void tooFewIsMalformedRequired() {
        ExtractionResult<Object> result = MetaObjectExtractor.extract(
                suggestion("few"), "{\"tags\":[\"a\",\"b\"]}", Format.JSON, ExtractOptions.defaults());
        assertEquals(FieldExtraction.MALFORMED, result.report().states().get("tags"));
        assertEquals(List.of("tags"), result.report().malformedRequired());
    }
}
