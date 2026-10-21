package com.metaobjects.generator.spring;

import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * ADR-0059 R7 — {@link SpringNaming#resolveObjectRef} and {@link SpringNaming#resolveValueObjectRef}
 * resolve a CANONICAL value exactly: {@code pkg::Name} binds that package's object, {@code ::Name}
 * and a bare {@code Name} bind the root-level one, and the referrer package is never applied.
 * Three value objects share the short name {@code Report}, so a short-name scan or a package-local
 * resolve would bind one of the packaged copies instead.
 */
public class SpringNamingCanonicalRefTest {

    private static String doc(String pkg, String field) {
        String pkgPart = pkg == null ? "" : "\"package\": \"" + pkg + "\", ";
        return "{ \"metadata.root\": { " + pkgPart + "\"children\": ["
            + "{ \"object.value\": { \"name\": \"Report\", \"children\": ["
            + "{ \"field.string\": { \"name\": \"" + field + "\" } } ] } } ] } }";
    }

    private static MetaDataLoader load(String... docs) {
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "spring-naming-canonical");
        loader.init();
        List<com.metaobjects.loader.MetaDataSource> sources = new java.util.ArrayList<>();
        for (int i = 0; i < docs.length; i++) {
            sources.add(new InMemoryStringSource(docs[i], "spring-naming-canonical/meta." + i + ".json"));
        }
        loader.load(sources);
        return loader;
    }

    private static String fieldOf(MetaObject obj) {
        return obj == null ? null : obj.getMetaFields().iterator().next().getName();
    }

    @Test
    public void canonicalValuesResolveExactly() {
        MetaDataLoader loader = load(doc("acme::alpha", "alphaVal"), doc("acme::beta", "betaVal"), doc(null, "rootVal"));

        assertEquals("alphaVal", fieldOf(SpringNaming.resolveObjectRef(loader, "acme::alpha::Report", "")));
        assertEquals("betaVal", fieldOf(SpringNaming.resolveValueObjectRef(loader, "acme::beta::Report", "acme::alpha")));
        assertEquals("rootVal", fieldOf(SpringNaming.resolveValueObjectRef(loader, "::Report", "acme::alpha")));
        assertEquals("rootVal", fieldOf(SpringNaming.resolveObjectRef(loader, "Report", "acme::alpha")));
        assertNull(SpringNaming.resolveObjectRef(loader, "acme::gamma::Report", ""));
    }

    @Test
    public void bareValueDoesNotBindAPackagedObject() {
        MetaDataLoader loader = load(doc("acme::alpha", "alphaVal"));

        assertNull(SpringNaming.resolveObjectRef(loader, "Report", "acme::alpha"));
        assertEquals("alphaVal", fieldOf(SpringNaming.resolveObjectRef(loader, "acme::alpha::Report", "")));
    }
}
