/**
 * Desktop notification plugin, node half.
 *
 * Task notifications belong to the Electron shell and its application
 * renderer: the shell owns the notification center and the user's setting,
 * and the browser half reports the events it already subscribes to. A Host
 * process has no notification surface and no shell bridge, so this half is
 * deliberately empty.
 */

/** Host plugin body — notifications are a renderer-to-shell capability. */
export function apply(): void {}
