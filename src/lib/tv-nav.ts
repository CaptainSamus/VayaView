/**
 * Moving round the app with a TV remote (Fire TV: arrows, select, back, menu).
 *
 * Two states:
 * - Watching (nothing has focus): the app's own keys work as on the PC. Up/down change the
 *   channel, left/right skip back and on. Select or Menu wakes the buttons.
 * - Choosing (a button has focus): the arrows move a highlight to the nearest button that way,
 *   Select presses it, Back lets go and returns to watching.
 *
 * The Fire TV app sends Back as Escape and Menu as ContextMenu (see android/MainActivity.java).
 */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [role="button"]';

type Dir = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

function visible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  return element.closest("[inert], [aria-hidden='true']") == null;
}

/**
 * Scrolled out of sight inside a list? Such a button only counts when the highlight is already in
 * that list (moving down a guide scrolls it); from anywhere else it would be a jump to something unseen.
 */
function reachable(element: HTMLElement, current: Element | null): boolean {
  const r = element.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  let sameList = false;
  for (let box = element.parentElement; box && box !== document.body; box = box.parentElement) {
    const style = getComputedStyle(box);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const b = box.getBoundingClientRect();
    const inside = x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    const shared = current != null && box.contains(current);
    if (!inside && !shared) return false;
    if (!inside) sameList = true;
  }
  return sameList || (x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight);
}

function candidates(current: Element | null = null): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => visible(element) && reachable(element, current));
}

/** The nearest button in that direction, favouring ones straight ahead over ones off to the side. */
function nearest(from: DOMRect, dir: Dir, list: HTMLElement[], current: Element | null): HTMLElement | null {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const element of list) {
    if (element === current || element.contains(current)) continue;
    const r = element.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // Gaps between the edges, so a wide button next door counts as close.
    const ahead =
      dir === "ArrowRight" ? r.left - from.right : dir === "ArrowLeft" ? from.left - r.right : dir === "ArrowDown" ? r.top - from.bottom : from.top - r.bottom;
    const centreAhead = dir === "ArrowRight" ? x - cx : dir === "ArrowLeft" ? cx - x : dir === "ArrowDown" ? y - cy : cy - y;
    if (centreAhead <= 1 || ahead < -Math.min(r.width, r.height, 12)) continue;
    const side =
      dir === "ArrowRight" || dir === "ArrowLeft"
        ? Math.max(0, r.top - from.bottom, from.top - r.bottom)
        : Math.max(0, r.left - from.right, from.left - r.right);
    const score = Math.max(0, ahead) + side * 3 + Math.abs(dir === "ArrowRight" || dir === "ArrowLeft" ? y - cy : x - cx) * 0.2;
    if (score < bestScore) {
      bestScore = score;
      best = element;
    }
  }
  return best;
}

function focusOn(element: HTMLElement) {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Where the highlight starts when the buttons wake: a marked spot, the chosen mode tab, or the top-left button. */
function start() {
  const list = candidates();
  const marked = list.find((element) => element.dataset.tvStart != null) ?? list.find((element) => element.matches('[role="tab"][aria-selected="true"]'));
  const first = marked ?? list.filter((element) => !(element instanceof HTMLInputElement)).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
  if (first) focusOn(first);
}

function choosing(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body && active.matches(FOCUSABLE) ? active : null;
}

/**
 * A Fire Stick reports a small screen (960 × 540), too tight for the PC layout. Lay the page out
 * as 1280 wide and let the box scale it, through the viewport tag (the Fire TV app turns on wide
 * viewports so its WebView honours it). CSS zoom was tried and broke the guide's scrolling.
 */
const TV_WIDTH = 1280;
function fitScreen() {
  if (innerWidth >= TV_WIDTH - 80) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "viewport";
    document.head.appendChild(meta);
  }
  meta.content = `width=${TV_WIDTH}`;
}

