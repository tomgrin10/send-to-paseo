/** Fail closed when a delayed surface action reaches a different host. */
export function assertServerTarget(requestedServerId: string, actualServerId: string): void {
  if (requestedServerId !== actualServerId) {
    throw new Error(
      `Paseo host changed before the action ran (requested ${requestedServerId}, reached ${actualServerId}). Try again on the intended host.`,
    );
  }
}
