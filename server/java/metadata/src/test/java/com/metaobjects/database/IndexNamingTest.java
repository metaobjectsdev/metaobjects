package com.metaobjects.database;

import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.SecondaryIdentity;
import com.metaobjects.index.LookupIndex;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * {@link IndexNaming} — the ONE door for an index's database name on the JVM.
 *
 * <p>The first two tests pin the function's two rules. The rest pin the LOADER measurements
 * those rules were ported against, and they are the load-bearing half of this file: the
 * TypeScript commit that introduced the shared resolver justified both rules with claims
 * about the JVM, and neither survived measurement here. Pinning what the loader actually
 * does is what stops the next reader either deleting a rule as pointless or keeping it for a
 * reason that was never true.</p>
 */
public class IndexNamingTest extends SharedRegistryTestBase {

    // ---------------------------------------------------------------------------
    // The function's own two rules
    // ---------------------------------------------------------------------------

    @Test
    public void aBareNameResolvesUnchanged() {
        assertEquals("by_name", IndexNaming.resolve(new SecondaryIdentity("by_name")));
        assertEquals("ix_status", IndexNaming.resolve(new LookupIndex("ix_status")));
    }

    @Test
    public void aPackageQualifierIsStripped() {
        // A no-op on every name the JVM parser produces (see the loader tests below), and
        // asserted anyway: the point of one door is that the answer does not depend on
        // whether the caller remembered to unqualify.
        assertEquals("by_name", IndexNaming.resolve(new SecondaryIdentity("acme::demo::by_name")));
        assertEquals("ix_status", IndexNaming.resolve(new LookupIndex("acme::demo::ix_status")));
    }

    @Test
    public void anEmptyShortNameIsRefusedRatherThanEmitted() {
        // "pkg::" is the one shape MetaData.validateName admits with an empty short name:
        // split("::") drops the trailing empty segment, so the identifier check sees only
        // "pkg" and passes, while getShortName() returns "". Returning it would emit
        // index("") — SQL no engine accepts, from a node that constructed cleanly.
        try {
            IndexNaming.resolve(new LookupIndex("pkg::"));
            fail("expected a MetaDataException for an empty short name");
        } catch (MetaDataException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("index.lookup"));
            assertTrue(e.getMessage(), e.getMessage().contains("empty name"));
        }
    }

    // ---------------------------------------------------------------------------
    // What the loader actually does — the two claims this resolver was ported against
    // ---------------------------------------------------------------------------

    @Test
    public void aNestedIndexNameIsNotPackageQualifiedByTheLoader() {
        // The claim that motivated the strip — "the JVM loader spells a nested index name
        // acme::demo::by_name" — is FALSE. BaseMetaDataParser qualifies a ROOT-level node
        // only. If this ever starts failing, the strip stops being a no-op and the Exposed
        // emitter's deleted `shortName ?: name` was right after all.
        MetaObject widget = widgetIn("acme::demo");
        MetaIdentity secondary = widget.getIdentities(true).stream()
            .filter(i -> MetaIdentity.SUBTYPE_SECONDARY.equals(i.getSubType()))
            .findFirst().orElseThrow();
        LookupIndex lookup = widget.getChildren(LookupIndex.class, true).iterator().next();

        assertEquals("by_name", secondary.getName());
        assertEquals("ix_alt", lookup.getName());
        // ...so the door returns the same string the raw name already was.
        assertEquals(secondary.getName(), IndexNaming.resolve(secondary));
        assertEquals(lookup.getName(), IndexNaming.resolve(lookup));
    }

    @Test
    public void anAuthoredEmptyIndexNameNeverReachesThisResolverEmpty() {
        // TypeScript's gap is exactly one node type wide: an identity.secondary with an
        // empty name is refused by the loader while an index.lookup is not, so `{"index.
        // lookup": {"name": ""}}` reaches the emitter and produces index(""). On the JVM
        // BOTH halves differ. `index` is not an auto-naming type, so the parser substitutes
        // name = subType and the node arrives called "lookup" — wrong (a name the model
        // never declared) but not empty, so the refusal above is unreachable by authoring.
        MetaDataLoader loader = strictLoader("empty-lookup");
        loader.load(List.of(new InMemoryStringSource("""
            { "metadata.root": { "package": "acme::demo", "children": [
                { "object.entity": { "name": "Widget", "children": [
                    { "source.rdb": { "@table": "widgets" } },
                    { "field.long":   { "name": "id" } },
                    { "field.string": { "name": "alt" } },
                    { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                    { "index.lookup":     { "name": "", "@fields": ["alt"] } }
                ] } }
            ] } }
            """, "empty-lookup.json")));
        assertEquals(List.of(), loader.getErrors());
        LookupIndex lookup = loader.getMetaObjects().iterator().next()
            .getChildren(LookupIndex.class, true).iterator().next();
        assertEquals("lookup", lookup.getName());
        assertEquals("lookup", IndexNaming.resolve(lookup));
    }

    @Test
    public void anAuthoredEmptyIdentityNameIsRefusedByTheLoader() {
        // The other half of the asymmetry, and the reason it is worth stating: identity
        // nodes DO carry the FR-024 name check (so a dotted `extends` ref can address one),
        // and it is a hard LOAD failure rather than a recorded error.
        MetaDataLoader loader = strictLoader("empty-secondary");
        try {
            loader.load(List.of(new InMemoryStringSource("""
                { "metadata.root": { "package": "acme::demo", "children": [
                    { "object.entity": { "name": "Widget", "children": [
                        { "source.rdb": { "@table": "widgets" } },
                        { "field.long":   { "name": "id" } },
                        { "field.string": { "name": "alt" } },
                        { "identity.primary":   { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                        { "identity.secondary": { "name": "", "@fields": ["alt"] } }
                    ] } }
                ] } }
                """, "empty-secondary.json")));
            fail("expected the loader to refuse an identity.secondary with an empty name");
        } catch (RuntimeException e) {
            assertTrue(rootMessage(e), rootMessage(e).contains("ERR_IDENTITY_NAME_REQUIRED"));
        }
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    private MetaDataLoader strictLoader(String id) {
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "test-index-naming-" + id);
        loader.setSourceURIs(java.util.Collections.emptyList());
        loader.init();
        return loader;
    }

    private MetaObject widgetIn(String pkg) {
        MetaDataLoader loader = strictLoader("nested-" + pkg.replace(':', '_'));
        loader.load(List.of(new InMemoryStringSource("""
            { "metadata.root": { "package": "%s", "children": [
                { "object.entity": { "name": "Widget", "children": [
                    { "source.rdb": { "@table": "widgets" } },
                    { "field.long":   { "name": "id" } },
                    { "field.string": { "name": "alt" } },
                    { "identity.primary":   { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                    { "identity.secondary": { "name": "by_name", "@fields": ["alt"] } },
                    { "index.lookup":       { "name": "ix_alt",  "@fields": ["alt"] } }
                ] } }
            ] } }
            """.formatted(pkg), "nested.json")));
        assertEquals(List.of(), loader.getErrors());
        MetaRoot root = loader.getRoot();
        assertTrue("expected the fixture to load an object", !loader.getMetaObjects().isEmpty());
        assertTrue(root != null);
        return loader.getMetaObjects().iterator().next();
    }

    private static String rootMessage(Throwable t) {
        StringBuilder sb = new StringBuilder();
        for (Throwable c = t; c != null; c = c.getCause()) sb.append(c.getMessage()).append('\n');
        return sb.toString();
    }
}
