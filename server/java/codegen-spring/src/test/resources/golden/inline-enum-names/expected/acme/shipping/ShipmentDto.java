package acme.shipping;

import jakarta.validation.constraints.*;

/** GENERATED — wire DTO for Shipment. Do not hand-edit; regenerated from metadata. */
public record ShipmentDto(
    @NotNull Long id,
    @NotNull ShipmentStatus status,
    ShipmentMode mode
) {
    public enum ShipmentStatus { PENDING, SHIPPED, DELIVERED }
    public enum ShipmentMode { AIR, SEA }

    /** A fluent builder, so a caller can set a subset of the components. */
    public static Builder builder() { return new Builder(); }

    /** Builds a {@link ShipmentDto}; an unset component stays null. */
    public static final class Builder {
        private Long id;
        private ShipmentStatus status;
        private ShipmentMode mode;

        private Builder() {}

        public Builder id(Long v) { this.id = v; return this; }
        public Builder status(ShipmentStatus v) { this.status = v; return this; }
        public Builder mode(ShipmentMode v) { this.mode = v; return this; }

        public ShipmentDto build() { return new ShipmentDto(id, status, mode); }
    }
}
