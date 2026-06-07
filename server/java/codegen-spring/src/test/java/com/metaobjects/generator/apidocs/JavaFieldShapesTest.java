package com.metaobjects.generator.apidocs;

import com.metaobjects.generator.spring.SpringTestFixtures;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

/**
 * Tests {@link JavaFieldShapes} — that it derives the per-field documented shape
 * (name / Java type / optionality / enum-note) for an entity's DTO surface by
 * REUSING the real {@code SpringDtoGenerator} field logic (so the docs can't
 * drift from what the generator emits).
 */
public class JavaFieldShapesTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /**
     * An {@code Author} entity: required {@code id} (Long), required {@code name}
     * (String, {@code @required}), optional {@code bio} (String), and an enum
     * {@code status} (not required, carries allowed values).
     */
    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id", "@required": true } },
                { "field.string": { "name": "name", "@required": true } },
                { "field.string": { "name": "bio" } },
                { "field.enum":   { "name": "status",
                                    "@values": ["ACTIVE","RETIRED"] } },
                { "source.rdb":   { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void dtoFieldsDeriveTypeOptionalityAndEnumNote() throws Exception {
        Path workspace = tempFolder.newFolder("fieldshapes-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "fieldshapes", FIXTURE);
        MetaObject author = loader.getMetaObjectByName("acme::blog::Author");

        List<FieldShape> fs = JavaFieldShapes.dtoFields(author);

        assertEquals("String", find(fs, "name").type());
        assertEquals(false, find(fs, "name").optional());   // @required → @NotBlank/@NotNull
        assertEquals(true,  find(fs, "bio").optional());
        assertEquals(false, find(fs, "id").optional());     // @required → @NotNull
        assertEquals("Long", find(fs, "id").type());
        // enum note carries allowed values:
        assertNotNull(find(fs, "status").note());
        assertEquals(true, find(fs, "status").optional());
    }

    private static FieldShape find(List<FieldShape> fs, String name) {
        for (FieldShape f : fs) {
            if (f.name().equals(name)) return f;
        }
        throw new AssertionError("no field shape named '" + name + "' in " + fs);
    }
}
