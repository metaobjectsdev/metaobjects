package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.junit.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/** The Zod-style code mapping of the validation envelope, and that every issue is listed. */
public class ValidationIssuesTest {

    public static class Marker {
        @NotNull public String label;
        public Marker(String label) { this.label = label; }
    }

    public static class Bean {
        @NotNull public String required;
        @Size(min = 2, max = 4) public String sized;
        @Max(5) public Integer big;
        @Min(5) public Integer small;
        @DecimalMax("1.5") public BigDecimal decBig;
        @DecimalMin("1.5") public BigDecimal decSmall;
        @Digits(integer = 2, fraction = 1) public BigDecimal digits;
        @Pattern(regexp = "[a-z]+") public String pattern;
        @Valid public List<Marker> markers;
    }

    private static final Validator VALIDATOR = Validation.buildDefaultValidatorFactory().getValidator();

    private static Map<String, String> codesByTopLevelPath(Bean bean) {
        ValidationIssues issues = new ValidationIssues().addViolations(VALIDATOR.validate(bean));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> list = (List<Map<String, Object>>) issues.body().get("issues");
        Map<String, String> out = new java.util.TreeMap<>();
        for (Map<String, Object> issue : list) {
            out.put(String.valueOf(issue.get("path")), (String) issue.get("code"));
            assertTrue(issue.get("message") instanceof String);
        }
        return out;
    }

    @Test
    public void everyViolationIsListedWithItsZodCode() {
        Bean b = new Bean();
        b.required = null;
        b.sized = "toolong";
        b.big = 9;
        b.small = 1;
        b.decBig = new BigDecimal("2");
        b.decSmall = new BigDecimal("1");
        b.digits = new BigDecimal("123.45");
        b.pattern = "NOPE";
        Map<String, String> codes = codesByTopLevelPath(b);
        assertEquals("invalid_type", codes.get("[required]"));
        assertEquals("too_big", codes.get("[sized]"));
        assertEquals("too_big", codes.get("[big]"));
        assertEquals("too_small", codes.get("[small]"));
        assertEquals("too_big", codes.get("[decBig]"));
        assertEquals("too_small", codes.get("[decSmall]"));
        assertEquals("too_big", codes.get("[digits]"));
        assertEquals("invalid_format", codes.get("[pattern]"));
        assertEquals(8, codes.size());
    }

    @Test
    public void aSizeBelowItsMinimumIsTooSmall() {
        Bean b = new Bean();
        b.required = "x";
        b.sized = "a";
        assertEquals(Map.of("[sized]", "too_small"), codesByTopLevelPath(b));
    }

    @Test
    public void aNestedMemberPathCarriesTheIndex() {
        Bean b = new Bean();
        b.required = "x";
        b.markers = List.of(new Marker("ok"), new Marker(null));
        assertEquals(Map.of("[markers, 1, label]", "invalid_type"), codesByTopLevelPath(b));
    }

    @Test
    public void addAtUsesTheWireNameGiven() {
        ValidationIssues issues = new ValidationIssues()
            .addAt(VALIDATOR.validateValue(Bean.class, "required", null), "wire_name");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> list = (List<Map<String, Object>>) issues.body().get("issues");
        assertEquals(List.of("wire_name"), list.get(0).get("path"));
    }

    @Test
    public void aPatchBindFailureListsEveryProblemAndKeepsTheBoundValues() {
        List<PatchValidationException.Problem> problems = PatchValidationException.newProblems();
        Map<String, Object> assigned = new java.util.LinkedHashMap<>();
        PatchValidationException.collect(problems, () -> { throw new PatchValidationException("a"); });
        PatchValidationException.collect(problems, () -> {
            throw new PatchValidationException("b", new CanonicalDecimal.InvalidDecimalException("x", "too_big"));
        });
        assigned.put("c", 2);
        PatchValidationException e = new PatchValidationException(problems, assigned);
        ValidationIssues issues = new ValidationIssues().addPatchFailure(e);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> list = (List<Map<String, Object>>) issues.body().get("issues");
        assertEquals(2, list.size());
        assertEquals("invalid_type", list.get(0).get("code"));
        assertEquals(List.of("a"), list.get(0).get("path"));
        assertEquals("too_big", list.get(1).get("code"));
        assertEquals(Map.of("c", 2), e.assignedValues());
    }

    @Test
    public void aNonObjectBodyHasAnEmptyPath() {
        ValidationIssues issues = new ValidationIssues()
            .addPatchFailure(new PatchValidationException(PatchValidationException.BODY));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> list = (List<Map<String, Object>>) issues.body().get("issues");
        assertEquals(List.of(), list.get(0).get("path"));
    }

    @Test
    public void anUnreadableBodyNamesTheNestedPathAndClassifiesTheFailure() {
        ObjectMapper mapper = new ObjectMapper();
        try {
            mapper.readValue("{\"n\": \"abc\"}", Holder.class);
        } catch (Exception e) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> list = (List<Map<String, Object>>) UnreadableBody.envelope(e).get("issues");
            assertEquals(List.of("n"), list.get(0).get("path"));
            assertEquals("invalid_type", list.get(0).get("code"));
            assertEquals("n", UnreadableBody.envelope(e).get("field"));
            return;
        }
        throw new AssertionError("expected a failure");
    }

    public static class Holder {
        public Integer n;
    }
}
