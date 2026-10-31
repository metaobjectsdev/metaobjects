from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class OrderStatus(str, Enum):
    PENDING = "pending"
    PAID = "paid"
    SHIPPED = "shipped"


class ShippingAddress(BaseModel):
    line1: str
    city: str
    postcode: Optional[str] = None


class Customer(BaseModel):
    id: UUID
    email: str = Field(max_length=254)
    display_name: str = Field(max_length=120)
    loyalty_points: int = 0
    marketing_opt_in: bool = False
    notes: Optional[str] = None
    created_at: datetime


class CustomerCreate(BaseModel):
    email: str = Field(min_length=1, max_length=254)
    display_name: str = Field(min_length=1, max_length=120)
    loyalty_points: int = 0
    marketing_opt_in: bool = False
    notes: Optional[str] = None


class Order(BaseModel):
    id: int
    customer_id: UUID
    status: OrderStatus = OrderStatus.PENDING
    total: Decimal
    shipping_address: Optional[ShippingAddress] = None
    tags: list[str] = []
    placed_on: date
