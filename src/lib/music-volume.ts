/**
 * Music mode's volume, kept apart from the TV's (the user asked for these rules):
 * - The first time Music opens in a run of the app (start-up included) it is at 15%.
 * - Leaving Music with the volume above 50% brings it back at 30% next time.
 * - Otherwise it comes back where it was.
 */
let live: number | null = null;

export function musicStartVolume(): number {
  live ??= 0.15;
  return live;
}

export function musicVolumeChanged(volume: number) {
  live = volume;
}

export function leaveMusic() {
  if (live != null && live > 0.5) live = 0.3;
}
