package com.metaobjects.generator.spring;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * The shared report writer carries the {@code field.duration} cell factory only when a served
 * report has a duration column: without one the writer is exactly what it was, and with one it
 * differs by that factory alone.
 */
public class SpringReportExportDurationCellTest {

    @Test
    public void theDurationCellIsAddedOnlyWhenAReportHasADurationColumn() {
        String plain = SpringReportExportGenerator.writerSource("acme.shop", "empty", false, true, false);
        assertFalse(plain, plain.contains("uration"));
        String withDuration = SpringReportExportGenerator.writerSource("acme.shop", "empty", false, true, true);
        assertTrue(withDuration, withDuration.contains("public static Cell duration(java.time.Duration value)"));
        int start = withDuration.indexOf("    /** A field.duration in its canonical");
        int end = withDuration.indexOf("    /** A decimal as the wire setting writes it");
        assertEquals(plain, withDuration.substring(0, start) + withDuration.substring(end));
    }
}
