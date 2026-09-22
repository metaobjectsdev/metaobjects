package com.metaobjects.generator.spring.runtime;

import org.junit.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * A malformed percent-escape in the query is data, not a server error.
 *
 * <p>A browser's URL parser (and Node's {@code fetch}) passes a stray {@code %} through
 * unencoded, so {@code ?filter[name][like]=LIST%} reaches the controller as written.
 * {@link java.net.URLDecoder} throws on it, which surfaced as a 500 on every such
 * request; the TypeScript, C# and Python servers keep the {@code %} literal. The parser
 * now decodes the way those ports (and the WHATWG URL standard) do: {@code %XX} with two
 * hex digits is a byte, anything else is kept as written, {@code +} is a space.</p>
 */
public class FilterParserDecodingTest {

    private static final Set<String> FIELDS = Set.of("name", "bio");
    private static final Map<String, Set<String>> OPS =
        Map.of("name", Set.of("eq", "like"), "bio", Set.of("eq"));

    private static Object onlyValue(String rawQuery) {
        FilterParseResult r = FilterParser.parse(rawQuery, FIELDS, OPS);
        assertNull("unexpected error envelope " + r.error(), r.error());
        assertEquals(1, r.predicates().size());
        return r.predicates().get(0).value();
    }

    @Test
    public void trailingRawPercentIsKeptLiteral() {
        assertEquals("LIST%", onlyValue("filter[name][like]=LIST%"));
    }

    @Test
    public void rawPercentBeforeTheNextPairDoesNotSwallowIt() {
        FilterParseResult r = FilterParser.parse("filter[name][like]=SR%&filter[bio][eq]=x", FIELDS, OPS);
        assertNull(r.error());
        assertEquals(List.of("SR%", "x"), r.predicates().stream().map(FilterPredicate::value).toList());
    }

    @Test
    public void percentFollowedByNonHexIsKeptLiteral() {
        assertEquals("a%zzb", onlyValue("filter[name][eq]=a%zzb"));
        assertEquals("a%2", onlyValue("filter[name][eq]=a%2"));
    }

    @Test
    public void encodedPercentStillDecodes() {
        assertEquals("LIST%", onlyValue("filter[name][like]=LIST%25"));
    }

    @Test
    public void plusIsASpaceAndMultiByteEscapesDecodeAsUtf8() {
        assertEquals("Café Ada", onlyValue("filter[name][eq]=Caf%C3%A9+Ada"));
    }

    @Test
    public void encodedBracketsInTheKeyDecode() {
        assertEquals("x", onlyValue("filter%5Bname%5D%5Beq%5D=x"));
    }

    @Test
    public void malformedEscapeInTheKeyIsNotAnError() {
        FilterParseResult r = FilterParser.parse("junk%=1&filter[name][eq]=x", FIELDS, OPS);
        assertNull(r.error());
        assertEquals(1, r.predicates().size());
    }
}
