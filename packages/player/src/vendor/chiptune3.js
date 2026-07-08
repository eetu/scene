// @ts-nocheck
/*
 * Vendored from chiptune3@0.8.7 (DrSnuggles), MIT — libopenmpt parts BSD.
 * https://github.com/DrSnuggles/chiptune
 *
 * Heavily reworked for OFF-THREAD decoding: upstream parses + renders the
 * module inside the AudioWorklet (audio thread), so constructing a module on a
 * song change blocks the render and causes audible jitter. Here libopenmpt
 * lives in a regular module Worker (`decoder.worker.js`) that renders PCM ahead
 * of time and ships chunks straight to the worklet over a MessagePort; the
 * worklet (`chiptune3.worklet.js`) only drains the queue. This wrapper keeps
 * the same public API (load/play/stop/pause/.../onMetadata/onProgress/…), wires
 * the Worker↔worklet channel, and relays events:
 *   - onMetadata / onParsed / load errors  ← from the Worker
 *   - onProgress (pos/vu) / onEnded         ← from the worklet (synced to audio)
 * A generation counter (bumped on load/seek) lets the worklet drop stale chunks.
 */

const defaultCfg = {
	repeatCount: -1, // -1 = play endless, 0 = play once, do not repeat
	stereoSeparation: 100, // percents
	interpolationFilter: 0,
	context: false,
	workletUrl: '/vendor/chiptune3/chiptune3.worklet.js',
	workerUrl: '/vendor/chiptune3/decoder.worker.js'
};

export class ChiptuneJsPlayer {
	constructor(cfg) {
		this.config = { ...defaultCfg, ...cfg };

		if (this.config.context) {
			if (!this.config.context.destination) throw 'ChiptuneJsPlayer: This is not an audio context';
			this.context = this.config.context;
			this.destination = false;
		} else {
			this.context = new AudioContext();
			this.destination = this.context.destination;
		}
		const workletUrl = this.config.workletUrl;
		const workerUrl = this.config.workerUrl;
		delete this.config.context;
		delete this.config.workletUrl;
		delete this.config.workerUrl;

		this.gain = this.context.createGain();
		this.gain.gain.value = 1;
		// All audible output flows gain → monoNode → sinks. monoNode stays 2ch for
		// its whole life — its channel count is NEVER mutated, because doing so on a
		// node feeding a live MediaStream/<audio> (the background-playback route)
		// mutes the element until a reload. Mono (accessibility: one-earphone /
		// hearing-impaired listening) is instead a dedicated 1ch downmix node fed
		// into monoNode, toggled by (re)connecting the signal — connect/disconnect
		// is reliable at runtime and never changes any sink's channel count.
		this.monoNode = this.context.createGain();
		this.monoDownmix = this.context.createGain();
		this.monoDownmix.channelCount = 1;
		this.monoDownmix.channelCountMode = 'explicit'; // collapse L+R → 1ch
		this.monoDownmix.connect(this.monoNode); // …then monoNode upmixes 1→2ch

		this.handlers = [];
		this.gen = 0;
		this.currentTime = 0;
		this.workerReady = false;
		this.nodeReady = false;
		this.initFired = false;

		// Custom-build capability (sample extraction). Reported by the worker's
		// `ready` message; false on the stock build so UI degrades cleanly.
		this.capabilities = { canReadSamples: false, canMuteChannels: false, canReadCells: false };
		// Pending request/response tables for async sample reads.
		this.sampleReqId = 0;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		this.pendingSample = new Map();
		this.rawReqId = 0;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		this.pendingRaw = new Map();
		this.decodeReqId = 0;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		this.pendingDecode = new Map();
		// Resolves once the decoder Worker's WASM is up (independent of the audio
		// worklet, which the browser may not init until a user gesture). Lets the
		// app decode a module for display before audio can start.
		this.workerReadyPromise = new Promise((res) => (this._resolveWorkerReady = res));

		// Decoder Worker (module worker → can `import` the libopenmpt glue).
		this.worker = new Worker(workerUrl, { type: 'module' });
		this.worker.onmessage = (e) => this.handleWorkerMessage_(e.data);
		this.worker.onerror = () => this.fireEvent('onError', { type: 'Worker' });

		this.context.audioWorklet
			.addModule(workletUrl)
			.then(() => {
				this.processNode = new AudioWorkletNode(this.context, 'libopenmpt-processor', {
					numberOfInputs: 0,
					numberOfOutputs: 1,
					outputChannelCount: [2]
				});
				this.processNode.port.onmessage = (e) => this.handleNodeMessage_(e.data);

				// Direct Worker→worklet PCM pipe (no main-thread relay).
				const mc = new MessageChannel();
				this.processNode.port.postMessage({ cmd: 'pcmport', port: mc.port1 }, [mc.port1]);
				this.worker.postMessage(
					{ cmd: 'pcmport', port: mc.port2, sampleRate: this.context.sampleRate, config: this.config },
					[mc.port2]
				);

				this.processNode.connect(this.gain);
				this.gain.connect(this.monoNode);
				if (this.destination) this.monoNode.connect(this.destination);

				this.nodeReady = true;
				this.maybeInit_();
			})
			.catch((e) => console.error(e));
	}

