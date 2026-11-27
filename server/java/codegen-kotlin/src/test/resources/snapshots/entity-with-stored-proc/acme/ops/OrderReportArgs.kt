package acme.ops

/** GENERATED — do not hand-edit. Regenerated from metadata. */
data class OrderReportArgs(
    val orderId: Long? = null,
) {
    /** Fluent builder — lets a JAVA caller set a subset of properties. */
    class Builder {
        private var orderId: Long? = null

        fun orderId(v: Long?): Builder {
            this.orderId = v
            return this
        }

        fun build(): OrderReportArgs = OrderReportArgs(orderId = orderId)
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}
