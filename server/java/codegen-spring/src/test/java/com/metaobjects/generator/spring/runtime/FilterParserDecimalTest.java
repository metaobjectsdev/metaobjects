package com.metaobjects.generator.spring.runtime;

import org.junit.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/** ADR-0019 Amendment 1 (W2): a decimal filter operand is parsed exactly, or is a 400. */
public class FilterParserDecimalTest {

    private static final Set<String> FIELDS = Set.of("amount", "label");
    private static final Map<String, Set<String>> OPS =
        Map.of("amount", Set.of("eq", "gt", "in"), "label", Set.of("eq"));
    private static final Set<String> DECIMALS = Set.of("amount");

    private static FilterParseResult parse(String q) {
        return FilterParser.parse(q, FIELDS, OPS, DECIMALS);
    }

    @Test
    public void aDecimalOperandIsAnExactBigDecimal() {
        FilterParseResult r = parse("filter[amount][eq]=12345678901234567.89");
        assertNull(r.error());
        assertEquals(new BigDecimal("12345678901234567.89"), r.predicates().get(0).value());
    }

    @Test
    public void exponentFormIsAcceptedAndTheInListIsExact() {
        assertEquals(0, new BigDecimal("0.0000001").compareTo(
            (BigDecimal) parse("filter[amount][gt]=1e-7").predicates().get(0).value()));
        Object in = parse("filter[amount][in]=0.1,12345678901234567.89").predicates().get(0).value();
        assertEquals(List.of(new BigDecimal("0.1"), new BigDecimal("12345678901234567.89")), in);
    }

    @Test
    public void aMalformedOperandIsInvalidFilterValue() {
        for (String bad : new String[] {"abc", "0x10", "NaN", "Infinity", "", "%201", "1,5x"}) {
            FilterParseResult r = parse("filter[amount][eq]=" + bad);
            assertEquals("operand '" + bad + "'", "invalid_filter_value", r.error());
            assertEquals("amount", r.field());
        }
        assertEquals("invalid_filter_value", parse("filter[amount][in]=1,abc").error());
    }

    @Test
    public void aNonDecimalFieldKeepsTheRawString() {
        assertEquals("abc", parse("filter[label][eq]=abc").predicates().get(0).value());
        assertEquals("abc", FilterParser.parse("filter[amount][eq]=abc", FIELDS, OPS).predicates().get(0).value());
    }
}
