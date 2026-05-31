package com.metaobjects.render.extract;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class ReportTest {

    @Test
    public void lostRequiredAccessorFiltersStates() {
        ExtractionReport r = new ExtractionReport();
        r.set("a", FieldExtraction.EXTRACTED);
        r.set("b", FieldExtraction.LOST_REQUIRED);
        r.set("c", FieldExtraction.LOST_REQUIRED);
        r.set("d", FieldExtraction.DEFAULTED);
        assertEquals(List.of("b", "c"), r.lostRequired());
        assertTrue(r.hasLostRequired());
    }

    @Test
    public void emptyReportFlagsDegenerate() {
        ExtractionReport r = new ExtractionReport();
        r.markEmpty();
        assertTrue(r.isEmpty());
        assertFalse(r.hasLostRequired());
    }

    @Test
    public void optionsDefaultsToNormalTolerance() {
        ExtractOptions opts = ExtractOptions.defaults();
        assertEquals(Tolerance.NORMAL, opts.tolerance());
        assertTrue(opts.aliases().isEmpty());
        assertNull(opts.onField());
    }

    @Test
    public void outcomeHoldsDataAndReport() {
        ExtractionReport r = new ExtractionReport();
        ExtractionOutcome o = new ExtractionOutcome(java.util.Map.of("x", 1), r);
        assertEquals(1, o.data().get("x"));
        assertSame(r, o.report());
    }
}
