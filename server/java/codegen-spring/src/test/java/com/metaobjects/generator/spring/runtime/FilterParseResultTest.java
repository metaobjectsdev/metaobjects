package com.metaobjects.generator.spring.runtime;

import org.junit.Test;

import java.util.Map;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * The cross-port filter envelope names the field it rejected.
 *
 * <p>Asserted on the parser rather than only on emitted source: the generated
 * controller forwards {@code filter.error()} + {@code filter.field()} verbatim,
 * so this is the shape that reaches the wire. Java has no gate that reacts to
 * changed generated output, which is how an envelope member can otherwise drift
 * unobserved — see docs/features/api-contract.md, "Error response".
 */
public class FilterParseResultTest {

    private static final Set<String> FIELDS = Set.of("name", "bio");
    private static final Map<String, Set<String>> OPS =
        Map.of("name", Set.of("eq"), "bio", Set.of("eq", "isNull"));

    @Test
    public void unknownFieldEnvelopeNamesTheField() {
        FilterParseResult r = FilterParser.parse("filter[nope][eq]=x", FIELDS, OPS);
        assertEquals("invalid_filter_field", r.error());
        assertEquals("nope", r.field());
    }

    @Test
    public void disallowedOpEnvelopeNamesTheField() {
        FilterParseResult r = FilterParser.parse("filter[name][isNull]=true", FIELDS, OPS);
        assertEquals("invalid_filter_op", r.error());
        assertEquals("name", r.field());
    }

    @Test
    public void uncoercibleValueEnvelopeNamesTheField() {
        FilterParseResult r = FilterParser.parse("filter[bio][isNull]=maybe", FIELDS, OPS);
        assertEquals("invalid_filter_value", r.error());
        assertEquals("bio", r.field());
    }

    @Test
    public void successCarriesNoFieldOrError() {
        FilterParseResult r = FilterParser.parse("filter[name][eq]=Ada", FIELDS, OPS);
        assertNull(r.error());
        assertNull(r.field());
    }
}
