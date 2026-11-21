# Requirements

7 declared requirements, in declaration order.

## Storefront

`functional` · **L1** · status: `live`

The storefront solution

**Counterexample:** Nothing can be sold

### Storefront.OrderService

`functional` · **L3** · status: `live`

Every placed order is recorded before payment is attempted

**Counterexample:** A payment attempted against an order that was never stored

Recording first is what lets a failed payment be retried.

# Why first

A payment with no order is a refund nobody can trace.

#### Storefront.OrderService.OrderRecord — What an order must hold

`functional` · **L4** · status: `live`

An order records what was bought, for how much, and when: placed | paid

**Counterexample:** An order row that cannot say who placed it

**Implemented by:** `acme::shop::Order`, `acme::shop::Order.placedAt`

##### Storefront.OrderService.OrderRecord.TranscribableReference

`functional` · **L5** · status: `live`

An order carries a reference a customer can read
down a phone line

**Counterexample:** A reference that is a raw uuid

**Implemented by:** `acme::shop::Order.reference`

##### Storefront.OrderService.OrderRecord.OrderExpiry

`functional` · **L5** · status: `planned` · tracked: acme/shop#412

An unpaid order carries the instant it stops being reservable

**Counterexample:** Stock held indefinitely against an order nobody paid for

## MoneyIsExactMinorUnits

`architectural` · status: `live`

Monetary amounts are stored as exact integer minor units, never as floating point

**Counterexample:** A cent that disappears when a total is split three ways

**Implemented by:** `acme::shop::Invoice`

## GuestCheckout

`functional` · **L4** · status: `retired`

A visitor can check out without an account

**Counterexample:** An order with no way to reach the person who placed it
