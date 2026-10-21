package com.metaobjects.integration.api.generated;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.integration.api.TomcatHost;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.object.MetaObject;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

import java.io.File;
import java.lang.reflect.Constructor;
import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * FR-044 Plan 3 — host the GENERATED Java Spring {@code @RestController} of every served
 * report in the {@code report/} api-contract sub-corpus over real HTTP (one embedded
 * Tomcat, {@link TomcatHost}) and drive the scenarios against them. Sibling of
 * {@link GeneratedProjectionControllerHarness}.
 *
 * <p>The artifacts under test are the GENERATED {@code <Report>Controller} (the list route
 * and a 405 on the collection {@code POST}, no item route), the {@code <Report>Dto} row,
 * the {@code <Report>FilterAllowlist} and the read-only {@code <Report>Repository}
 * interface. The only hand-written piece is {@link OmdbReportRepositorySource}, the consumer
 * seam: an OMDB-backed repository over the real database the caller provisioned from the
 * TypeScript-produced schema artifact. No SQL for a report is produced here (ADR-0015).</p>
 *
 * <p>The WHOLE model is generated and compiled, the writable {@code Invoice} entity
 * included, because the interesting failure is a gate that admits one shape and breaks
 * another. Only the report controllers are MOUNTED: no scenario exercises the entity.</p>
 */
public final class GeneratedReportControllerHarness implements AutoCloseable {

    private static final String ENTITY_PKG = "acme.sales";

    /** A served report's generated row type and the constructors a scenario rebuilds it with. */
    private record Mount(String report, Constructor<?> repoCtor, Constructor<?> controllerCtor) {}

