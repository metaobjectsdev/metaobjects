package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.config.WireFormat;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import java.io.File;
import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

/**
 * Gate for {@link SpringReportExportGenerator}: it generates the shared {@code ReportExportWriter}
 * and each served report's {@code <R>Export} over the api-contract report corpus, compiles them
 * with the DTOs, and runs the writer: CSV quoting, CRLF, the BOM constant, the formula-injection
 * guard (string-valued cells only, TAB and CR included), XML escaping and the two null forms.
 */
public class GeneratedReportExportCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String PKG = "acme.sales";

    private Path corpusMeta() {
        return SpringTestFixtures.findCorpusRoot().getParent()
            .resolve("api-contract-conformance/report/meta.json");
    }

    /** Generate DTOs and the export modules with {@code exportArgs}, compile, and load. */
    private Loaded generate(Map<String, String> exportArgs) throws Exception {
        return generate(exportArgs, WireFormat.DEFAULT);
    }

    /** As {@link #generate(Map)}, under the project wire setting {@code wire}. */
    private Loaded generate(Map<String, String> exportArgs, WireFormat wire) throws Exception {
        String json = Files.readString(corpusMeta(), StandardCharsets.UTF_8);
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "report-export", json);
        loader.getRoot().setWireFormat(wire);
        Path src = tmp.newFolder().toPath();
        Path classes = tmp.newFolder().toPath();
        run(new SpringDtoGenerator(), loader, src, Map.of());
        run(new SpringReportExportGenerator(), loader, src, exportArgs);
        List<File> sources;
        try (Stream<Path> s = Files.walk(src)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        boolean ok = javac.getTask(null, fm, diags,
            List.of("-classpath", System.getProperty("java.class.path"), "-d", classes.toString(), "-parameters"),
            null, fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            diags.getDiagnostics().forEach(d -> sb.append("  ").append(d).append('\n'));
            throw new AssertionError(sb.toString());
        }
        return new Loaded(src, new URLClassLoader(new URL[] { classes.toUri().toURL() }, getClass().getClassLoader()));
    }

    private static void run(com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> g, MetaDataLoader loader,
                            Path out, Map<String, String> extra) {
        Map<String, String> args = new java.util.HashMap<>(extra);
        args.put("outputDir", out.toString());
        g.setArgs(args);
        g.execute(loader);
    }

    private record Loaded(Path src, ClassLoader cl) {
        Class<?> writer() throws Exception {
            return cl.loadClass(PKG + ".ReportExportWriter");
        }

        Object cell(String factory, Object value) throws Exception {
            Class<?> w = writer();
            Class<?> param = factory.equals("decimal") ? BigDecimal.class : Object.class;
            return w.getMethod(factory, param).invoke(null, value);
        }

        String csv(List<String> names, List<List<Object>> rows) throws Exception {
            Method m = writer().getMethod("csv", List.class, List.class);
            return new String((byte[]) m.invoke(null, names, rows), StandardCharsets.UTF_8);
        }

        String xml(String root, List<String> names, List<List<Object>> rows) throws Exception {
            Method m = writer().getMethod("xml", String.class, List.class, List.class);
            return new String((byte[]) m.invoke(null, root, names, rows), StandardCharsets.UTF_8);
        }
    }

    @Test
    public void theExportModuleAndTheSharedWriterAreGeneratedForEveryServedReport() throws Exception {
        Loaded l = generate(Map.of("maxRows", "60"));
        assertTrue(Files.exists(l.src().resolve("acme/sales/ReportExportWriter.java")));
        Class<?> export = l.cl().loadClass(PKG + ".ExportCellsExport");
        assertEquals(List.of("label", "cells", "totalCents"), export.getField("FIELDS").get(null));
        // a report with no view source is not served and gets nothing
        assertFalse(Files.exists(l.src().resolve("acme/sales/InvoiceDaysExport.java")));
        assertEquals(60, export.getField("MAX_ROWS").get(null));
    }

    @Test
    public void maxRowsDefaultsToOneHundredThousand() throws Exception {
        Loaded l = generate(Map.of());
        assertEquals(100_000, l.cl().loadClass(PKG + ".ExportCellsExport").getField("MAX_ROWS").get(null));
    }

    @Test
    public void csvQuotesGuardsAndEndsEveryRecordWithCrLf() throws Exception {
        Loaded l = generate(Map.of());
        List<List<Object>> rows = List.of(
            List.of(l.cell("text", "=SUM(1+1)"), l.cell("raw", 1L)),
            List.of(l.cell("text", "+1"), l.cell("raw", 1L)),
            List.of(l.cell("text", "-2"), l.cell("raw", -2L)),
            List.of(l.cell("text", "@cmd"), l.cell("raw", 1L)),
            List.of(l.cell("text", "\tTab"), l.cell("raw", 1L)),
            List.of(l.cell("text", "\rCr"), l.cell("raw", 1L)),
            List.of(l.cell("text", "a,b"), l.cell("raw", 1L)),
            List.of(l.cell("text", "say \"hi\""), l.cell("raw", 1L)),
            List.of(l.cell("text", "line one\nline two"), l.cell("raw", 1L)),
            List.of(l.cell("text", null), l.cell("raw", -5L)),
            List.of(l.cell("text", ""), l.cell("decimal", new BigDecimal("-12.500"))));
        String csv = l.csv(List.of("label", "n"), rows);
        assertEquals("label,n\r\n"
            + "'=SUM(1+1),1\r\n"
            + "'+1,1\r\n"
            + "'-2,-2\r\n"
            + "'@cmd,1\r\n"
            + "'\tTab,1\r\n"
            // a leading CR is guarded, then the cell is quoted because it holds a CR
            + "\"'\rCr\",1\r\n"
            + "\"a,b\",1\r\n"
            + "\"say \"\"hi\"\"\",1\r\n"
            + "\"line one\nline two\",1\r\n"
            + ",-5\r\n"
            + ",-12.500\r\n", csv);
    }

    @Test
    public void numbersAreNeverGuardedAndStringWireDecimalsAreCanonical() throws Exception {
        Loaded l = generate(Map.of(), new WireFormat(WireFormat.Decimals.STRING, WireFormat.NullMembers.OMIT));
        String csv = l.csv(List.of("a", "b", "c", "d"), List.of(List.of(l.cell("raw", -7),
            l.cell("decimal", new BigDecimal("0.0")), l.cell("decimal", new BigDecimal("1E+3")),
            l.cell("decimal", new BigDecimal("12.50")))));
        assertEquals("a,b,c,d\r\n-7,0,1000,12.5\r\n", csv);
    }

    @Test
    public void nativeWireDecimalsAreWhatJacksonWritesForTheListRoute() throws Exception {
        Loaded l = generate(Map.of());
        BigDecimal value = new BigDecimal("12.50");
        String jackson = new ObjectMapper().writeValueAsString(value);
        assertEquals("12.50", jackson);
        assertEquals("a\r\n" + jackson + "\r\n", l.csv(List.of("a"), List.of(List.of(l.cell("decimal", value)))));
    }

    @Test
    public void temporalCellsKeepTheirSecondsAsTheJsonWireDoes() throws Exception {
        Loaded l = generate(Map.of());
        String csv = l.csv(List.of("d", "t", "ldt", "frac"), List.of(List.of(
            l.cell("raw", LocalDate.of(2026, 1, 1)),
            l.cell("raw", LocalTime.of(10, 0)),
            l.cell("raw", LocalDateTime.of(2026, 1, 1, 10, 0)),
            l.cell("raw", LocalTime.of(10, 0, 0, 120_000_000)))));
        assertEquals("d,t,ldt,frac\r\n2026-01-01,10:00:00,2026-01-01T10:00:00,10:00:00.12\r\n", csv);
    }

    @Test
    public void theBomIsAGeneratedConstantOffByDefault() throws Exception {
        Loaded off = generate(Map.of());
        assertEquals(false, off.writer().getField("EXPORT_CSV_BOM").get(null));
        assertFalse(off.csv(List.of("a"), List.of()).startsWith("﻿"));
        Loaded on = generate(Map.of("csvBom", "true"));
        assertEquals(true, on.writer().getField("EXPORT_CSV_BOM").get(null));
        assertTrue(on.csv(List.of("a"), List.of()).startsWith("﻿a\r\n"));
    }

    @Test
    public void xmlEscapesAndWritesNullsAsEmptyElementsByDefault() throws Exception {
        Loaded l = generate(Map.of());
        String xml = l.xml("R", List.of("label", "n"), List.of(
            List.of(l.cell("text", "<&>\"'"), l.cell("raw", 1L)),
            List.of(l.cell("text", null), l.cell("raw", 2L)),
            List.of(l.cell("text", "=not guarded in xml"), l.cell("raw", 3L))));
        assertEquals("<R><row><label>&lt;&amp;&gt;\"'</label><n>1</n></row>"
            + "<row><label/><n>2</n></row>"
            + "<row><label>=not guarded in xml</label><n>3</n></row></R>", xml);
    }

    @Test
    public void xmlNilDeclaresTheNamespaceOnTheRootAndMarksNulls() throws Exception {
        Loaded l = generate(Map.of("xmlNulls", "nil"));
        String xml = l.xml("R", List.of("label"), List.of(List.of(l.cell("text", null))));
        assertEquals("<R xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">"
            + "<row><label xsi:nil=\"true\"/></row></R>", xml);
        // no rows: just the root, still declaring the namespace
        assertTrue(l.xml("R", List.of("label"), List.of()).startsWith("<R xmlns:xsi="));
    }

    @Test
    public void xmlHasNoDeclarationAndReplacesCharactersXmlCannotHold() throws Exception {
        Loaded l = generate(Map.of());
        String xml = l.xml("R", List.of("a"), List.of(List.of(l.cell("text", "x\u0001y"))));
        assertEquals("<R><row><a>x�y</a></row></R>", xml);
    }

    @Test
    public void anInvalidXmlNullsValueIsRefused() throws Exception {
        try {
            generate(Map.of("xmlNulls", "bogus"));
        } catch (com.metaobjects.generator.GeneratorException expected) {
            assertTrue(expected.getMessage(), expected.getMessage().contains("xmlNulls"));
            return;
        }
        throw new AssertionError("xmlNulls=bogus was accepted");
    }

    @Test
    public void theReportControllerChangesOnlyWhenTheRunHoldsAReportExportGenerator() throws Exception {
        String json = Files.readString(corpusMeta(), StandardCharsets.UTF_8);
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "report-export", json);
        Path bare = tmp.newFolder().toPath();
        Path plain = tmp.newFolder().toPath();
        Path wired = tmp.newFolder().toPath();
        run(new SpringControllerGenerator(), loader, bare, Map.of());
        SpringControllerGenerator withoutExport = new SpringControllerGenerator();
        withoutExport.setRun(List.of(withoutExport, new SpringDtoGenerator()));
        run(withoutExport, loader, plain, Map.of());
        SpringControllerGenerator withExport = new SpringControllerGenerator();
        withExport.setRun(List.of(withExport, new SpringReportExportGenerator()));
        run(withExport, loader, wired, Map.of());
        String report = "acme/sales/ExportCellsController.java";
        assertEquals(Files.readString(bare.resolve(report)), Files.readString(plain.resolve(report)));
        assertNotEquals(Files.readString(plain.resolve(report)), Files.readString(wired.resolve(report)));
        // an entity's controller never gains the branch
        String entity = "acme/sales/InvoiceController.java";
        assertEquals(Files.readString(plain.resolve(entity)), Files.readString(wired.resolve(entity)));
    }
}
