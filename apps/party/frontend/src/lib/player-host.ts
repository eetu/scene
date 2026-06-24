// Registers party's host with the shared @scene/player engine. Imported once
// for its side effect by the root layout, before any playback.
import { setPlayerHost } from '@scene/player';

import { api, fileUrl } from './api';

setPlayerHost({
	appName: 'party',
	fileUrl,
	putMeta: api.putMeta,
	// Party has no play-count endpoint; the no-op keeps the player's listen-
	// threshold gating intact without recording anything.
	play: async () => ({ play_count: 0 })
});
