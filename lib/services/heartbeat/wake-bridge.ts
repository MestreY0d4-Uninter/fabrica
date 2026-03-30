/**
 * wake-bridge.ts — Plugin-internal callback bridge for heartbeat waking.
 *
 * The heartbeat service registers a callback on start. The reactive dispatch
 * hook (and subagent lifecycle hook) call wakeHeartbeat() to trigger an
 * immediate "full" tick without waiting for the next interval.
 *
 * Why not use the SDK's setHeartbeatWakeHandler()? It's internal to the
 * gateway — not exported via the public plugin-sdk barrel.
 */

type WakeCallback = (reason: string) => Promise<void>;
let _wakeCallback: WakeCallback | null = null;

/**
 * Register the heartbeat wake callback. Called by heartbeat service on start.
 * Pass null to unregister (called on stop).
 */
export function setPluginWakeHandler(cb: WakeCallback | null): void {
  _wakeCallback = cb;
}

/**
 * Wake the heartbeat for an immediate tick. Called by reactive-dispatch-hook
 * and subagent-lifecycle-hook. No-op if heartbeat service is not running.
 */
export async function wakeHeartbeat(reason: string): Promise<void> {
  await _wakeCallback?.(reason);
}

/** For tests: check if a handler is registered. */
export function hasWakeHandler(): boolean {
  return _wakeCallback !== null;
}