    /**
     * {@code JavaTimeModule}, with dates as ISO strings: a time dimension at a grain is a
     * {@code LocalDate} component and must reach the wire as {@code YYYY-MM-DD}. This is the
     * mapper a Spring Boot application gets by default. Nulls are written (Jackson's
     * default), so a null measure is a present key.
     */
    private final ObjectMapper mapper = new ObjectMapper()
        .registerModule(new JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    private final MetaDataLoader loader;
    private final URLClassLoader classLoader;
    private final Map<String, Mount> mounts = new LinkedHashMap<>();

    private TomcatHost host;

    /**
     * @param served     the served reports (each must have been generated), by report name
     * @param sourceless a report in the model that declares no view and must generate nothing
     */
    public GeneratedReportControllerHarness(Path corpusRoot, Path genDir, List<String> served,
                                            String sourceless) throws Exception {
        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        this.loader = loadCorpus(corpusRoot.resolve("meta.json"));

        // ADR-0058 - this corpus's committed .metaobjects/config.json sits at the api-contract
        // corpus root (corpusRoot's parent, not under report/) and declares naming.columns:
        // literal; the committed schema was created under it, and every field here declares no
        // @column, so the generated columns and OMDB's reads of them depend on this. Read with
        // the SAME NeutralConfig reader every port uses.
        loader.getRoot().setPhysicalNaming(
                com.metaobjects.config.SourceResolver.resolvePhysicalNaming(corpusRoot.getParent()));

        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        Path pkgDir = srcDir.resolve(ENTITY_PKG.replace('.', '/'));

        // Every served report's controller must have been emitted at all: a silently
        // skipped generator would otherwise surface as a ClassNotFoundException with no
        // hint that codegen, not the harness, was the cause.
        for (String report : served) {
            Path emitted = pkgDir.resolve(report + "Controller.java");
            if (!Files.exists(emitted)) {
                throw new IllegalStateException(
                    "no controller was generated for the served report " + report + " at " + emitted
                        + " — the FR-044 emit gate did not admit a view-backed object.report");
            }
        }
        // ...and a sourceless report must have generated NOTHING. It sits in the model so
        // that a port which serves every report it finds fails here.
        try (Stream<Path> s = Files.list(pkgDir)) {
            List<String> leaked = s.map(p -> p.getFileName().toString())
                .filter(n -> n.startsWith(sourceless))
                .sorted().collect(Collectors.toList());
            if (!leaked.isEmpty()) {
                throw new IllegalStateException(
                    "the sourceless report " + sourceless + " declares no view and must stay inert,"
                        + " but codegen emitted " + leaked);
            }
        }

        for (String report : served) {
            Files.writeString(pkgDir.resolve(OmdbReportRepositorySource.simpleName(report) + ".java"),
                OmdbReportRepositorySource.source(report));
        }

        compile(srcDir, classesDir);

        this.classLoader = new URLClassLoader(
            new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());
        for (String report : served) {
            Class<?> repoInterface = classLoader.loadClass(ENTITY_PKG + "." + report + "Repository");
            // (<Report>Repository) — no ObjectMapper, no Validator: nothing here binds a body.
            Constructor<?> controllerCtor =
                classLoader.loadClass(ENTITY_PKG + "." + report + "Controller").getDeclaredConstructor(repoInterface);
            Constructor<?> repoCtor = classLoader.loadClass(OmdbReportRepositorySource.fqcn(report))
                .getDeclaredConstructor(ObjectManagerDB.class, MetaObject.class);
            mounts.put(report, new Mount(report, repoCtor, controllerCtor));
        }
    }

    /** The loaded model, so the caller can read the same physical naming the generated code was built under. */
    public MetaDataLoader loader() {
        return loader;
    }

    /**
     * Mount every served report's generated controller, each over an OMDB-backed repository on
     * {@code omdb}, on one Tomcat. Replaces a previous mount.
     */
    public void start(ObjectManagerDB omdb) throws Exception {
        List<Object> controllers = new ArrayList<>();
        for (Mount m : mounts.values()) {
            MetaObject report = loader.getMetaObjects().stream()
                .filter(o -> o.getShortName().equals(m.report())).findFirst()
                .orElseThrow(() -> new IllegalStateException("no report " + m.report() + " in the model"));
            controllers.add(m.controllerCtor().newInstance(m.repoCtor().newInstance(omdb, report)));
        }
        if (host != null) host.close();
        this.host = TomcatHost.start(mapper, controllers.toArray());
    }

    public Response exchange(String method, String path, Object jsonBody) throws Exception {
        TomcatHost.Response res = host.exchange(method, path, jsonBody == null ? null : mapper.writeValueAsString(jsonBody));
        return new Response(res.status(), res.body());
    }

    public Object parseBody(String body) {
        return TomcatHost.parseBody(mapper, body);
    }

    @Override
    public void close() throws Exception {
        if (host != null) host.close();
        classLoader.close();
    }

    public record Response(int status, String body) {}

    // -----------------------------------------------------------------------
    // setup helpers (mirror GeneratedProjectionControllerHarness)
    // -----------------------------------------------------------------------

    private static MetaDataLoader loadCorpus(Path metaJson) {
        URI uri = URIHelper.toURI(
            "model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "api-contract-report-generated");
        loader.setSourceURIs(List.of(uri));
        loader.init();
        return loader;
    }

    private static void runGenerator(Object generator, MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).setArgs(args);
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).execute(loader);
    }

    private static void compile(Path srcDir, Path classesDir) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(srcDir)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        if (sources.isEmpty()) {
            throw new IllegalStateException("no generated .java sources under " + srcDir);
        }

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac == null) {
            throw new IllegalStateException(
                "JDK (not JRE) required — ToolProvider.getSystemJavaCompiler() returned null");
        }
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        List<String> opts = List.of("-classpath", cp, "-d", classesDir.toString(), "-parameters");

        boolean ok = javac.getTask(null, fm, diags, opts, null,
            fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null) {
                    sb.append("    at ").append(d.getSource().getName())
                      .append(':').append(d.getLineNumber()).append('\n');
                }
            }
            throw new IllegalStateException(sb.toString());
        }
    }
}
