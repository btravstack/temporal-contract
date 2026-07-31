import { NotificationError } from "../errors.js";
import type { NotificationPort } from "../ports/notification.port.js";

/**
 * Send Notification Use Case
 *
 * Business logic for sending notifications
 */
export class SendNotificationUseCase {
  constructor(private readonly notificationPort: NotificationPort) {}

  async execute(customerId: string, subject: string, message: string): Promise<void> {
    // Business validation
    if (!customerId || customerId.trim() === "") {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new NotificationError("Customer ID is required");
    }

    if (!subject || subject.trim() === "") {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new NotificationError("Subject is required");
    }

    if (!message || message.trim() === "") {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new NotificationError("Message is required");
    }

    // Delegate to notification port
    return this.notificationPort.sendNotification(customerId, subject, message);
  }
}
