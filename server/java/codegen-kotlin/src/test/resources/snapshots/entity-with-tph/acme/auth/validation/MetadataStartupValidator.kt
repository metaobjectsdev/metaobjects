package acme.auth.validation

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.metaObjectOrNull
import org.jetbrains.exposed.sql.Table
import acme.auth.AuthLineTable
import acme.auth.AuthTable

/**
 * GENERATED — runtime drift gate. Call [validate] from a Spring `@PostConstruct` or
 * `ApplicationReadyEvent` listener to fail-fast when generated Tables drift from metadata.
 */
object MetadataStartupValidator {

    private val tablesToValidate: List<Pair<String, Table>> = listOf(
        "acme::auth::Auth" to AuthTable,
        "acme::auth::AuthLine" to AuthLineTable
    )

    fun validate(loader: MetaDataLoader) {
        val errors = mutableListOf<String>()
        for ((fqn, table) in tablesToValidate) {
            val obj = loader.metaObjectOrNull(fqn)
            if (obj == null) {
                errors.add("metadata missing $fqn (generated table: ${table.tableName})")
                continue
            }
            ExposedTableValidator.check(obj, table, errors)
        }
        check(errors.isEmpty()) {
            "MetadataStartupValidator: ${errors.size} drift(s):\n  - " +
                errors.joinToString("\n  - ")
        }
    }
}
