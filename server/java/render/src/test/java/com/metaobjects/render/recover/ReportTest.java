package com.metaobjects.render.recover;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

public class ReportTest {

    @Test
    public void lostRequiredAccessorFiltersStates() {
        RecoveryReport r = new RecoveryReport();
        r.set("a", FieldRecovery.RECOVERED);
        r.set("b", FieldRecovery.LOST_REQUIRED);
        r.set("c", FieldRecovery.LOST_REQUIRED);
        r.set("d", FieldRecovery.DEFAULTED);
        assertEquals(List.of("b", "c"), r.lostRequired());
        assertTrue(r.hasLostRequired());
    }

    @Test
    public void emptyReportFlagsDegenerate() {
        RecoveryReport r = new RecoveryReport();
        r.markEmpty();
        assertTrue(r.isEmpty());
        assertFalse(r.hasLostRequired());
    }

    @Test
    public void optionsDefaultsToNormalTolerance() {
        RecoverOptions opts = RecoverOptions.defaults();
        assertEquals(Tolerance.NORMAL, opts.tolerance());
        assertTrue(opts.aliases().isEmpty());
        assertNull(opts.onField());
    }

    @Test
    public void outcomeHoldsDataAndReport() {
        RecoveryReport r = new RecoveryReport();
        RecoverOutcome o = new RecoverOutcome(java.util.Map.of("x", 1), r);
        assertEquals(1, o.data().get("x"));
        assertSame(r, o.report());
    }
}
