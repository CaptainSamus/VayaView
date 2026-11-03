import { cn } from "@/lib/cn";

export type AppMode = "tv" | "streaming";

const MODES: { id: AppMode; label: string }[] = [
  { id: "tv", label: "TV Guide" },
  { id: "streaming", label: "Streaming" },
];

/** TV Guide | Streaming. Music joins later. */
export function ModeSwitch({ mode, onMode, className }: { mode: AppMode; onMode: (mode: AppMode) => void; className?: string }) {
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
          {item.label}
        </button>
      ))}
    </div>
  );
}
