package com.metaobjects.generator.util;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * THE collection-URL spelling, for both JVM generators at once.
 *
 * <p>The multi-word and consonant+y axes are also gated end-to-end by
 * {@code fixtures/api-contract-conformance/m2m/} (the {@code PostCategory} scenario).
 * The ACRONYM case is not — no corpus entity carries one — so it is pinned here,
 * against the same rule, exactly as the C# and Python ports pin it in theirs.</p>
 */
public class RouteNamingTest {

    // A single regular word. Every port's OLD rule already agreed here, which is
    // precisely why four different spellings shipped with every corpus green.
    @Test
    public void singleRegularWordIsUnchangedByTheNewRule() {
        assertEquals("authors", RouteNaming.collectionSegment("Author"));
        assertEquals("posts", RouteNaming.collectionSegment("Post"));
        assertEquals("tags", RouteNaming.collectionSegment("Tag"));
        assertEquals("persons", RouteNaming.collectionSegment("Person"));
        assertEquals("accounts", RouteNaming.collectionSegment("Account"));
        assertEquals("auths", RouteNaming.collectionSegment("Auth"));
        assertEquals("documents", RouteNaming.collectionSegment("Document"));
        assertEquals("orders", RouteNaming.collectionSegment("Order"));
    }

    // Multi-word: the capitals carry the word boundary, so lowercasing without
    // separating served PostCategory at /postcategorys.
    @Test
    public void multiWordNameIsSeparated() {
        assertEquals("post_categories", RouteNaming.collectionSegment("PostCategory"));
        assertEquals("order_summaries", RouteNaming.collectionSegment("OrderSummary"));
        assertEquals("member_accounts", RouteNaming.collectionSegment("MemberAccount"));
    }

    // A run of capitals stays together until the final one that begins a word.
    @Test
    public void acronymStaysTogether() {
        assertEquals("http_servers", RouteNaming.collectionSegment("HTTPServer"));
        assertEquals("api_keys", RouteNaming.collectionSegment("APIKey"));
    }

    @Test
    public void pluralizeFollowsTheCrossPortContract() {
        // Sibilants take -es.
        assertEquals("addresses", RouteNaming.pluralize("address"));
        assertEquals("boxes", RouteNaming.pluralize("box"));
        assertEquals("buzzes", RouteNaming.pluralize("buzz"));
        assertEquals("matches", RouteNaming.pluralize("match"));
        assertEquals("dishes", RouteNaming.pluralize("dish"));
        // Consonant + y becomes -ies; a VOWEL before the y does not.
        assertEquals("categories", RouteNaming.pluralize("category"));
        assertEquals("days", RouteNaming.pluralize("day"));
        // Everything else takes -s.
        assertEquals("authors", RouteNaming.pluralize("author"));
    }

    @Test
    public void emptyAndNullAreReturnedUnchanged() {
        assertEquals("", RouteNaming.collectionSegment(""));
        assertEquals(null, RouteNaming.collectionSegment(null));
        assertEquals("", RouteNaming.pluralize(""));
        assertEquals(null, RouteNaming.pluralize(null));
    }
}
