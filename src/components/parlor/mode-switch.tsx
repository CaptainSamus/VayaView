import { cn } from "@/lib/cn";
import { useCompleteSync } from "@/lib/shared";

export type AppMode = "tv" | "streaming" | "music" | "store" | "spotify";

const MODES: { id: AppMode; label: string }[] = [
  { id: "tv", label: "TV Guide" },
  { id: "streaming", label: "Streaming" },
  { id: "music", label: "Music" },
  { id: "spotify", label: "Spotify" },
  { id: "store", label: "3D Store" },
];

/** A little shaded cube: the 3D store's tab. */
function CubeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="mr-1 -mt-px inline-block size-3.5 align-middle">
      <path d="M8 1.5 14 4.8 8 8.1 2 4.8Z" fill="currentColor" opacity="0.95" />
      <path d="M2 4.8 8 8.1V14.6L2 11.3Z" fill="currentColor" opacity="0.55" />
      <path d="M14 4.8 8 8.1V14.6L14 11.3Z" fill="currentColor" opacity="0.3" />
    </svg>
  );
}

/** TV Guide | Streaming | Music | Spotify | 3D Store. */
export function ModeSwitch({ mode, onMode, className }: { mode: AppMode; onMode: (mode: AppMode) => void; className?: string }) {
  return (
    <>
      <Tabs mode={mode} onMode={onMode} className={className} />
      <CompleteSyncButton />
    </>
  );
}

/** Complete Sync on/off: every screen (PC and TVs) shows the same thing (src/lib/shared.ts). */
export function CompleteSyncButton({ className }: { className?: string }) {
  const [on, setOn] = useCompleteSync();
  return (
    <button
      type="button"
      aria-pressed={on}
      title="Every screen (PC and TVs) shows the same thing: mode, channel, pause, title page, film"
      className={cn(
        "shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition-colors",
        on ? "bg-accent text-room" : "bg-cream/10 text-cream/70 hover:text-cream",
        className,
      )}
      onClick={() => setOn(!on)}
    >
      {on ? "● " : "○ "}Complete Sync
    </button>
  );
}

function Tabs({ mode, onMode, className }: { mode: AppMode; onMode: (mode: AppMode) => void; className?: string }) {
  return (
    <div role="tablist" aria-label="Mode" className={cn("inline-flex shrink-0 rounded-full bg-cream/10 p-0.5", className)}>
      {MODES.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === mode}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
            item.id === mode ? "bg-accent text-room" : "text-cream/70 hover:text-cream",
          )}
          onClick={() => onMode(item.id)}
        >
          {item.id === "store" ? <CubeIcon /> : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}
