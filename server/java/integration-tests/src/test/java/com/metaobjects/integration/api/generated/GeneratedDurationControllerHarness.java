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
 * Hosts the GENERATED Spring controller of the duration api-contract sub-corpus
 * ({@code fixtures/api-contract-conformance/duration/}) over real HTTP (embedded Tomcat) and a real
 * database through OMDB: the writable {@code Timer} entity ({@code /api/timers}). The controller, DTO,
 * repository interface and filter allowlist are generated UNMODIFIED; the adopter-owned seam is
 * {@link OmdbTimerRepositorySource}. Same shape as {@link GeneratedDecimalControllerHarness}.
 */
public final class GeneratedDurationControllerHarness implements AutoCloseable {

    private static final String PKG = "acme.ops";

    private final ObjectMapper mapper = new ObjectMapper()
        .registerModule(new JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
    private final MetaDataLoader loader;
    private final URLClassLoader classLoader;
    private final Constructor<?> timerRepoCtor;
    private final Constructor<?> timerControllerCtor;

    private TomcatHost host;

    public GeneratedDurationControllerHarness(Path corpusRoot, Path genDir) throws Exception {
        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        this.loader = loadCorpus(corpusRoot.resolve("meta.json"));
        // ADR-0058: the committed config at the api-contract corpus root declares naming.columns: literal.
        loader.getRoot().setPhysicalNaming(
            com.metaobjects.config.SourceResolver.resolvePhysicalNaming(corpusRoot.getParent()));
        // ADR-0019 Amendment 2 - the corpus's config.json (found by walking up from the corpus dir) pins the wire form (string / omit).
        loader.getRoot().setWireFormat(
                com.metaobjects.config.SourceResolver.discoverWireFormat(java.util.List.of((corpusRoot.getParent()).toUri()))
                        .orElse(com.metaobjects.config.WireFormat.DEFAULT));

        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        Path pkgDir = srcDir.resolve(PKG.replace('.', '/'));
        if (!Files.exists(pkgDir.resolve("TimerController.java"))) {
            throw new IllegalStateException("codegen did not emit TimerController under " + pkgDir);
        }
        Files.writeString(pkgDir.resolve("OmdbTimerRepository.java"), OmdbTimerRepositorySource.SOURCE);

        compile(srcDir, classesDir);

        this.classLoader = new URLClassLoader(new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());
        Class<?> timerRepo = classLoader.loadClass(PKG + ".TimerRepository");
        this.timerControllerCtor = classLoader.loadClass(PKG + ".TimerController")
            .getDeclaredConstructor(timerRepo, ObjectMapper.class, Validator.class);
        this.timerRepoCtor = classLoader.loadClass(OmdbTimerRepositorySource.FQCN)
            .getDeclaredConstructor(ObjectManagerDB.class, MetaObject.class);
    }

    /** Mount the generated controller over an OMDB-backed repository on {@code omdb}. */
    public void start(ObjectManagerDB omdb) throws Exception {
        Object controller = timerControllerCtor.newInstance(
            timerRepoCtor.newInstance(omdb, find("Timer")), mapper, validator);
        if (host != null) host.close();
        this.host = TomcatHost.start(mapper, controller);
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
            "api-contract-duration-generated");
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
