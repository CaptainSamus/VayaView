/**
 * The PC's clock, as seen from this screen. Live TV and Complete Sync work out "where the picture should be"
 * from a clock, and every TV's own clock is a little off from the PC's (hundreds of ms is common), which put
 * the screens out of step. So every screen asks the PC for its time (like NTP: the answer from the quickest
 * round trip wins) and uses `serverNow()` instead of Date.now() for anything shared.
 */
import { isRemote } from "./remote";

let offset = 0;
let best = Infinity;
let started = false;

async function sample() {
  try {
    const t0 = performance.now();
    const wall0 = Date.now();
    const body = (await fetch("/api/time", { cache: "no-store" }).then((response) => response.json())) as { now?: number };
    const rtt = performance.now() - t0;
    if (typeof body.now !== "number") return;
    // A quick answer is an accurate one; older bests count a little less as time passes (clocks drift).
    if (rtt <= best + 15) {
      best = Math.min(best, rtt);
      offset = body.now - (wall0 + rtt / 2);
    }
  } catch {
    // the PC is away; keep the last answer
  }
}

export function startServerClock() {
  if (started || !isRemote) return;
  started = true;
  void (async () => {
    for (let i = 0; i < 8; i++) {
      await sample();
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    }
  })();
  window.setInterval(() => {
    best += 5;
    void sample();
  }, 15_000);
}

/** Now, by the PC's clock (ms). On the PC itself this is just Date.now(). */
export function serverNow(): number {
  if (!started) startServerClock();
  return Date.now() + offset;
}
