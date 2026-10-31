from app.models import Order, OrderStatus, ShippingAddress


def ship_to(order: Order) -> ShippingAddress | None:
    return order.shipping_address if order.status is OrderStatus.PAID else None
