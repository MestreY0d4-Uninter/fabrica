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
let _lastWakeAt = 0;
let _wakeInFlight: Promise<void> | null = null;
const WAKE_COALESCE_MS = 2_000;

/**
 * Register the heartbeat wake callback. Called by heartbeat service on start.
 * Pass null to unregister (called on stop).
 */
export function setPluginWakeHandler(cb: WakeCallback | null): void {
  _wakeCallback = cb;
  if (!cb) {
    _lastWakeAt = 0;
    _wakeInFlight = null;
  }
}

/**
 * Wake the heartbeat for an immediate tick. Called by reactive-dispatch-hook
 * and subagent-lifecycle-hook. No-op if heartbeat service is not running.
 */
export async function wakeHeartbeat(reason: string): Promise<void> {
  if (!_wakeCallback) return;

  const now = Date.now();
  if (_wakeInFlight) {
    await _wakeInFlight;
    return;
  }

  if (_lastWakeAt > 0 && now - _lastWakeAt < WAKE_COALESCE_MS) {
    return;
  }

  _lastWakeAt = now;
  const wakePromise = Promise.resolve(_wakeCallback(reason)).finally(() => {
    _wakeInFlight = null;
  });
  _wakeInFlight = wakePromise;
  await wakePromise;
}

/** For tests: check if a handler is registered. */
export function hasWakeHandler(): boolean {
  return _wakeCallback !== null;
}
