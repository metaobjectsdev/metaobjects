package com.metaobjects.integration.api;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.catalina.Context;
import org.apache.catalina.LifecycleException;
import org.apache.catalina.startup.Tomcat;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Hosts a GENERATED controller on a real embedded Tomcat and talks to it over a socket.
 *
 * <p>The generated lanes used to drive the controller through MockMvc, which hands it a
 * request no servlet container ever built. Three real defects lived exactly in that gap and
 * shipped with every lane green: Tomcat 400s a raw {@code [} or {@code ]} in a query before the
 * controller runs; Tomcat drops a parameter whose value holds a malformed escape from the
 * parameter map; and {@code java.net.URLDecoder} throws on that same raw {@code %}. This host
 * puts the container back in the path.
 *
 * <p>Tomcat runs with {@code relaxedQueryChars="[]"} — the documented adopter wiring
 * ({@code server.tomcat.relaxed-query-chars=[,]}) for clients that send raw brackets, which
 * the corpus does. The client is a raw HTTP/1.0 socket, not {@code java.net.http}: a corpus
 * path may carry a raw {@code %} that {@link java.net.URI} refuses to hold, and HTTP/1.0 means
 * Tomcat delimits the response by closing the connection rather than chunking it.
 */
public final class TomcatHost implements AutoCloseable {

    /** HTTP status + raw body string. */
    public record Response(int status, String body) {}

    private final Tomcat tomcat;
    private final Path baseDir;
    private final int port;

    private TomcatHost(Tomcat tomcat, Path baseDir, int port) {
        this.tomcat = tomcat;
        this.baseDir = baseDir;
        this.port = port;
    }

    /**
     * Boot Tomcat with {@code controllers} as the only handlers, serialized by {@code mapper}.
     * Several controllers share one server, and Spring's own mappings route between them.
     */
    public static TomcatHost start(ObjectMapper mapper, Object... controllers) throws LifecycleException, IOException {
        if (controllers.length == 0) throw new IllegalArgumentException("no controller to host");
        AnnotationConfigWebApplicationContext spring = new AnnotationConfigWebApplicationContext();
        spring.register(MvcConfig.class);
        spring.addBeanFactoryPostProcessor(bf -> {
            for (int i = 0; i < controllers.length; i++) bf.registerSingleton("generatedController" + i, controllers[i]);
            bf.registerSingleton("corpusObjectMapper", mapper);
        });
        // The generated controllers' classes live in a child loader over freshly compiled output.
        spring.setClassLoader(controllers[0].getClass().getClassLoader());

        Path baseDir = Files.createTempDirectory("mo-tomcat-");
        Tomcat tomcat = new Tomcat();
        tomcat.setBaseDir(baseDir.toString());
        tomcat.setPort(0);
        tomcat.getConnector().setProperty("relaxedQueryChars", "[]");
        Context context = tomcat.addContext("", baseDir.toString());
        Tomcat.addServlet(context, "dispatcher", new DispatcherServlet(spring)).setLoadOnStartup(1);
        context.addServletMappingDecoded("/", "dispatcher");
        tomcat.start();
        return new TomcatHost(tomcat, baseDir, tomcat.getConnector().getLocalPort());
    }

    /** Send one request exactly as {@code path} spells it; {@code jsonBody} may be null. */
    public Response exchange(String method, String path, String jsonBody) throws IOException {
        byte[] body = jsonBody == null ? null : jsonBody.getBytes(StandardCharsets.UTF_8);
        StringBuilder head = new StringBuilder()
            .append(method).append(' ').append(path).append(" HTTP/1.0\r\n")
            .append("Host: 127.0.0.1:").append(port).append("\r\n")
            .append("Accept: application/json\r\n");
        if (body != null) {
            head.append("Content-Type: application/json\r\n")
                .append("Content-Length: ").append(body.length).append("\r\n");
        }
        head.append("\r\n");
        try (Socket socket = new Socket("127.0.0.1", port)) {
            OutputStream out = socket.getOutputStream();
            out.write(head.toString().getBytes(StandardCharsets.UTF_8));
            if (body != null) out.write(body);
            out.flush();
            return parse(readAll(socket.getInputStream()));
        }
    }

    /**
     * A response body in the assertion shape: parsed JSON, or the raw text when it is not JSON.
     * A real container answers a route nothing mounts with its OWN error page (Tomcat's is
     * HTML), which a scenario asserts by status only — so a non-JSON body is data, not an error.
     */
    public static Object parseBody(ObjectMapper mapper, String body) {
        if (body == null || body.isEmpty()) return null;
        try {
            return mapper.readValue(body, Object.class);
        } catch (com.fasterxml.jackson.core.JsonProcessingException notJson) {
            return body;
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        in.transferTo(buf);
        return buf.toByteArray();
    }

    private static Response parse(byte[] raw) {
        String text = new String(raw, StandardCharsets.UTF_8);
        int split = text.indexOf("\r\n\r\n");
        String headers = split < 0 ? text : text.substring(0, split);
        String body = split < 0 ? "" : text.substring(split + 4);
        String statusLine = headers.lines().findFirst().orElse("");
        String[] parts = statusLine.split(" ", 3);
        if (parts.length < 2) throw new IllegalStateException("no HTTP status line in response: " + statusLine);
        return new Response(Integer.parseInt(parts[1]), body);
    }

    @Override
    public void close() throws Exception {
        tomcat.stop();
        tomcat.destroy();
        try (var walk = Files.walk(baseDir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        }
    }

    /** Spring MVC with the corpus mapper as the only JSON converter. */
    @Configuration
    @EnableWebMvc
    static class MvcConfig implements WebMvcConfigurer {
        private final ObjectMapper mapper;

        MvcConfig(ObjectMapper corpusObjectMapper) {
            this.mapper = corpusObjectMapper;
        }

        @Override
        public void configureMessageConverters(List<HttpMessageConverter<?>> converters) {
            converters.add(new MappingJackson2HttpMessageConverter(mapper));
        }
    }
}
