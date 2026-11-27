package acme.demo

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import jakarta.validation.constraints.NotNull
import jakarta.validation.constraints.Size
import java.time.Instant
import java.time.LocalDate

/** GENERATED — do not hand-edit. Regenerated from metadata. */
@JsonIgnoreProperties(ignoreUnknown = true)
data class Author(
    val id: Long? = null,
    @field:NotNull
    @field:Size(min = 1, max = 100)
    val name: String,
    val bio: String? = null,
    val age: Int? = null,
    val active: Boolean? = null,
    val ratio: Double? = null,
    val birthday: LocalDate? = null,
    val createdAt: Instant? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var id: Long? = null
        private var name: String? = null
        private var bio: String? = null
        private var age: Int? = null
        private var active: Boolean? = null
        private var ratio: Double? = null
        private var birthday: LocalDate? = null
        private var createdAt: Instant? = null

        fun id(v: Long?): Builder {
            this.id = v
            return this
        }

        fun name(v: String?): Builder {
            this.name = v
            return this
        }

        fun bio(v: String?): Builder {
            this.bio = v
            return this
        }

        fun age(v: Int?): Builder {
            this.age = v
            return this
        }

        fun active(v: Boolean?): Builder {
            this.active = v
            return this
        }

        fun ratio(v: Double?): Builder {
            this.ratio = v
            return this
        }

        fun birthday(v: LocalDate?): Builder {
            this.birthday = v
            return this
        }

        fun createdAt(v: Instant?): Builder {
            this.createdAt = v
            return this
        }

        fun build(): Author = Author(
            id = id,
            name = requireNotNull(name) { "name is required" },
            bio = bio,
            age = age,
            active = active,
            ratio = ratio,
            birthday = birthday,
            createdAt = createdAt,
        )
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}