	maybeInit_() {
		if (this.workerReady && this.nodeReady && !this.initFired) {
			this.initFired = true;
			this.fireEvent('onInitialized');
		}
	}

	handleWorkerMessage_(d) {
		switch (d.cmd) {
			case 'ready':
				this.workerReady = true;
				if (d.caps) this.capabilities = d.caps;
				this._resolveWorkerReady?.();
				this.maybeInit_();
				break;
			case 'decoded': {
				const r = this.pendingDecode.get(d.id);
				if (r) {
					this.pendingDecode.delete(d.id);
					r(d.meta ?? null);
				}
				break;
			}
			case 'sample': {
				const r = this.pendingSample.get(d.id);
				if (r) {
					this.pendingSample.delete(d.id);
					r(d.info ? { info: d.info, pcm: d.pcm } : null);
				}
				break;
			}
			case 'sampleRaw': {
				const r = this.pendingRaw.get(d.id);
				if (r) {
					this.pendingRaw.delete(d.id);
					r(d.info ? { info: d.info, raw: d.raw } : null);
				}
				break;
			}
			case 'meta':
				this.meta = d.meta;
				this.duration = d.meta.dur;
				this.fireEvent('onMetadata', this.meta);
				break;
			case 'parsed':
				this.fireEvent('onParsed', { id: d.id, meta: d.meta });
				break;
			case 'err':
				this.fireEvent('onError', { type: d.val });
				break;
			default:
				break;
		}
	}

	handleNodeMessage_(d) {
		switch (d.cmd) {
			case 'pos':
				this.currentTime = d.pos;
				this.order = d.order;
				this.pattern = d.pattern;
				this.row = d.row;
				this.fireEvent('onProgress', d);
				break;
			case 'end':
				this.fireEvent('onEnded');
				break;
			case 'err':
				this.fireEvent('onError', { type: d.val });
				break;
			default:
				break;
		}
	}

	fireEvent(eventName, response) {
		for (const h of this.handlers) if (h.eventName === eventName) h.handler(response);
	}
	addHandler(eventName, handler) {
		this.handlers.push({ eventName, handler });
	}
	onInitialized(h) {
		this.addHandler('onInitialized', h);
	}
	onEnded(h) {
		this.addHandler('onEnded', h);
	}
	onError(h) {
		this.addHandler('onError', h);
	}
	onMetadata(h) {
		this.addHandler('onMetadata', h);
	}
	onProgress(h) {
		this.addHandler('onProgress', h);
	}
	onFullAudioData(h) {
		this.addHandler('onFullAudioData', h);
	}
	onParsed(h) {
		this.addHandler('onParsed', h);
	}

