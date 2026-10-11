package acme.shipping;

import jakarta.validation.constraints.*;

/** GENERATED — wire DTO for ShipmentSummary. Do not hand-edit; regenerated from metadata. */
public record ShipmentSummaryDto(
    @NotNull Long id,
    @NotNull Status status
) {
    public enum Status { PENDING, SHIPPED, DELIVERED }
}
