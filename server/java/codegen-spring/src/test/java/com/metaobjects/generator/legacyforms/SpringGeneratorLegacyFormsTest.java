package com.metaobjects.generator.legacyforms;

import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringM2mSupport;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.generator.spring.SpringTestFixtures;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.validator.RegexValidator;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * The static helpers {@link SpringDtoGenerator} and {@link SpringRepositoryGenerator}
 * published through 1.0.13 still compile and answer as they did, so an adopter's own
 * generator that calls them, or subclasses {@code SpringDtoGenerator}, keeps building after
 * the upgrade.
 *
 * <p>This class sits outside {@code com.metaobjects.generator.spring} on purpose: an adopter's
 * code does, and a {@code protected} helper is reachable from another package only through a
 * subclass. The call forms are the 1.0.13 ones. Expected values come from the fixture's own
 * declarations and from the documented rules (a server-owned {@code @autoSet} field is never
 * settable or validated, FR-036 Ruling 1 for a required string, wrapped primitives for a
 * DTO component), not from the implementation.
 */
@SuppressWarnings("deprecation")
public class SpringGeneratorLegacyFormsTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private static final String FIXTURE = """
        { "metadata.root": { "package": "acme::crm", "children": [
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "city", "@maxLength": 80 } }
          ]}},
          { "object.entity": { "name": "Customer", "children": [
            { "source.rdb":      { "@table": "customers" } },
            { "field.long":      { "name": "id" } },
            { "field.string":    { "name": "name", "@required": true, "@maxLength": 100 } },
            { "field.string":    { "name": "code", "children": [
              { "validator.regex": { "@pattern": "[A-Z]+" } }
            ]}},
            { "field.timestamp": { "name": "updatedAt", "@autoSet": "onUpdate" } },
            { "field.object":    { "name": "home", "@objectRef": "Address", "@storage": "jsonb" } },
            { "field.map":       { "name": "addresses", "@objectRef": "Address" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
          ]}},
          { "object.entity": { "name": "Note", "children": [
            { "field.string": { "name": "text" } }
          ]}}
        ]}}
        """;

    /** An adopter's subclass, calling the inherited helpers unqualified as 1.0.x code did. */
    private static final class AdopterDtoGenerator extends SpringDtoGenerator {
        String annotationsOf(MetaField<?> field) { return validationAnnotations(field); }
        String typeOf(MetaField<?> field, MetaObject owner) { return componentType(field, owner); }
        String size(Integer min, Integer max) { return sizeAnnotation(min, max); }
        boolean flag(MetaField<?> field, String attr) { return attrBool(field, attr); }
        Integer number(MetaField<?> field, String... attrs) { return attrInt(field, attrs); }
        boolean hasRegex(MetaField<?> field) { return hasValidator(field, RegexValidator.class); }
        String escaped(String s) { return escapeJavaString(s); }
    }

    private MetaObject customer;
    private MetaObject note;

    @Before
    public void load() throws IOException {
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "crm", FIXTURE);
        customer = entity(loader, "Customer");
        note = entity(loader, "Note");
    }

    private static MetaObject entity(MetaDataLoader loader, String shortName) {
        for (MetaObject mo : loader.getMetaObjects()) {
            if (mo.getName().endsWith("::" + shortName)) return mo;
        }
        throw new IllegalStateException(shortName + " not in fixture");
    }

    private MetaField<?> field(String name) {
        return customer.getMetaField(name);
    }

    private static List<String> names(List<? extends MetaField> fields) {
        return fields.stream().map(MetaField::getName).collect(Collectors.toList());
    }

    @Test
    public void fieldSelectorsAnswerFromTheStaticCallForm() {
        List<String> scalars = names(SpringDtoGenerator.scalarFields(customer));
        assertTrue(scalars.containsAll(List.of("id", "name", "code", "updatedAt")));
        assertFalse("a value-object column is not a scalar", scalars.contains("home"));

        List<String> components = names(SpringDtoGenerator.dtoComponentFields(customer));
        assertTrue(components.containsAll(List.of("id", "name", "code", "updatedAt", "home")));

        List<String> settable = names(SpringDtoGenerator.settableFields(customer, "code"));
        assertTrue(settable.contains("name"));
        assertFalse("the primary key is not settable", settable.contains("id"));
        assertFalse("the excluded field is not settable", settable.contains("code"));
        assertFalse("an @autoSet field is server-owned", settable.contains("updatedAt"));
        assertFalse("a value-object column is not in the scalar settable set", settable.contains("home"));
    }

    @Test
    public void valueObjectSelectorsAnswerFromTheStaticCallForm() {
        List<ObjectField> jsonb = SpringDtoGenerator.valueObjectJsonbFields(customer);
        assertEquals(List.of("home"), names(jsonb));
        assertEquals(List.of("addresses"), names(SpringDtoGenerator.valueObjectMapFields(customer)));
        assertTrue(SpringDtoGenerator.isValueObjectJsonbField(field("home")));
        assertFalse(SpringDtoGenerator.isValueObjectJsonbField(field("name")));
    }

    @Test
    public void fieldRulesAnswerFromTheStaticCallForm() {
        assertEquals("Long", SpringDtoGenerator.componentType(field("id"), customer));
        assertEquals("String", SpringDtoGenerator.componentType(field("name"), customer));
        assertTrue(SpringDtoGenerator.isRequired(field("name")));
        assertFalse(SpringDtoGenerator.isRequired(field("code")));
        assertFalse(SpringDtoGenerator.originGuaranteedNonNull(field("name")));

        String required = SpringDtoGenerator.validationAnnotations(field("name"));
        assertTrue(required, required.contains("@NotNull"));
        assertTrue(required, required.contains("@Size(min = 1, max = 100)"));
        assertEquals("", SpringDtoGenerator.validationAnnotations(field("updatedAt")));
    }

    @Test
    public void aSubclassInAnotherPackageReachesTheInheritedHelpers() {
        AdopterDtoGenerator gen = new AdopterDtoGenerator();

        assertTrue(gen.annotationsOf(field("name")).contains("@NotNull"));
        assertEquals("Long", gen.typeOf(field("id"), customer));
        assertEquals("@Size(min = 1, max = 100)", gen.size(1, 100));
        assertEquals("@Size(max = 5)", gen.size(null, 5));
        assertTrue(gen.flag(field("name"), "required"));
        assertFalse(gen.flag(field("code"), "required"));
        assertEquals(Integer.valueOf(100), gen.number(field("name"), "maxLength"));
        assertNull(gen.number(field("code"), "maxLength"));
        assertTrue(gen.hasRegex(field("code")));
        assertFalse(gen.hasRegex(field("name")));
        assertEquals("a\\\"b\\\\c", gen.escaped("a\"b\\c"));
    }

    @Test
    public void repositoryHelpersAnswerFromTheStaticCallForm() {
        assertTrue(SpringRepositoryGenerator.appliesTo(customer));
        assertFalse("an entity with no source has no repository", SpringRepositoryGenerator.appliesTo(note));

        assertEquals("findTags", SpringRepositoryGenerator.m2mFinderName("tags"));
        assertEquals("findTagsForBridge", SpringRepositoryGenerator.m2mFinderNameForSubtype("tags", "Bridge"));

        SpringM2mSupport.M2mNav plain =
            new SpringM2mSupport.M2mNav("tags", "Tag", "TagDto", "PostTag", "postId", "tagId", false, null);
        SpringM2mSupport.M2mNav onSubtype =
            new SpringM2mSupport.M2mNav("tags", "Tag", "TagDto", "PostTag", "postId", "tagId", false, "Bridge");
        assertEquals("", SpringRepositoryGenerator.targetSubtypeParam(plain));
        assertEquals(", String targetSubtype", SpringRepositoryGenerator.targetSubtypeParam(onSubtype));
    }
}
