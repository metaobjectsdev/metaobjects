package com.metaobjects.integration.api.generated;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.generator.spring.SpringValueObjectGenerator;
import com.metaobjects.integration.api.TomcatHost;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.object.MetaObject;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
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
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

/**
 * ADR-0019 Amendment 1: hosts the GENERATED Spring controllers of the decimal api-contract
 * sub-corpus over real HTTP (embedded Tomcat) and over a real database through OMDB: the writable
 * {@code Entry} entity ({@code /api/entries}) and the served {@code EntryTotals} report
 * ({@code /api/entry_totals}). The controllers, DTOs, repository interfaces and filter allowlists are
 * generated UNMODIFIED; the adopter-owned seams are {@link OmdbEntryRepositorySource} and
 * {@link OmdbReportRepositorySource}. Same shape as {@link GeneratedReportControllerHarness}.
 */
public final class GeneratedDecimalControllerHarness implements AutoCloseable {

    private static final String PKG = OmdbEntryRepositorySource.PKG;

    private final ObjectMapper mapper = new ObjectMapper()
        .registerModule(new JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
    private final MetaDataLoader loader;
    private final URLClassLoader classLoader;
    private final Constructor<?> entryRepoCtor;
    private final Constructor<?> entryControllerCtor;
    private final Constructor<?> totalsRepoCtor;
    private final Constructor<?> totalsControllerCtor;
    private final Constructor<?> sampleControllerCtor;
    private final Constructor<?> sampleRepoCtor;

    private TomcatHost host;

    public GeneratedDecimalControllerHarness(Path corpusRoot, Path genDir) throws Exception {
        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        this.loader = loadCorpus(corpusRoot.resolve("meta.json"));
        // ADR-0058: the committed config at the api-contract corpus root declares naming.columns: literal.
        loader.getRoot().setPhysicalNaming(
            com.metaobjects.config.SourceResolver.resolvePhysicalNaming(corpusRoot.getParent()));

        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        Path pkgDir = srcDir.resolve(PKG.replace('.', '/'));
        for (String generated : List.of("EntryController", "SampleController", "EntryTotalsController")) {
            if (!Files.exists(pkgDir.resolve(generated + ".java"))) {
                throw new IllegalStateException("codegen did not emit " + generated + " under " + pkgDir);
            }
        }
        Files.writeString(pkgDir.resolve("OmdbEntryRepository.java"), OmdbEntryRepositorySource.SOURCE);
        Files.writeString(pkgDir.resolve("OmdbSampleRepository.java"), OmdbEntryRepositorySource.sourceFor("Sample"));
        Files.writeString(pkgDir.resolve(OmdbReportRepositorySource.simpleName("EntryTotals") + ".java"),
            OmdbReportRepositorySource.source(PKG, "EntryTotals"));

        compile(srcDir, classesDir);

        this.classLoader = new URLClassLoader(new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());
        Class<?> entryRepo = classLoader.loadClass(PKG + ".EntryRepository");
        this.entryControllerCtor = classLoader.loadClass(PKG + ".EntryController")
            .getDeclaredConstructor(entryRepo, ObjectMapper.class, Validator.class);
        this.entryRepoCtor = classLoader.loadClass(OmdbEntryRepositorySource.FQCN)
            .getDeclaredConstructor(ObjectManagerDB.class, MetaObject.class);
        Class<?> sampleRepo = classLoader.loadClass(PKG + ".SampleRepository");
        this.sampleControllerCtor = classLoader.loadClass(PKG + ".SampleController")
            .getDeclaredConstructor(sampleRepo, ObjectMapper.class, Validator.class);
        this.sampleRepoCtor = classLoader.loadClass(OmdbEntryRepositorySource.fqcnFor("Sample"))
            .getDeclaredConstructor(ObjectManagerDB.class, MetaObject.class);
        Class<?> totalsRepo = classLoader.loadClass(PKG + ".EntryTotalsRepository");
        this.totalsControllerCtor = classLoader.loadClass(PKG + ".EntryTotalsController")
            .getDeclaredConstructor(totalsRepo);
        this.totalsRepoCtor = classLoader.loadClass(OmdbReportRepositorySource.fqcn(PKG, "EntryTotals"))
            .getDeclaredConstructor(ObjectManagerDB.class, MetaObject.class);
    }

    /** Mount both generated controllers, each over an OMDB-backed repository on {@code omdb}. */
    public void start(ObjectManagerDB omdb) throws Exception {
        MetaObject entry = find("Entry");
        MetaObject totals = find("EntryTotals");
        Object entryController = entryControllerCtor.newInstance(entryRepoCtor.newInstance(omdb, entry), mapper, validator);
        Object sampleController = sampleControllerCtor.newInstance(
            sampleRepoCtor.newInstance(omdb, find("Sample")), mapper, validator);
        Object totalsController = totalsControllerCtor.newInstance(totalsRepoCtor.newInstance(omdb, totals));
        if (host != null) host.close();
        this.host = TomcatHost.start(mapper, entryController, sampleController, totalsController);
    }

    private MetaObject find(String name) {
        return loader.getMetaObjects().stream().filter(o -> o.getShortName().equals(name)).findFirst()
            .orElseThrow(() -> new IllegalStateException("no " + name + " in the model"));
    }

    public MetaDataLoader loader() {
        return loader;
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

    private static MetaDataLoader loadCorpus(Path metaJson) {
        URI uri = URIHelper.toURI(
            "model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "api-contract-decimal-generated");
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