	// --- transport --------------------------------------------------------
	load(url) {
		fetch(url)
			.then((r) => r.arrayBuffer())
			.then((ab) => this.play(ab))
			.catch(() => this.fireEvent('onError', { type: 'Load' }));
	}
	play(buffer) {
		this.gen++;
		// New song: flush the worklet's queue, then hand the bytes to the worker.
		this.processNode?.port.postMessage({ cmd: 'flush', gen: this.gen });
		this.worker.postMessage({ cmd: 'load', bytes: buffer, gen: this.gen }, [buffer]);
	}
	stop() {
		this.worker.postMessage({ cmd: 'stop' });
		this.processNode?.port.postMessage({ cmd: 'flush', gen: this.gen });
	}
	pause() {
		this.processNode?.port.postMessage({ cmd: 'pause' });
	}
	unpause() {
		this.processNode?.port.postMessage({ cmd: 'unpause' });
	}
	togglePause() {
		this.processNode?.port.postMessage({ cmd: 'togglePause' });
	}
	setRepeatCount(val) {
		this.worker.postMessage({ cmd: 'repeatCount', val });
	}
	setPitch(val) {
		this.worker.postMessage({ cmd: 'setPitch', val });
	}
	setTempo(val) {
		this.worker.postMessage({ cmd: 'setTempo', val });
	}
	setPos(val) {
		this.gen++;
		this.processNode?.port.postMessage({ cmd: 'flush', gen: this.gen });
		this.worker.postMessage({ cmd: 'setPos', val, gen: this.gen });
	}
	setOrderRow(o, r) {
		this.gen++;
		this.processNode?.port.postMessage({ cmd: 'flush', gen: this.gen });
		this.worker.postMessage({ cmd: 'setOrderRow', val: { o, r }, gen: this.gen });
	}
	setVol(val) {
		this.gain.gain.value = val;
	}
	/** Collapse output to mono (true) or pass stereo through (false). Reroutes the
	 *  gain → sink edge through (mono) or around (stereo) the 1ch downmix node.
	 *  monoNode's own channel count never changes, so the MediaStream feeding the
	 *  background <audio> keeps a constant 2ch layout and doesn't mute. */
	setMono(on) {
		if (!this.gain || !this.nodeReady) return;
		try {
			this.gain.disconnect(this.monoNode);
		} catch {
			/* edge not present */
		}
		try {
			this.gain.disconnect(this.monoDownmix);
		} catch {
			/* edge not present */
		}
		this.gain.connect(on ? this.monoDownmix : this.monoNode);
	}
	selectSubsong(val) {
		this.worker.postMessage({ cmd: 'selectSubsong', val });
	}
	/** Mute/unmute pattern channel `ch` (0-based) on the live module — for editor
	 *  solo/mute. No-op on the stock build (canMuteChannels false). */
	muteChannel(ch, on) {
		if (!this.capabilities.canMuteChannels) return;
		this.worker.postMessage({ cmd: 'muteChannel', ch, on });
	}
	seek(val) {
		this.setPos(val);
	}
	getCurrentTime() {
		return this.currentTime;
	}
	decodeAll() {
		/* unused in this app — full-PCM decode path not wired in the worker */
	}
	parse(id, ab) {
		this.worker.postMessage({ cmd: 'parse', id, file: ab });
	}

	/** Resolves once the decoder Worker's WASM is ready — independent of the audio
	 *  worklet (which the browser may hold suspended until a user gesture). */
	whenWorkerReady() {
		return this.workerReadyPromise;
	}

	/** Decode a module's full metadata + song (patterns/cells) WITHOUT starting
	 *  audio — for showing the pattern of a track restored on a cold reload. When
	 *  idle, the worker keeps the decoded module resident so the samples view can
	 *  read waveforms without a gesture. Resolves with the meta (incl. `song`). */
	decodeSong(ab) {
		const id = ++this.decodeReqId;
		return new Promise((resolve) => {
			this.pendingDecode.set(id, resolve);
			this.worker.postMessage({ cmd: 'decodeSong', id, file: ab });
		});
	}

	/** Read one sample's PCM + metadata (1-based index). Resolves with
	 *  { info, pcm:Float32Array } or null. (Jamming plays this PCM via Web Audio
	 *  in the store — no engine round-trip needed.) */
	readSample(idx) {
		if (!this.capabilities.canReadSamples) return Promise.resolve(null);
		const id = ++this.sampleReqId;
		return new Promise((resolve) => {
			this.pendingSample.set(id, resolve);
			this.worker.postMessage({ cmd: 'readSample', id, idx });
		});
	}
	/** Read a sample's RAW bytes (native format) + info, for WAV export. Resolves
	 *  with { info, raw:Uint8Array } or null. */
	readSampleRaw(idx) {
		if (!this.capabilities.canReadSamples) return Promise.resolve(null);
		const id = ++this.rawReqId;
		return new Promise((resolve) => {
			this.pendingRaw.set(id, resolve);
			this.worker.postMessage({ cmd: 'readSampleRaw', id, idx });
		});
	}
}
