import { useMemo, useState, type DragEvent } from "react";
import { CATALOG, diskMissingIds, libraryInfo } from "@/lib/library/catalog";
import { posterUrl } from "@/lib/library/art";
import type { Film } from "@/lib/library/types";
import type { ChannelMode } from "@/lib/schedule/types";
import { cn } from "@/lib/cn";

/** One picture on the wall: a film, a whole show, a song, or every song by an artist. */
type Tile = {
  key: string;
  title: string;
  sub: string;
  /** A tall poster, or a wide still from a music video. */
  image: string | null;
  wide: boolean;
  ids: string[];
  durationMs: number;
  tags: string[];
  group: "film" | "show" | "song" | "artist";
  search: string;
};

const DRAG = "application/x-vv-tile";
const LIMIT = 240;

const thumb = (id: string) => `/api/thumb/${encodeURIComponent(id)}`;
const decadeOf = (film: Film) => film.keywords[0] && /^\d+s$/.test(film.keywords[0]) ? film.keywords[0] : "";

function byEpisode(a: Film, b: Film) {
  return (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.title.localeCompare(b.title);
}

/** The library as pictures. Two copies of the same film or episode show once (the sharper one). */
function tvTiles(): Tile[] {
  const best = new Map<string, Film>();
  for (const film of CATALOG) {
    if (diskMissingIds.has(film.id)) continue;
    const key =
      film.genres[0] === "TV"
        ? film.season != null && film.episode != null
          ? `tv|${film.collection}|${film.season}|${film.episode}`
          : `id|${film.id}`
        : `movie|${film.title.toLowerCase().replace(/[^a-z0-9]+/g, "")}|${film.year}`;
    const held = best.get(key);
    if (!held || (film.height ?? 0) > (held.height ?? 0)) best.set(key, film);
  }
  const shows = new Map<string, Film[]>();
  const tiles: Tile[] = [];
  for (const film of best.values()) {
    if (film.genres[0] === "TV") {
      const name = film.collection ?? film.title;
      shows.set(name, [...(shows.get(name) ?? []), film]);
      continue;
    }
    const tags = film.genres.slice(1);
    tiles.push({
      key: film.id,
      title: film.title,
      sub: film.year ? String(film.year) : "Film",
      image: posterUrl(film.poster, 185),
      wide: false,
      ids: [film.id],
      durationMs: film.durationMs,
      tags,
      group: "film",
      search: `${film.title} ${film.year} ${film.director} ${tags.join(" ")} ${film.collection ?? ""}`.toLowerCase(),
    });
  }
  for (const [name, episodes] of shows) {
    episodes.sort(byEpisode);
    const first = episodes.find((film) => film.poster) ?? (episodes[0] as Film);
    const tags = first.genres.slice(1);
    tiles.push({
      key: `show:${name}`,
      title: name,
      sub: `${episodes.length} episode${episodes.length === 1 ? "" : "s"}`,
      image: posterUrl(first.poster, 185),
      wide: false,
      ids: episodes.map((film) => film.id),
      durationMs: episodes.reduce((sum, film) => sum + film.durationMs, 0),
      tags,
      group: "show",
      search: `${name} ${tags.join(" ")} show tv`.toLowerCase(),
    });
  }
  return tiles.sort((a, b) => a.title.localeCompare(b.title));
}

function musicTiles(byArtist: boolean): Tile[] {
  const songs = CATALOG.filter((film) => !diskMissingIds.has(film.id));
  if (!byArtist)
    return songs
      .map((film) => {
        const tags = [decadeOf(film), ...film.genres.slice(1)].filter(Boolean);
        return {
          key: film.id,
          title: film.synopsis || film.title,
          sub: film.director || "Unknown artist",
          image: thumb(film.id),
          wide: true,
          ids: [film.id],
          durationMs: film.durationMs,
          tags,
          group: "song" as const,
          search: `${film.title} ${film.year || ""} ${tags.join(" ")}`.toLowerCase(),
        };
      })
      .sort((a, b) => a.sub.localeCompare(b.sub) || a.title.localeCompare(b.title));
  const artists = new Map<string, Film[]>();
  for (const film of songs) {
    const name = film.collection || film.director || "Unknown artist";
    artists.set(name, [...(artists.get(name) ?? []), film]);
  }
  return [...artists]
    .map(([name, list]) => {
      const tags = [...new Set(list.flatMap((film) => [decadeOf(film), ...film.genres.slice(1)]).filter(Boolean))];
      return {
        key: `artist:${name}`,
        title: name,
        sub: `${list.length} song${list.length === 1 ? "" : "s"}`,
        image: thumb((list[0] as Film).id),
        wide: true,
        ids: list.map((film) => film.id),
        durationMs: list.reduce((sum, film) => sum + film.durationMs, 0),
        tags,
        group: "artist" as const,
        search: `${name} ${tags.join(" ")} ${list.map((film) => film.synopsis).join(" ")}`.toLowerCase(),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** A name from what was picked, so nobody has to think of one. Can always be changed. */
export function suggestName(picked: Tile[], music: boolean): string {
  if (picked.length === 0) return "";
  if (picked.length === 1) return (picked[0] as Tile).title;
  const count = new Map<string, number>();
  for (const tile of picked) for (const tag of new Set(tile.tags)) count.set(tag, (count.get(tag) ?? 0) + 1);
  const common = [...count].filter(([, n]) => n === picked.length).map(([tag]) => tag);
  if (music) {
    const decade = common.find((tag) => /^\d+s$/.test(tag));
    const genre = common.find((tag) => !/^\d+s$/.test(tag));
    if (decade && genre) return `${decade} ${genre}`;
    if (genre) return `${genre} Mix`;
    if (decade) return `${decade} Hits`;
  } else if (common[0]) {
    const shows = picked.every((tile) => tile.group === "show");
    const films = picked.every((tile) => tile.group === "film");
    return `${common[0]} ${shows ? "Shows" : films ? "Movies" : "Mix"}`;
  }
  const names = picked.map((tile) => tile.title);
  if (names.length <= 3 && names.join("").length < 40) return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
  // Mostly one thing: name it after the biggest share.
  const top = [...count].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= picked.length * 0.6) return `${top[0]} Mix`;
  return `${names[0]} & More`;
}

function hours(ms: number) {
  const h = ms / 3_600_000;
  return h >= 1 ? `${h >= 10 ? Math.round(h) : h.toFixed(1)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`;
}

type BuilderProps = {
  /** "new" makes a station; "add" adds to one (things already in it are left off the wall). */
  kind: "new" | "add";
  exclude?: Set<string>;
  order?: ChannelMode;
  onOrder?: (mode: ChannelMode) => void;
  onDone: (ids: string[], name: string) => void;
};

/**
 * Make a station by looking: click posters (or drag them) into the tray, and the name fills in by itself.
 */
export function StationBuilder({ kind, exclude, order, onOrder, onDone }: BuilderProps) {
  const music = libraryInfo.source === "music";
  const [byArtist, setByArtist] = useState(false);
  const all = useMemo(() => (music ? musicTiles(byArtist) : tvTiles()), [music, byArtist]);
  const [picked, setPicked] = useState<Tile[]>([]);
  const [text, setText] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [group, setGroup] = useState<"all" | "film" | "show">("all");
  const [name, setName] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [more, setMore] = useState(1);

  const wall = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter(
      (tile) =>
        (!exclude || tile.ids.some((id) => !exclude.has(id))) &&
        (group === "all" || tile.group === group) &&
        (!tag || tile.tags.includes(tag)) &&
        words.every((word) => tile.search.includes(word) || tile.title.toLowerCase().includes(word)),
    );
  }, [all, exclude, group, tag, text]);

  // The most common tags make the quick filters.
  const tags = useMemo(() => {
    const count = new Map<string, number>();
    for (const tile of all) for (const t of tile.tags) count.set(t, (count.get(t) ?? 0) + 1);
    const list = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const decades = list.filter((t) => /^\d+s$/.test(t)).sort((a, b) => (a.length - b.length) || a.localeCompare(b));
    return [...decades, ...list.filter((t) => !/^\d+s$/.test(t)).slice(0, 12)];
  }, [all]);

  const pickedKeys = new Set(picked.map((tile) => tile.key));
  const toggle = (tile: Tile) => setPicked((list) => (list.some((t) => t.key === tile.key) ? list.filter((t) => t.key !== tile.key) : [...list, tile]));
  const add = (tiles: Tile[]) => setPicked((list) => [...list, ...tiles.filter((tile) => !list.some((t) => t.key === tile.key))]);
  const ids = [...new Set(picked.flatMap((tile) => tile.ids))].filter((id) => !exclude?.has(id));
  const auto = suggestName(picked, music);
  const finalName = (name ?? auto).trim();
  const total = picked.reduce((sum, tile) => sum + tile.durationMs, 0);

  const onDropTray = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const key = event.dataTransfer.getData(DRAG);
    const tile = all.find((t) => t.key === key);
    if (tile) add([tile]);
  };
  const onDropWall = (event: DragEvent) => {
    const key = event.dataTransfer.getData(`${DRAG}-out`);
    if (!key) return;
    event.preventDefault();
    setPicked((list) => list.filter((t) => t.key !== key));
  };

  const chip = (on: boolean) => cn("rounded-full px-3 py-1 text-xs", on ? "bg-cream text-room" : "bg-cream/10 text-cream/80 hover:bg-cream/20");

  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_15rem] gap-3">
      <div className="flex min-h-0 flex-col" onDragOver={(event) => event.dataTransfer.types.includes(`${DRAG}-out`) && event.preventDefault()} onDrop={onDropWall}>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={music ? "Narrow down (optional)" : "Narrow down (optional)"}
            className="h-8 w-44 rounded-full border border-cream/15 bg-room px-3 text-xs text-cream outline-none focus-visible:outline-2 focus-visible:outline-accent"
          />
          {music ? (
            <>
              <button type="button" className={chip(!byArtist)} onClick={() => setByArtist(false)}>Songs</button>
              <button type="button" className={chip(byArtist)} onClick={() => setByArtist(true)}>Artists</button>
            </>
          ) : (
            (["all", "film", "show"] as const).map((g) => (
              <button key={g} type="button" className={chip(group === g)} onClick={() => setGroup(g)}>
                {g === "all" ? "Everything" : g === "film" ? "Movies" : "Shows"}
              </button>
            ))
          )}
          <span className="mx-1 h-4 w-px bg-cream/15" />
          {tags.map((t) => (
            <button key={t} type="button" className={chip(tag === t)} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-cream/50">
          <span>Click a picture to add it, or drag it into the tray. {wall.length} shown.</span>
          {wall.length > 1 && (text || tag || group !== "all") ? (
            <button type="button" className="text-accent hover:underline" onClick={() => add(wall)}>
              Add all {wall.length}
            </button>
          ) : null}
        </div>
        <div
          className={cn("mt-2 grid max-h-[26rem] min-h-40 gap-2 overflow-y-auto pr-1", music ? "grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))]")}
        >
          {wall.slice(0, LIMIT * more).map((tile) => {
            const on = pickedKeys.has(tile.key);
            return (
              <button
                key={tile.key}
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG, tile.key);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => toggle(tile)}
                title={`${tile.title} · ${tile.sub}`}
                className={cn("group relative text-left", on && "opacity-100")}
              >
                <div
                  className={cn(
                    "relative overflow-hidden rounded-md bg-screen ring-2 transition",
                    tile.wide ? "aspect-video" : "aspect-[2/3]",
                    on ? "ring-accent" : "ring-transparent group-hover:ring-cream/40",
                  )}
                >
                  {tile.image ? (
                    <img src={tile.image} alt="" loading="lazy" draggable={false} className={cn("size-full object-cover", on && "brightness-75")} onError={(event) => (event.currentTarget.style.visibility = "hidden")} />
                  ) : null}
                  {!tile.image || tile.wide ? (
                    <span className={cn("absolute inset-x-0 bottom-0 p-1.5 text-[0.7rem] leading-tight text-cream", tile.wide ? "bg-gradient-to-t from-black/85 to-transparent pt-4" : "top-0 flex items-center justify-center text-center")}>
                      {tile.title}
                    </span>
                  ) : null}
                  {on ? (
                    <span className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-accent text-sm font-bold text-room shadow">✓</span>
                  ) : (
                    <span className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-black/60 text-sm text-cream opacity-0 group-hover:opacity-100">+</span>
                  )}
                </div>
                <p className="mt-1 truncate text-[0.7rem] text-cream/80">{tile.wide ? tile.sub : tile.title}</p>
                {!tile.wide ? <p className="truncate text-[0.65rem] text-cream/45">{tile.sub}</p> : null}
              </button>
            );
          })}
          {wall.length > LIMIT * more ? (
            <button type="button" className="col-span-full rounded-md bg-cream/10 py-2 text-xs text-cream hover:bg-cream/20" onClick={() => setMore((n) => n + 1)}>
              Show more ({wall.length - LIMIT * more} left)
            </button>
          ) : null}
          {wall.length === 0 ? <p className="col-span-full py-6 text-center text-sm text-cream/45">Nothing matches. Clear the filters above.</p> : null}
        </div>
      </div>

      <aside
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DRAG)) return;
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDropTray}
        className={cn("flex min-h-0 flex-col rounded-xl border-2 border-dashed p-3 transition-colors", over ? "border-accent bg-accent/10" : "border-cream/15 bg-screen/50")}
      >
        <p className="text-sm font-semibold">{kind === "new" ? "Your new station" : "Adding to this station"}</p>
        <p className="text-xs text-cream/50">
          {picked.length === 0 ? "Drop pictures here" : `${ids.length} ${music ? (ids.length === 1 ? "song" : "songs") : ids.length === 1 ? "item" : "items"} · ${hours(total)}`}
        </p>
        <div className="mt-2 flex max-h-56 min-h-16 flex-wrap content-start gap-1.5 overflow-y-auto">
          {picked.map((tile) => (
            <button
              key={tile.key}
              type="button"
              draggable
              onDragStart={(event) => event.dataTransfer.setData(`${DRAG}-out`, tile.key)}
              onClick={() => toggle(tile)}
              title={`Take out ${tile.title}`}
              className={cn("group relative overflow-hidden rounded bg-screen", tile.wide ? "aspect-video w-[4.5rem]" : "aspect-[2/3] w-11")}
            >
              {tile.image ? <img src={tile.image} alt="" draggable={false} className="size-full object-cover" /> : <span className="p-0.5 text-[0.55rem] leading-tight">{tile.title}</span>}
              <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-base text-cream opacity-0 group-hover:opacity-100">×</span>
            </button>
          ))}
        </div>
        {picked.length > 0 ? (
          <div className="mt-auto flex flex-col gap-2 pt-3">
            {kind === "new" ? (
              <>
                <label className="text-xs text-cream/55">
                  Name {name == null ? <span className="text-cream/35">(picked for you)</span> : null}
                  <input
                    value={name ?? auto}
                    onChange={(event) => setName(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-cream/15 bg-room px-2 py-1.5 text-sm text-cream outline-none focus-visible:outline-2 focus-visible:outline-accent"
                  />
                </label>
                {name != null ? (
                  <button type="button" className="self-start text-[0.7rem] text-cream/50 underline hover:text-cream" onClick={() => setName(null)}>
                    Use the suggested name ({auto})
                  </button>
                ) : null}
                {onOrder ? (
                  <div className="flex gap-1.5">
                    <button type="button" className={chip(order === "loop")} onClick={() => onOrder("loop")}>In order</button>
                    <button type="button" className={chip(order === "shuffle")} onClick={() => onOrder("shuffle")}>Shuffle</button>
                  </div>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              disabled={ids.length === 0 || (kind === "new" && !finalName)}
              onClick={() => {
                onDone(ids, kind === "new" ? finalName : picked.length === 1 ? (picked[0] as Tile).title : `${picked.length} picks`);
                setPicked([]);
                setName(null);
              }}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-room shadow hover:brightness-110 disabled:opacity-40"
            >
              {kind === "new" ? "Make station" : `Add ${ids.length}`}
            </button>
            <button type="button" className="text-xs text-cream/50 hover:text-cream" onClick={() => setPicked([])}>
              Clear tray
            </button>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
