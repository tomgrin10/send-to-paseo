import type { SendResponse } from "./contract";

/** Missing receipts retain the legacy success message; dry runs never claim a delivery. */
export const queuedDelivery = (reply: Pick<SendResponse, "deliveryStatus" | "dryRun">): boolean =>
  reply.dryRun !== true && reply.deliveryStatus === "queued";
export const queuedDeliveryText = "Queued for after the current turn";
