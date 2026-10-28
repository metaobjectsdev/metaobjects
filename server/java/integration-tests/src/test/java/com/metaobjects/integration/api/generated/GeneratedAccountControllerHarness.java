package com.metaobjects.integration.api.generated;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.integration.api.TomcatHost;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;

import jakarta.validation.Validation;
import jakarta.validation.Validator;

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
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * #484 — host the GENERATED Spring {@code AccountController} of the {@code secret-fields}
 * sub-corpus over real HTTP (embedded Tomcat) and drive its scenarios. Sibling of
 * {@link GeneratedAuthorControllerHarness}; the only hand-written piece is
 * {@link InMemoryAccountRepositorySource}, the consumer seam.
 */
public final class GeneratedAccountControllerHarness implements AutoCloseable {

    private static final String ENTITY_PKG = "acme.secrets";

    private final ObjectMapper mapper = new ObjectMapper();
    private final URLClassLoader classLoader;
    private final Class<?> dtoClass;
    private final Constructor<?> controllerCtor;
    private final Constructor<?> repoCtor;
    private final List<Map<String, Object>> seedRows;
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

    private TomcatHost host;
    private Object repo;

    /**
     * @param corpusRoot {@code fixtures/api-contract-conformance/secret-fields}
     * @param configRoot {@code fixtures/api-contract-conformance} (holds the committed config)
     */
    public GeneratedAccountControllerHarness(Path corpusRoot, Path configRoot, Path genDir,
                                             List<Map<String, Object>> seedRows) throws Exception {
        this.seedRows = seedRows;
        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        MetaDataLoader loader = loadCorpus(corpusRoot.resolve("meta.json"));
        loader.getRoot().setPhysicalNaming(
                com.metaobjects.config.SourceResolver.resolvePhysicalNaming(configRoot));
        loader.getRoot().setWireFormat(
                com.metaobjects.config.SourceResolver.discoverWireFormat(List.of(configRoot.toUri()))
                        .orElse(com.metaobjects.config.WireFormat.DEFAULT));

        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        Path repoImpl = srcDir.resolve(ENTITY_PKG.replace('.', '/')).resolve("InMemoryAccountRepository.java");
        Files.createDirectories(repoImpl.getParent());
        Files.writeString(repoImpl, InMemoryAccountRepositorySource.SOURCE);

        compile(srcDir, classesDir);

        this.classLoader = new URLClassLoader(
            new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());
        this.dtoClass = classLoader.loadClass(ENTITY_PKG + ".AccountDto");
        Class<?> repoInterface = classLoader.loadClass(ENTITY_PKG + ".AccountRepository");
        this.controllerCtor = classLoader.loadClass(ENTITY_PKG + ".AccountController")
            .getDeclaredConstructor(repoInterface, ObjectMapper.class, Validator.class);
        this.repoCtor = classLoader.loadClass(InMemoryAccountRepositorySource.FQCN)
            .getDeclaredConstructor(List.class);
    }

    /** Re-seed for a scenario: a fresh repository, controller and Tomcat. */
    public void reset() throws Exception {
        List<Object> dtos = new ArrayList<>();
        for (Map<String, Object> row : seedRows) dtos.add(mapper.convertValue(row, dtoClass));
        this.repo = repoCtor.newInstance(dtos);
        Object controller = controllerCtor.newInstance(repo, mapper, validator);
        if (host != null) host.close();
        this.host = TomcatHost.start(mapper, controller);
    }

    public Response exchange(String method, String path, Object jsonBody) throws Exception {
        TomcatHost.Response res = host.exchange(
            method, path, jsonBody == null ? null : mapper.writeValueAsString(jsonBody));
        return new Response(res.status(), res.body());
    }

    /**
     * The rows as the repository holds them now, read straight from the in-memory seam (not over
     * HTTP, which hides {@code pinHash}): one map per row with every DTO component by name.
     */
    public List<Map<String, Object>> storedRows() throws Exception {
        java.lang.reflect.Method list = null;
        for (java.lang.reflect.Method m : repo.getClass().getMethods()) {
            if (m.getName().equals("list") && m.getParameterCount() == 4) list = m;
        }
        List<?> rows = (List<?>) list.invoke(repo, 1000, 0, null, null);
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object row : rows) {
            Map<String, Object> m = new java.util.LinkedHashMap<>();
            for (java.lang.reflect.RecordComponent c : dtoClass.getRecordComponents()) {
                m.put(c.getName(), c.getAccessor().invoke(row));
            }
            out.add(m);
        }
        return out;
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
            "api-contract-secret-fields-generated");
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
        if (sources.isEmpty()) throw new IllegalStateException("no generated .java sources under " + srcDir);

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac == null) {
            throw new IllegalStateException("JDK (not JRE) required — getSystemJavaCompiler() returned null");
        }
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        // -parameters: the generated controller relies on reflective parameter names, as Spring Boot builds do.
        List<String> opts = List.of("-classpath", cp, "-d", classesDir.toString(), "-parameters");

        if (!javac.getTask(null, fm, diags, opts, null, fm.getJavaFileObjectsFromFiles(sources)).call()) {
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
