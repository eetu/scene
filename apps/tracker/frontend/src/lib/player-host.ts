// Registers tracker's host with the shared @scene/player engine. Imported once
// for its side effect by the root layout, before any playback.
import { setPlayerHost } from "@scene/player";

import { api, fileUrl } from "./api";
import { playLength } from "./library";
import { library } from "./library.svelte";
import { peek, resolve } from "./tracks.svelte";

setPlayerHost({
  appName: "tracker",
  fileUrl,
  putMeta: api.putMeta,
  play: api.play,
  // The queue holds `files.id`s, not tracks — the library index lives
  // server-side. `peek` serves the rows the list already hydrated (the common
  // case, since you queue what you can see); `resolve` fetches the rest, which
  // is how shuffle can jump to an entry thousands of rows away.
  peekTrack: (ref) => (typeof ref === "number" ? peek(ref) : null),
  resolveTrack: (ref) => (typeof ref === "number" ? resolve(ref) : Promise.resolve(null)),
  // A SID's length isn't in the file. Play an unknown-length one for the
  // configured window so the transport and auto-advance have something to work
  // with, while the track's own `duration` stays null — the listing must not
  // claim a length nobody established.
  // The C64 ROMs are operator-supplied and copyrighted, so they're fetched from
  // the backend at runtime rather than shipped in the bundle.
  romBase: () => "/api/roms",
  // STIL: HVSC's curator commentary, for the text visualisers. A SID has no
  // sample slots, so without this the split-flap board and the hi-fi's text face
  // would show a bare title card where a module shows the composer's writing.
  // Only HVSC tunes have notes; everything else gets an empty list.
  trackNotes: (t) => (t.id == null ? Promise.resolve([]) : api.stil(t.id)),
  playLength: (t) =>
    playLength(
      { ext: t.ext ?? "", duration: t.duration ?? null } as never,
      library.status?.sid_default_length ?? 180,
    ),
});
