package com.metaobjects.omdb.ktx

import com.metaobjects.loader.file.FileLoaderOptions
import com.metaobjects.loader.file.FileMetaDataLoader
import com.metaobjects.loader.file.LocalFileMetaDataSources
import com.metaobjects.manager.ObjectRef
import com.metaobjects.manager.db.ObjectManagerDB
import com.metaobjects.manager.db.driver.DerbyDriver
import com.metaobjects.manager.db.validator.MetaClassDBValidatorService
import com.metaobjects.registry.MetaDataLoaderRegistry
import com.metaobjects.registry.ServiceRegistryFactory
import java.io.PrintWriter
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLFeatureNotSupportedException
import java.util.logging.Logger
import javax.sql.DataSource

/**
 * Shared test fixture: spins up an in-memory Derby database, loads metadata from
 * meta.widget.json, and initialises a fully-wired [ObjectManagerDB] (tables created via
 * [MetaClassDBValidatorService]).
 *
 * Pattern mirrors AbstractOMDBTest in the omdb module (the proven Java test base class).
 * Call [build] once per test class (e.g. in a companion-object @BeforeAll) and [destroy]
 * in @AfterAll.
 */
class TestDb private constructor(
    val omdb: ObjectManagerDB,
    val registry: MetaDataLoaderRegistry,
    val dataSource: DataSource,
    private val dbName: String,
    private val loader: FileMetaDataLoader,
) {

    /** Returns a raw JDBC connection to the in-memory database. */
    fun connection(): Connection =
        DriverManager.getConnection("jdbc:derby:memory:$dbName;create=true")

    /**
     * Drops the in-memory Derby database and destroys the metadata loader.
     * Call from @AfterAll.
     */
    fun destroy() {
        try {
            DriverManager.getConnection("jdbc:derby:memory:$dbName;drop=true")
        } catch (_: java.sql.SQLNonTransientConnectionException) {
            // Derby throws this on a successful drop — it is expected.
        }
        loader.destroy()
    }

    companion object {
        /**
         * Builds a fully-wired [TestDb].
         *
         * @param dbName  unique in-memory database name (use something like
         *                "omdb-ktx-" + System.currentTimeMillis() to avoid collisions)
         * @param metaFile  classpath-relative metadata JSON file to load
         *                  (default: "meta.widget.json")
         */
        @JvmStatic
        fun build(
            dbName: String = "omdb-ktx-${System.currentTimeMillis()}",
            metaFile: String = "meta.widget.json",
        ): TestDb {
            // 1. Loader registry (mirrors AbstractOMDBTest.setupDB)
            val registry = MetaDataLoaderRegistry(ServiceRegistryFactory.getDefault())

            @Suppress("UNCHECKED_CAST", "RAW_TYPE_WARNINGS")
            val loaderOptions: FileLoaderOptions<*> = FileLoaderOptions<FileLoaderOptions<*>>()
            loaderOptions.setShouldRegister(false)
            loaderOptions.setAllowAutoAttrs(true)
            loaderOptions.setStrict(false)
            loaderOptions.setVerbose(false)
            val loader = FileMetaDataLoader(loaderOptions, "test-db-ktx")
            loader.init(LocalFileMetaDataSources(metaFile))
            loader.register()           // old mechanism
            registry.registerLoader(loader) // new mechanism

            // 2. Boot the embedded Derby driver (ensures the EmbeddedDriver is registered
            //    in DriverManager before we hand a DataSource to omdb).
            Class.forName("org.apache.derby.jdbc.EmbeddedDriver")
            DriverManager.getConnection("jdbc:derby:memory:$dbName;create=true").close()

            // 3. Minimal DataSource backed by DriverManager — same pattern as AbstractOMDBTest.
            val ds = object : DataSource {
                override fun getConnection(): Connection =
                    DriverManager.getConnection("jdbc:derby:memory:$dbName;create=true")

                override fun getConnection(username: String?, password: String?): Connection =
                    getConnection()

                override fun getLogWriter(): PrintWriter = PrintWriter(System.out)
                override fun setLogWriter(out: PrintWriter?) = Unit
                override fun setLoginTimeout(seconds: Int) = Unit
                override fun getLoginTimeout(): Int = 100
                override fun getParentLogger(): Logger =
                    throw SQLFeatureNotSupportedException("Not supported")
                override fun <T : Any?> unwrap(iface: Class<T?>?): T? =
                    throw UnsupportedOperationException("Not supported")
                override fun isWrapperFor(iface: Class<*>?): Boolean =
                    throw UnsupportedOperationException("Not supported")
            }

            // 4. Initialise ObjectManagerDB — setDatabaseDriver mirrors AbstractOMDBTest exactly.
            //    We use an anonymous subclass that overrides getObjectRef(String) to use the
            //    LOCAL registry instead of the global MetaDataUtil static lookup, so that
            //    findObjectByRef (and thus OmdbSession.findByRef) works in the test environment
            //    without requiring a globally-bootstrapped loader registry (OSGi/Spring style).
            val omdb = object : ObjectManagerDB() {
                override fun getObjectRef(refStr: String): ObjectRef {
                    val prefix = "objectref://"
                    require(refStr.startsWith(prefix)) { "Invalid object reference [$refStr]" }
                    val rest = refStr.removePrefix(prefix)
                    // Simplified parse: safe because MetaObject FQNs use the '::' package separator, never '/'.
                    val slashIdx = rest.indexOf('/')
                    require(slashIdx >= 0) { "Invalid object reference [$refStr]" }
                    val fqn = rest.substring(0, slashIdx)
                    val idsStr = rest.substring(slashIdx + 1)
                    val mo = registry.findMetaObjectByName(fqn)
                    val ids = idsStr.split('/').filter { it.isNotBlank() }.toTypedArray()
                    return ObjectRef(mo, ids)
                }
            }
            omdb.setDatabaseDriver(DerbyDriver())
            omdb.setDataSource(ds)
            omdb.init()

            // 5. Auto-create tables for all loaded metadata objects.
            val vs = MetaClassDBValidatorService()
            vs.setObjectManager(omdb)
            vs.setAutoCreate(true)
            vs.setMetaDataLoaderRegistry(registry)
            vs.init()

            return TestDb(omdb, registry, ds, dbName, loader)
        }
    }
}
