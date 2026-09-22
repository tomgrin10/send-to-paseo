import { requireServerId } from "./daemon";
import { assertServerTarget } from "../shared/host-target";

export async function requireServerTarget(requestedServerId: string): Promise<void> {
  assertServerTarget(requestedServerId, await requireServerId());
}
