/**
 * Technical failure shapes for the order-processing domain.
 *
 * These exist so each activity boundary can *triage* rather than blanket-wrap.
 * `qualifyFailure(type, { expected })` names the failures an activity
 * anticipates: a matching cause becomes the modeled `ApplicationFailure`, and
 * anything else — a `TypeError` from a bug, a null deref — rides unthrown's
 * **defect** channel and re-throws at the activity edge with its original
 * stack, instead of being mislabelled as a business failure.
 *
 * Naming one class per port is what makes that triage meaningful. A blanket
 * `expected: Error` would match essentially every throw, which is the
 * pre-v8 catch-all behavior spelled differently — if you genuinely want it,
 * write `expected: "any"` so the intent is explicit and greppable.
 *
 * Distinct from the contract's **declared** `errors` (`PaymentDeclined`):
 * those model expected *business* outcomes, are returned as
 * `Err(errors.PaymentDeclined(...))` rather than thrown, and cross the wire
 * as typed `ContractError`s. The classes here are plain technical faults.
 */

/** Base class for every technical fault raised by this example's domain. */
export class OrderProcessingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    // Keep `Error.name` the concrete subclass name for readable logs.
    this.name = new.target.name;
  }
}

/** The notification provider could not accept the message. */
export class NotificationError extends OrderProcessingError {}

/** The payment gateway could not process the charge or refund. */
export class PaymentError extends OrderProcessingError {}

/** The inventory service could not reserve or release stock. */
export class InventoryError extends OrderProcessingError {}

/** The shipping provider could not create the shipment. */
export class ShippingError extends OrderProcessingError {}

/** The order store could not complete the requested operation. */
export class OrderRepositoryError extends OrderProcessingError {}
