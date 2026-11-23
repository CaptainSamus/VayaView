/**
 * TMDB pictures. The paths come from the metadata match (`/abc.jpg`); the
 * images themselves load straight from TMDB's image server, which needs no token.
 */
const BASE = "https://image.tmdb.org/t/p";

export function posterUrl(path: string | null | undefined, width: 185 | 342 | 500 = 342): string | null {
  if (path?.startsWith("/api/")) return path; // a still from our own video (home videos)
  return path ? `${BASE}/w${width}${path}` : null;
}

export function backdropUrl(path: string | null | undefined, width: 780 | 1280 = 1280): string | null {
  if (path?.startsWith("/api/")) return path;
  return path ? `${BASE}/w${width}${path}` : null;
}
