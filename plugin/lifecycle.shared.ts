/**
 * Lets the entry point release daemon-side resources without naming them.
 *
 * Paseo deletes `*.server` imports from the client bundle but keeps the
 * surrounding statements, so a server identifier inside `contribute()`'s
 * cleanup becomes a ReferenceError that aborts every registration. A shared
 * module is safe in both bundles: `bridge.server` fills this in on the daemon,
 * and it stays null in the client, where there is no HTTP server to stop.
 *
 * Skipping this handoff is not cosmetic: a listening HTTP server keeps the
 * plugin subprocess event loop alive, which wedges Paseo's "Stopping plugin"
 * step and makes `paseo plugin reload` hang forever.
 */
export type Teardown = () => void | Promise<void>;

export const lifecycle: { teardown: Teardown | null } = { teardown: null };
