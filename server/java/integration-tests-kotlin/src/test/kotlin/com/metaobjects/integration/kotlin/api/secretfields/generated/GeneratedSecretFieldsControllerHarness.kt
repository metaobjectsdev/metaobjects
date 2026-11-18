package com.metaobjects.integration.kotlin.api.secretfields.generated

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.PropertyNamingStrategy
import com.fasterxml.jackson.databind.SerializationFeature
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.integration.kotlin.api.TomcatHost
import com.metaobjects.generator.kotlin.KotlinEntityGenerator
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator
import com.metaobjects.generator.kotlin.KotlinFilterAllowlistGenerator
import com.metaobjects.generator.kotlin.KotlinNamesGenerator
import com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator
import com.metaobjects.loader.uri.URIHelper
import com.metaobjects.metadata.ktx.loadUris
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.transactions.transaction
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText

/**
 * #484: host the GENERATED Kotlin Spring `AccountController` for the secret-fields corpus over real HTTP
 * (embedded Tomcat, in-memory H2). Same generate, compile, serve mechanism as the write-through harness.
 *
 * Beside the corpus model it loads [ACCOUNT_VIEW], a read-only projection whose `pinHash` extends
 * `Account.pinHash`, and mounts its generated controller too, so the read-only path's credential
 * redaction is driven over HTTP as well. [naming] is the host mapper's property naming strategy (what
 * `spring.jackson.property-naming-strategy` sets), null for Jackson's default. [customize] is applied to the host
 * mapper once the generated data class exists, with that class: it registers a mixin or serializer on it, as an
 * adopter's own mapper configuration may.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class GeneratedSecretFieldsControllerHarness(
    corpusRoot: Path,
    genDir: Path,
    private val rows: List<Map<String, Any?>>,
    naming: PropertyNamingStrategy? = null,
    customize: ((ObjectMapper, Class<*>) -> Unit)? = null,
) : AutoCloseable {

    private val mapper: ObjectMapper = ObjectMapper()
        .registerKotlinModule()
        // Mirrors Spring Boot's default mapper. The generated request handling does not depend on it:
        // it reads body keys off the raw JSON and the DTOs ignore unknown properties.
        .disable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .registerModule(JavaTimeModule())
        .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
        .apply { if (naming != null) propertyNamingStrategy = naming }

    private val controllerClass: Class<*>
    private val viewControllerClass: Class<*>
    private val accountTable: Table
    private var host: TomcatHost? = null
    private var db: Database? = null

    init {
        val metaJson = corpusRoot.resolve("secret-fields/meta.json")
        val uri: URI = URIHelper.toURI("model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'))
        Files.createDirectories(genDir)
        val viewModel = genDir.resolve("account-view.json")
        Files.writeString(viewModel, ACCOUNT_VIEW)
        val viewUri: URI = URIHelper.toURI("model:file:" + viewModel.toAbsolutePath().toString().replace('\\', '/'))
        val loader = loadUris("api-contract-secret-fields-generated", listOf(uri, viewUri))
        // ADR-0058 — this corpus's committed .metaobjects/config.json (at corpusRoot,
        // fixtures/api-contract-conformance/) declares naming.columns: literal; every field
        // here declares no @column, so the generated columns and the runtime's reads of them
        // depend on this. Read with the SAME NeutralConfig reader every port uses.
        loader.root.physicalNaming =
            com.metaobjects.config.SourceResolver.resolvePhysicalNaming(corpusRoot)
        // ADR-0019 Amendment 2: the same file pins wire (decimals: string, nullMembers: omit), so the
        // generated serializers write the portable form. Discovered by walking up from the meta file, so a
        // sub-corpus directory (jsonb/, m2m/, ...) reads the config at the api-contract corpus root.
        loader.root.wireFormat = com.metaobjects.config.SourceResolver
            .discoverWireFormat(listOf(java.nio.file.Path.of(corpusRoot.toString(), "meta.json").toUri()))
            .orElse(com.metaobjects.config.WireFormat.DEFAULT)

        val srcDir = genDir.resolve("src")
        Files.createDirectories(srcDir)
        for (g in listOf(
            KotlinEntityGenerator(),
            KotlinNamesGenerator(),
            KotlinExposedTableGenerator(),
            KotlinFilterAllowlistGenerator(),
            KotlinSpringControllerGenerator(),
        )) {
            // Task 6 — free compile-level proof that <Entity>Names const val references
            // actually resolve; useNames is ignored by every other generator. This is
            // also the write-through lane — the ONE existing corpus fixture that
            // exercises Names substitution against emitWriteThrough's TWO Exposed
            // objects (OrderTable + OrderView) sharing one entity's column names.
            g.setArgs(mapOf("outputDir" to srcDir.toString(), "useNames" to "true"))
            g.execute(loader)
        }

        val sources = Files.walk(srcDir).use { stream ->
            stream.filter { it.isRegularFile() && it.toString().endsWith(".kt") }
                .map { path -> SourceFile.kotlin(srcDir.relativize(path).toString().replace('/', '_'), path.readText()) }
                .toList()
        }
        check(sources.isNotEmpty()) { "no generated .kt sources under $srcDir" }

        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        check(result.exitCode == KotlinCompilation.ExitCode.OK) {
            "generated Kotlin failed to compile:\n${result.messages}"
        }

        customize?.invoke(mapper, result.classLoader.loadClass("$ENTITY_PKG.Account"))
        this.controllerClass = result.classLoader.loadClass(CONTROLLER_FQCN)
        this.viewControllerClass = result.classLoader.loadClass(VIEW_CONTROLLER_FQCN)
        this.accountTable = result.classLoader.loadClass(ACCOUNT_TABLE_FQCN).getDeclaredField("INSTANCE").get(null) as Table
    }

    /** Rebuild a fresh in-memory H2 + seed + controller + Tomcat. */
    fun reset() {
        val dbName = "secret_fields_${dbSeq.incrementAndGet()}"
        val db = Database.connect("jdbc:h2:mem:$dbName;DB_CLOSE_DELAY=-1;MODE=PostgreSQL", driver = "org.h2.Driver")
        this.db = db
        transaction(db) {
            SchemaUtils.create(accountTable)
            // Ids are assigned by the identity column in seed order (1, 2), so a later POST does not collide.
            // Mixed-case columns are quoted (naming.columns: literal), as in the write-through harness.
            for (r in rows) {
                exec("INSERT INTO accounts (\"name\", \"tokenHash\", \"pinHash\", \"role\") VALUES (${sqlStr(r["name"])}, ${sqlStr(r["tokenHash"])}, ${sqlStr(r["pinHash"])}, ${sqlStr(r["role"])})")
            }
            // Exposed cannot create a view; the projection reads this one.
            exec("CREATE VIEW v_account AS SELECT id, \"name\", \"pinHash\" FROM accounts")
        }

        val controller = controllerClass
            .getDeclaredConstructor(ObjectMapper::class.java, jakarta.validation.Validator::class.java)
            .newInstance(mapper, jakarta.validation.Validation.buildDefaultValidatorFactory().validator)
        val viewCtor = viewControllerClass.declaredConstructors.single()
        val viewController = if (viewCtor.parameterCount == 0) viewCtor.newInstance() else viewCtor.newInstance(mapper)
        host?.close()
        host = TomcatHost.start(mapper, controller, viewController)
    }

    /** The stored rows as the repository sees them (raw SQL, so the generated HTTP boundary is bypassed). */
    fun storedRows(): List<Map<String, Any?>> {
        val database = db ?: error("reset() must be called before storedRows()")
        return transaction(database) {
            val out = mutableListOf<Map<String, Any?>>()
            exec("SELECT id, \"tokenHash\", \"pinHash\", \"role\" FROM accounts ORDER BY id") { rs ->
                while (rs.next()) {
                    out += mapOf("id" to rs.getLong(1), "tokenHash" to rs.getString(2), "pinHash" to rs.getString(3), "role" to rs.getString(4))
                }
            }
            out
        }
    }

    fun exchange(method: String, path: String, jsonBody: Any?): Response {
        val server = host ?: error("reset() must be called before exchange(...)")
        val res = server.exchange(method, path, jsonBody?.let { mapper.writeValueAsString(it) })
        return Response(res.status, res.body)
    }

    fun parseBody(body: String?): Any? = TomcatHost.parseBody(mapper, body)

    override fun close() {
        host?.close() // H2 in-mem is reclaimed at JVM exit (DB_CLOSE_DELAY=-1).
    }

    data class Response(val status: Int, val body: String)

    private companion object {
        const val ENTITY_PKG = "acme.secrets"
        const val CONTROLLER_FQCN = "$ENTITY_PKG.AccountController"
        const val ACCOUNT_TABLE_FQCN = "$ENTITY_PKG.AccountTable"
        /** JVM-wide: a named in-memory H2 outlives its harness (DB_CLOSE_DELAY=-1), so names never repeat. */
        val dbSeq = AtomicInteger(0)
        const val VIEW_CONTROLLER_FQCN = "$ENTITY_PKG.AccountViewController"

        /** A view-backed projection of `Account` that inherits the credential. */
        val ACCOUNT_VIEW = """
            { "metadata.root": { "package": "acme::secrets", "children": [
              { "object.projection": { "name": "AccountView", "children": [
                { "source.rdb":       { "@kind": "view", "@view": "v_account" } },
                { "field.long":       { "name": "id", "extends": "Account.id" } },
                { "field.string":     { "name": "name", "extends": "Account.name" } },
                { "field.string":     { "name": "pinHash", "extends": "Account.pinHash" } },
                { "identity.primary": { "name": "id", "extends": "Account.id" } }
              ] } }
            ] } }
        """.trimIndent()

        fun sqlStr(v: Any?): String = "'" + (v as String).replace("'", "''") + "'"
    }
}
