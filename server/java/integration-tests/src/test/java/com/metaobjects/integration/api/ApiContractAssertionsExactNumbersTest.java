package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The assertion engine compares numbers exactly (ADR-0019 Amendment 1): a non-integer is never
 * truncated to a long, and a body number is read as a BigDecimal, not a double.
 */
final class ApiContractAssertionsExactNumbersTest {

    private static void check(Object body, Object expected) {
        ApiRequest request = new ApiRequest("r", "GET", "/x", null, 200, Map.of("equals", expected));
        ApiContractAssertions.assertResponse("exact", request, 200, body);
    }

    @Test
    void aFractionIsNotTruncatedToZero() {
        assertThrows(AssertionError.class, () -> check(new BigDecimal("0.3"), 0));
        assertThrows(AssertionError.class, () -> check(Map.of("v", new BigDecimal("12.5")), Map.of("v", 12)));
    }

    @Test
    void scaleDoesNotMatterButValueDoes() {
        assertDoesNotThrow(() -> check(new BigDecimal("0.30"), new BigDecimal("0.3")));
        assertDoesNotThrow(() -> check(List.of(1, new BigDecimal("2.0")), List.of(1L, 2)));
        assertThrows(AssertionError.class,
            () -> check(new BigDecimal("12345678901234567.89"), new BigDecimal("12345678901234568")));
    }

    @Test
    void aBodyNumberBeyondADoubleSurvivesParsing() throws Exception {
        Object parsed = TomcatHost.parseBody(new ObjectMapper(), "{\"v\":12345678901234567.89}");
        Object v = ((Map<?, ?>) parsed).get("v");
        assertThrows(AssertionError.class, () -> check(v, new BigDecimal("12345678901234568")));
        assertDoesNotThrow(() -> check(v, new BigDecimal("12345678901234567.89")));
    }
}
