/**
 * True when this page is open on a phone (or any other device) over the home
 * network, rather than in the app window on the PC. A phone watches and
 * follows; it does not change the PC's stations or settings.
 */
export const isRemote =
  typeof location !== "undefined" && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);

/**
 * True on a TV box: the VayaView Fire TV app (its WebView adds "VayaViewTV" to the user agent),
 * any Fire TV browser ("AFT…" models), or a page opened with ?tv. It is driven by a remote, not a mouse.
 */
export const isTv =
  isRemote &&
  typeof navigator !== "undefined" &&
  (/VayaViewTV|AFT[A-Z0-9]|\bTV\b|BRAVIA|SMART-TV/i.test(navigator.userAgent) || new URLSearchParams(location.search).has("tv"));

/**
 * Apple's HLS pieces, only on Apple devices that play them by themselves (Android Chrome also says
 * "maybe" but cannot play the HEVC pieces).
 * Everything else (a Fire Stick, Android, a laptop) gets the same single stream the PC uses.
 */
export const nativeHls =
  isRemote &&
  typeof document !== "undefined" &&
  /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) &&
  document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";
