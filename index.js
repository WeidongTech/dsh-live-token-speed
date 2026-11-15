/**
 * dsh-live-token-speed — host half.
 *
 * The feature is entirely browser-side: it shadows the shipped `activity`
 * composer pill (client-ui-chat) with one that reports a live sliding-window
 * decode speed instead of the whole-session average. The host half exists only
 * so the package has a mountable row in the profile's cordis tree.
 */

/** Host plugin body — contributes nothing host-side. */
export function apply() {}

export default { apply }
