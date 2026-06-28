// Registers tracker's host with the shared @scene/player engine. Imported once
// for its side effect by the root layout, before any playback.
import { setPlayerHost } from "@scene/player";

import { api, fileUrl } from "./api";

setPlayerHost({
  appName: "tracker",
  fileUrl,
  putMeta: api.putMeta,
  play: api.play,
});
