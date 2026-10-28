package com.metaobjects.generator.spring.runtime;

import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** The request-side rules of a report export: formats, envelopes, headers. */
public class ReportExportTest {

    @Test
    public void onlyTheThreeLowerCaseFormatsAreWired() {
        for (String ok : List.of("csv", "json", "xml")) assertTrue(ok, ReportExport.isFormat(ok));
        for (String bad : new String[] { "xlsx", "pdf", "CSV", "Json", "", " csv", "csv " }) {
            assertFalse("'" + bad + "'", ReportExport.isFormat(bad));
        }
        assertFalse(ReportExport.isFormat(null));
    }

    @Test
    public void theInvalidFormatEnvelopeListsTheWiredFormatsInOrder() {
        Map<String, Object> body = ReportExport.invalidFormat();
        assertEquals("invalid_format", body.get("error"));
        assertEquals(List.of("csv", "json", "xml"), body.get("expected"));
    }

    @Test
    public void theOtherEnvelopes() {
        assertEquals("export_with_count", ReportExport.withCount().get("error"));
        assertEquals(Map.of("error", "export_too_large", "maxRows", 60), ReportExport.tooLarge(60));
    }

    @Test
    public void withCountIsTruthyForOneAndTrue() {
        assertTrue(ReportExport.isTruthy("1"));
        assertTrue(ReportExport.isTruthy("true"));
        assertTrue(ReportExport.isTruthy("TRUE"));
        assertFalse(ReportExport.isTruthy("0"));
        assertFalse(ReportExport.isTruthy("false"));
        assertFalse(ReportExport.isTruthy(""));
        assertFalse(ReportExport.isTruthy(null));
    }

    @Test
    public void theHeaders() {
        assertEquals("export_cells", ReportExport.segment("/api/export_cells"));
        assertEquals("export_cells", ReportExport.segment("export_cells"));
        assertEquals("attachment; filename=\"export_cells.csv\"",
            ReportExport.contentDisposition("export_cells", "csv"));
        assertEquals("text/csv; charset=utf-8", ReportExport.contentType("csv"));
        assertEquals("application/json", ReportExport.contentType("json"));
        assertEquals("application/xml", ReportExport.contentType("xml"));
    }
}