export function installTvNav() {
  document.documentElement.classList.add("tv");
  fitScreen();
  const style = document.createElement("style");
  style.textContent = `
    html.tv :focus { outline: none; }
    html.tv-osd-open [data-subs] { bottom: 27% !important; }
    html.tv [data-tv-osd] :focus-visible, html.tv [data-tv-osd] .tv-focus { outline: none !important; box-shadow: none !important; border-radius: 9999px !important; }
    html.tv :focus-visible, html.tv .tv-focus { outline: 4px solid var(--color-accent, #f5b544) !important; outline-offset: 3px; border-radius: 6px; box-shadow: 0 0 0 8px rgb(0 0 0 / 0.45); }
    html.tv, html.tv * { cursor: none !important; }
    /* Fire TV draws video black when a parent clips it to rounded corners (sound still plays). */
    html.tv *:has(video) { border-radius: 0 !important; }
  `;
  document.head.appendChild(style);

  window.addEventListener(
    "keydown",
    (event) => {
      const active = choosing();
      const key = event.key;
      const swallow = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (!active) {
        // Watching. Select or Menu wakes the buttons; everything else goes to the app as usual.
        if (key === "ContextMenu" || (key === "Enter" && !event.repeat)) {
          swallow();
          // The TV layout (tv-controls.tsx) opens its own button bar instead.
          const wake = new Event("tv-wake", { cancelable: true });
          window.dispatchEvent(wake);
          if (!wake.defaultPrevented) start();
          return;
        }
        if (key === "Escape") {
          const back = new Event("tv-back", { cancelable: true });
          window.dispatchEvent(back);
          if (back.defaultPrevented) swallow();
        }
        return;
      }
      const typing = active instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "color", "submit"].includes(active.type);
      if (key === "Escape" || key === "ContextMenu") {
        // Back: a text box gives up the keyboard first; otherwise let go of the buttons.
        swallow();
        active.blur();
        window.dispatchEvent(new Event("tv-back", { cancelable: true }));
        return;
      }
      if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
        // Left and right still move along a slider or inside typed text.
        // In typed text they move the cursor until it reaches an end, then move on.
        const atEnd =
          typing && (active as HTMLInputElement).selectionStart === (key === "ArrowLeft" ? 0 : (active as HTMLInputElement).value.length);
        if ((key === "ArrowLeft" || key === "ArrowRight") && ((typing && !atEnd) || (active instanceof HTMLInputElement && active.type === "range"))) {
          event.stopImmediatePropagation();
          return;
        }
        // A closed list (subtitles, audio) is passed over like a button; Select opens it.
        swallow();
        // Inside a row marked data-tv-row, Left/Right stay in that row (the TV bar: skip buttons, pills).
        const row = key === "ArrowLeft" || key === "ArrowRight" ? active.closest("[data-tv-row]") : null;
        const pool = row ? candidates(active).filter((element) => row.contains(element)) : candidates(active);
        const next = nearest(active.getBoundingClientRect(), key, pool, active);
        if (next) focusOn(next);
        return;
      }
      if (key === "Enter") {
        event.stopImmediatePropagation();
        // Press it ourselves: a remote's Select does not always click a button (no keypress follows the
        // keydown). Lists and text boxes keep their own behaviour (Select opens them / the keyboard).
        if (active instanceof HTMLSelectElement || (active instanceof HTMLInputElement && typing)) return;
        if (event.repeat) return event.preventDefault();
        event.preventDefault();
        active.click();
        return;
      }
      // Other keys (digits, media keys) go to the app.
    },
    true,
  );

  // A button that disappears (a menu closing) leaves focus nowhere; pick up again nearby rather than dropping to watching.
  document.addEventListener(
    "focusout",
    (event) => {
      const gone = event.target as HTMLElement;
      // Closing the TV button bar or guide goes back to watching, not to some other button.
      // So does switching mode (the tabs and the TV bar's mode buttons go away with the old screen).
      if (gone.closest?.("[data-tv-overlay], [role='tab']")) return;
      const rect = gone.getBoundingClientRect();
      window.setTimeout(() => {
        if (choosing() || gone.isConnected) return;
        const list = candidates();
        let best: HTMLElement | null = null;
        let bestDistance = Infinity;
        for (const element of list) {
          const r = element.getBoundingClientRect();
          const d = Math.hypot(r.left - rect.left, r.top - rect.top);
          if (d < bestDistance) {
            bestDistance = d;
            best = element;
          }
        }
        if (best) focusOn(best);
      }, 0);
    },
    true,
  );
}
