package com.metaobjects.integration.kotlin.api

import com.fasterxml.jackson.databind.ObjectMapper
import org.apache.catalina.startup.Tomcat
import org.springframework.context.annotation.Configuration
import org.springframework.http.converter.HttpMessageConverter
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext
import org.springframework.web.servlet.DispatcherServlet
import org.springframework.web.servlet.config.annotation.EnableWebMvc
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/**
 * Hosts a GENERATED controller on a real embedded Tomcat and talks to it over a socket.
 *
 * The generated lanes used to drive the controller through MockMvc, which hands it a request no
 * servlet container ever built. Three real defects lived exactly in that gap and shipped with
 * every lane green: Tomcat 400s a raw `[` or `]` in a query before the controller runs; Tomcat
 * drops a parameter whose value holds a malformed escape from the parameter map (the Kotlin
 * list handlers read that map, so the filter vanished); and `java.net.URLDecoder` throws on that
 * same raw `%`. This host puts the container back in the path.
 *
 * Tomcat runs with `relaxedQueryChars="[]"` — the documented adopter wiring
 * (`server.tomcat.relaxed-query-chars=[,]`) for clients that send raw brackets, which the corpus
 * does. The client is a raw HTTP/1.0 socket, not `java.net.http`: a corpus path may carry a raw
 * `%` that [java.net.URI] refuses to hold, and HTTP/1.0 means Tomcat delimits the response by
 * closing the connection rather than chunking it.
 */
class TomcatHost private constructor(
    private val tomcat: Tomcat,
    private val baseDir: Path,
    private val port: Int,
) : AutoCloseable {

    /** HTTP status + raw body string. */
    data class Response(val status: Int, val body: String)

    /** Send one request exactly as [path] spells it; [jsonBody] may be null. */
    fun exchange(method: String, path: String, jsonBody: String?): Response {
        val body = jsonBody?.toByteArray(StandardCharsets.UTF_8)
        val head = buildString {
            append(method).append(' ').append(path).append(" HTTP/1.0\r\n")
            append("Host: 127.0.0.1:").append(port).append("\r\n")
            append("Accept: application/json\r\n")
            if (body != null) {
                append("Content-Type: application/json\r\n")
                append("Content-Length: ").append(body.size).append("\r\n")
            }
            append("\r\n")
        }
        Socket("127.0.0.1", port).use { socket ->
            val out = socket.getOutputStream()
            out.write(head.toByteArray(StandardCharsets.UTF_8))
            if (body != null) out.write(body)
            out.flush()
            return parse(socket.getInputStream().readAllBytes())
        }
    }

    override fun close() {
        tomcat.stop()
        tomcat.destroy()
        baseDir.toFile().deleteRecursively()
    }

    /** Spring MVC with the corpus mapper as the only JSON converter. */
    @Configuration
    @EnableWebMvc
    open class MvcConfig(private val corpusObjectMapper: ObjectMapper) : WebMvcConfigurer {
        override fun configureMessageConverters(converters: MutableList<HttpMessageConverter<*>>) {
            converters.add(MappingJackson2HttpMessageConverter(corpusObjectMapper))
        }
    }

    companion object {
        /**
         * Boot Tomcat with [controllers] as the only handlers, serialized by [mapper]. Several
         * controllers share one server, and Spring's own mappings route between them.
         */
        fun start(mapper: ObjectMapper, vararg controllers: Any): TomcatHost {
            require(controllers.isNotEmpty()) { "no controller to host" }
            val spring = AnnotationConfigWebApplicationContext()
            spring.register(MvcConfig::class.java)
            spring.addBeanFactoryPostProcessor { bf ->
                controllers.forEachIndexed { i, c -> bf.registerSingleton("generatedController$i", c) }
                bf.registerSingleton("corpusObjectMapper", mapper)
            }
            // The generated controllers' classes live in a child loader over freshly compiled output.
            spring.classLoader = controllers[0].javaClass.classLoader

            val baseDir = Files.createTempDirectory("mo-tomcat-")
            val tomcat = Tomcat()
            tomcat.setBaseDir(baseDir.toString())
            tomcat.setPort(0)
            tomcat.connector.setProperty("relaxedQueryChars", "[]")
            val context = tomcat.addContext("", baseDir.toString())
            Tomcat.addServlet(context, "dispatcher", DispatcherServlet(spring)).setLoadOnStartup(1)
            context.addServletMappingDecoded("/", "dispatcher")
            tomcat.start()
            return TomcatHost(tomcat, baseDir, tomcat.connector.localPort)
        }

        /**
         * A response body in the assertion shape: parsed JSON, or the raw text when it is not
         * JSON. A real container answers a route nothing mounts with its OWN error page (Tomcat's
         * is HTML), which a scenario asserts by status only — so a non-JSON body is data.
         */
        fun parseBody(mapper: ObjectMapper, body: String?): Any? {
            if (body.isNullOrEmpty()) return null
            return try {
                mapper.readValue(body, Any::class.java)
            } catch (notJson: com.fasterxml.jackson.core.JsonProcessingException) {
                body
            }
        }

        private fun parse(raw: ByteArray): Response {
            val text = String(raw, StandardCharsets.UTF_8)
            val split = text.indexOf("\r\n\r\n")
            val headers = if (split < 0) text else text.substring(0, split)
            val body = if (split < 0) "" else text.substring(split + 4)
            val statusLine = headers.lineSequence().firstOrNull().orEmpty()
            val parts = statusLine.split(' ', limit = 3)
            check(parts.size >= 2) { "no HTTP status line in response: $statusLine" }
            return Response(parts[1].toInt(), body)
        }
    }
}
