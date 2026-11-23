import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

type PhoneStatus = { enabled: boolean; pin: string; paired: number; addresses: string[]; available: boolean };

const button = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20 disabled:opacity-40";

/** The switch for watching on a phone over home Wi-Fi, the PIN, and where to point the phone. */
export function PhoneAccess() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinDraft, setPinDraft] = useState("");
  useEffect(() => {
    if (status) setPinDraft(status.pin);
  }, [status]);

  async function send(body?: object) {
    setBusy(true);
    try {
      const response = await fetch("/api/phone", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
      setStatus((await response.json()) as PhoneStatus);
    } catch {
      setStatus(null);
    }
    setBusy(false);
  }

  useEffect(() => {
    void send();
  }, []);

  if (!status) return <p className="px-1 pb-1 text-xs text-cream/50">Checking phone access…</p>;
  if (!status.available) return <p className="px-1 pb-1 text-xs text-cream/50">Phone access works in the installed VayaView app.</p>;

  return (
    <div className="space-y-2 px-1 pb-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={status.enabled}
          disabled={busy}
          onClick={() => send({ enabled: !status.enabled })}
          className={cn("rounded-full px-3 py-1.5 font-medium", status.enabled ? "bg-accent text-room" : "bg-cream/10 text-cream")}
        >
          Phone access: {status.enabled ? "On" : "Off"}
        </button>
        <span className="text-cream/50">{status.enabled ? "Listening on your home Wi-Fi." : "Off: nothing outside this PC can reach VayaView."}</span>
      </div>
      {status.enabled ? (
        <div className="rounded-lg bg-screen p-3">
          <p className="text-cream/70">On your iPhone, open Safari and go to:</p>
          {status.addresses.length === 0 ? (
            <p className="mt-1 text-accent">No home network found on this PC.</p>
          ) : (
            status.addresses.map((address) => (
              <p key={address} className="mt-1 text-base font-semibold tracking-tight text-cream select-all">
                {address}
              </p>
            ))
          )}
          <form
            className="mt-2 flex flex-wrap items-center gap-2 text-cream/70"
            onSubmit={(event) => {
              event.preventDefault();
              if (/^\d{4,8}$/.test(pinDraft)) void send({ pin: pinDraft });
            }}
          >
            PIN
            <input
              value={pinDraft}
              onChange={(event) => setPinDraft(event.target.value.replace(/\D/g, "").slice(0, 8))}
              inputMode="numeric"
              aria-label="PIN"
              className="w-28 rounded-md bg-cream/10 px-2 py-1 text-base font-semibold tracking-[0.2em] text-cream tabular-nums outline-none focus:bg-cream/15"
            />
            {pinDraft !== status.pin ? (
              <button type="submit" className={cn(button, "bg-accent font-semibold text-room hover:bg-accent")} disabled={busy || !/^\d{4,8}$/.test(pinDraft)}>
                Apply
              </button>
            ) : null}
            <span className="text-cream/45">Type a new 4–8 digit PIN to change it. Paired phones and TVs stay paired.</span>
          </form>
          {status.addresses[0] ? (
            <p className="mt-2 text-cream/70">
              Fire TV: in the Downloader app, enter{" "}
              <span className="font-semibold text-cream select-all">{`${status.addresses[0].replace(/\/$/, "")}/tv`}</span> to install VayaView. It finds this PC by itself.
            </p>
          ) : null}
          <p className="mt-2 text-cream/45">
            {status.paired} phone{status.paired === 1 ? "" : "s"} paired. The first time, Windows may ask whether to let VayaView use the network: allow it on private networks.
          </p>
        </div>
      ) : null}
    </div>
  );
}
