/*
 * Off-thread libopenmpt decoder (module Worker).
 *
 * Why: the upstream chiptune3 builds and renders the module *inside* the
 * AudioWorklet, on the audio thread. Constructing a module
 * (openmpt_module_create_from_memory) is a synchronous multi-ms parse, and
 * doing it on the audio thread blocks the next render quantum → the audible
 * jitter on song changes. Here libopenmpt lives in a regular Worker: it parses
 * and renders PCM ahead of time and ships fixed-size chunks to the worklet over
 * a MessagePort. The worklet only drains the queue (a memcpy), so it never
 * stalls. Song change = parse here, off the audio thread.
 *
 * Flow control is credit-based: we keep at most TARGET chunks "in flight"
 * (sent but not yet acked by the worklet). The worklet acks each chunk it
 * finishes playing, which tops us back up. A generation counter (bumped on
 * load/seek) lets the worklet drop stale chunks still in transit.
 */
import libopenmptPromise from './libopenmpt.worklet.js';

const OPENMPT_MODULE_RENDER_STEREOSEPARATION_PERCENT = 2;
const OPENMPT_MODULE_RENDER_INTERPOLATIONFILTER_LENGTH = 3;

const CHUNK = 1024; // frames per chunk (~21ms @48k) — fine-grained for pattern/VU sync
const TARGET = 24; // chunks kept in flight (~512ms jitter buffer) — deep enough to ride
// through the background-worker throttling (macOS App Nap etc.) that hits on a desktop/app
// switch, which briefly starves decode and would otherwise underrun the audio thread.

let lib = null;
let sampleRate = 48000;
let config = { repeatCount: -1, stereoSeparation: 100, interpolationFilter: 0 };

let modulePtr = 0; // the song being played (a plain module)
let leftPtr = 0;
let rightPtr = 0;
let channels = 0;

// Custom-build capability: this app vendors a libopenmpt WASM carrying the smp_*
// shim (the stock build lacks it), which reads raw sample data off the module.
// Detected once at init; the sample/jam UI gates on it. (Jamming itself is pure
// Web Audio in the store — the worker only extracts sample data here.)
let caps = { canReadSamples: false, canMuteChannels: false, canReadCells: false };

let gen = 0; // current playback generation (bumped on load/seek)
let playing = false;
let eof = false;
let inflight = 0;
let pcmPort = null;

// --- libopenmpt helpers (from the upstream worklet) -------------------------
function writeAscii(str, buffer) {
	for (let i = 0; i < str.length; ++i) lib.HEAP8[buffer++ >> 0] = str.charCodeAt(i);
	lib.HEAP8[buffer >> 0] = 0;
}
function asciiToStack(str) {
	const p = lib.stackAlloc(str.length + 1);
	writeAscii(str, p);
	return p;
}

libopenmptPromise()
	.then((res) => {
		lib = res;
		if (lib.stackSave) {
			const stack = lib.stackSave();
			lib.version = lib.UTF8ToString(lib._openmpt_get_string(asciiToStack('library_version')));
			lib.build = lib.UTF8ToString(lib._openmpt_get_string(asciiToStack('build')));
			lib.stackRestore(stack);
		}
		caps = {
			canReadSamples: typeof lib._smp_read === 'function' && typeof lib._smp_info === 'function',
			canMuteChannels: typeof lib._chan_mute === 'function',
			canReadCells: typeof lib._openmpt_module_get_pattern_row_channel_command === 'function'
		};
		self.postMessage({ cmd: 'ready', caps });
	})
	.catch((e) => self.postMessage({ cmd: 'err', val: String(e) }));

// --- module lifecycle -------------------------------------------------------
function destroyModule() {
	if (modulePtr) {
		lib._openmpt_module_destroy(modulePtr);
		modulePtr = 0;
	}
	if (leftPtr) {
		lib._free(leftPtr);
		leftPtr = 0;
	}
	if (rightPtr) {
		lib._free(rightPtr);
		rightPtr = 0;
	}
	channels = 0;
}

function createModule(buffer) {
	destroyModule();
	const bytes = new Int8Array(buffer);
	const filePtr = lib._malloc(bytes.byteLength);
	lib.HEAPU8.set(bytes, filePtr);
	modulePtr = lib._openmpt_module_create_from_memory(filePtr, bytes.byteLength, 0, 0, 0);
	lib._free(filePtr); // openmpt copies the bytes
	if (!modulePtr) return false;

	if (lib.stackSave) {
		const stack = lib.stackSave();
		lib._openmpt_module_ctl_set(
			modulePtr,
			asciiToStack('render.resampler.emulate_amiga'),
			asciiToStack('1')
		);
		lib._openmpt_module_ctl_set(
			modulePtr,
			asciiToStack('render.resampler.emulate_amiga_type'),
			asciiToStack('a1200')
		);
		lib.stackRestore(stack);
	}
	lib._openmpt_module_set_repeat_count(modulePtr, config.repeatCount);
	lib._openmpt_module_set_render_param(
		modulePtr,
		OPENMPT_MODULE_RENDER_STEREOSEPARATION_PERCENT,
		config.stereoSeparation
	);
	lib._openmpt_module_set_render_param(
		modulePtr,
		OPENMPT_MODULE_RENDER_INTERPOLATIONFILTER_LENGTH,
		config.interpolationFilter
	);
	leftPtr = lib._malloc(4 * CHUNK);
	rightPtr = lib._malloc(4 * CHUNK);
	channels = lib._openmpt_module_get_num_channels(modulePtr);
	return true;
}

// Render one chunk and post it to the worklet, tagged with the position/VU at
// its start (so the worklet can report progress synced to playback).
function renderAndSend() {
	if (!modulePtr) return false;
	const pos = lib._openmpt_module_get_position_seconds(modulePtr);
	const order = lib._openmpt_module_get_current_order(modulePtr);
	const pattern = lib._openmpt_module_get_current_pattern(modulePtr);
	const row = lib._openmpt_module_get_current_row(modulePtr);
	const vu = [];
	for (let i = 0; i < channels; i++) {
		vu.push(lib._openmpt_module_get_current_channel_vu_mono(modulePtr, i));
	}
	const frames = lib._openmpt_module_read_float_stereo(modulePtr, sampleRate, CHUNK, leftPtr, rightPtr);
	if (frames === 0) {
		eof = true;
		pcmPort.postMessage({ gen, eof: true });
		return false;
	}
	// Copy out of the WASM heap (it gets reused next render).
	const left = lib.HEAPF32.slice(leftPtr / 4, leftPtr / 4 + frames);
	const right = lib.HEAPF32.slice(rightPtr / 4, rightPtr / 4 + frames);
	pcmPort.postMessage({ gen, frames, left, right, pos, order, pattern, row, vu }, [
		left.buffer,
		right.buffer
	]);
	inflight++;
	return true;
}

function pump() {
	if (!pcmPort) return;
	while (playing && !eof && inflight < TARGET) {
		if (!renderAndSend()) break;
	}
}

// Read one sample's PCM + metadata out of the loaded module (custom build only).
// Returns { info, pcm:Float32Array } or null. Sample index is 1-based.
function sampleInfo(idx) {
	if (!modulePtr || !caps.canReadSamples) return null;
	const infoPtr = lib._malloc(16 * 4);
	if (!lib._smp_info(modulePtr, idx, infoPtr)) {
		lib._free(infoPtr);
		return null;
	}
	const I = lib.HEAP32.subarray(infoPtr >> 2, (infoPtr >> 2) + 16);
	const info = {
		length: I[0],
		loopStart: I[1],
		loopEnd: I[2],
		sustainStart: I[3],
		sustainEnd: I[4],
		rate: I[5],
		channels: I[6],
		bits: I[7],
		flags: I[8], // bit0 loop | bit1 pingpong | bit2 sustain | bit3 sustain-pingpong
		volume: I[9],
		panning: I[10], // -1 if no pan flag
		finetune: I[11],
		relativeNote: I[12],
		globalVol: I[13]
	};
	lib._free(infoPtr);
	return info;
}

function readSample(idx) {
	const info = sampleInfo(idx);
	if (!info) return null;
	const len = info.length;
	if (len <= 0) return { info, pcm: new Float32Array(0) };
	const bufPtr = lib._malloc(4 * len);
	const frames = lib._smp_read(modulePtr, idx, bufPtr, len);
	const pcm = lib.HEAPF32.slice(bufPtr >> 2, (bufPtr >> 2) + frames); // copy out of heap
	lib._free(bufPtr);
	return { info, pcm };
}

// Raw sample bytes (native bit-depth, interleaved) for a bit-exact WAV export.
// Returns { info, raw:Uint8Array } or null.
function readSampleRaw(idx) {
	const info = sampleInfo(idx);
	if (!info) return null;
	const bytes = info.length * (info.bits / 8) * info.channels;
	if (bytes <= 0) return { info, raw: new Uint8Array(0) };
	const bufPtr = lib._malloc(bytes);
	const n = lib._smp_raw(modulePtr, idx, bufPtr, bytes);
	const raw = lib.HEAPU8.slice(bufPtr, bufPtr + n); // copy out of heap
	lib._free(bufPtr);
	return { info, raw };
}

// Lightweight parse for bulk metadata enrichment — its own throwaway module, so
// it never disturbs playback.
function parse(id, file) {
	const bytes = new Int8Array(file);
	const p = lib._malloc(bytes.byteLength);
	lib.HEAPU8.set(bytes, p);
	const m = lib._openmpt_module_create_from_memory(p, bytes.byteLength, 0, 0, 0);
	lib._free(p);
	if (!m) {
		self.postMessage({ cmd: 'parsed', id, meta: null });
		return;
	}
	const get = (name) => {
		const kb = lib._malloc(name.length + 1);
		writeAscii(name, kb);
		const s = lib.UTF8ToString(lib._openmpt_module_get_metadata(m, kb));
		lib._free(kb);
		return s;
	};
	const meta = {
		title: get('title'),
		type_long: get('type_long'),
		tracker: get('tracker'),
		dur: lib._openmpt_module_get_duration_seconds(m),
		channels: lib._openmpt_module_get_num_channels(m),
		instruments: lib._openmpt_module_get_num_instruments(m),
		samples: lib._openmpt_module_get_num_samples(m),
		orders: lib._openmpt_module_get_num_orders(m),
		patterns: lib._openmpt_module_get_num_patterns(m)
	};
	lib._openmpt_module_destroy(m);
	self.postMessage({ cmd: 'parsed', id, meta });
}

// --- full metadata (for the now-playing track) ------------------------------
function getSong(mod) {
	const song = { channels: [], instruments: [], samples: [], orders: [], patterns: [] };
	const chNum = lib._openmpt_module_get_num_channels(mod);
	for (let i = 0; i < chNum; i++)
		song.channels.push(lib.UTF8ToString(lib._openmpt_module_get_channel_name(mod, i)));
	for (let i = 0, e = lib._openmpt_module_get_num_instruments(mod); i < e; i++)
		song.instruments.push(lib.UTF8ToString(lib._openmpt_module_get_instrument_name(mod, i)));
	for (let i = 0, e = lib._openmpt_module_get_num_samples(mod); i < e; i++)
		song.samples.push(lib.UTF8ToString(lib._openmpt_module_get_sample_name(mod, i)));
	for (let i = 0, e = lib._openmpt_module_get_num_orders(mod); i < e; i++)
		song.orders.push({
			name: lib.UTF8ToString(lib._openmpt_module_get_order_name(mod, i)),
			pat: lib._openmpt_module_get_order_pattern(mod, i)
		});
	// Structured per-cell fields (note/inst/volcmd/vol/fx/param) for the editor —
	// only when the custom build exports the getter (else `cells` stays absent and
	// the app falls back to the formatted `rows` strings; party is unaffected). The
	// libopenmpt command indices: NOTE 0, INSTRUMENT 1, VOLUMEEFFECT 2, EFFECT 3,
	// VOLUME 4, PARAMETER 5. Each cell is a compact [note,inst,volcmd,vol,fx,param].
	const cmd = lib._openmpt_module_get_pattern_row_channel_command;
	const wantCells = typeof cmd === 'function';
	for (let pi = 0, pn = lib._openmpt_module_get_num_patterns(mod); pi < pn; pi++) {
		const pattern = { name: lib.UTF8ToString(lib._openmpt_module_get_pattern_name(mod, pi)), rows: [] };
		if (wantCells) pattern.cells = [];
		for (let ri = 0, rn = lib._openmpt_module_get_pattern_num_rows(mod, pi); ri < rn; ri++) {
			const rowArr = [];
			const cellArr = wantCells ? [] : null;
			for (let ci = 0; ci < chNum; ci++) {
				const cell = lib._openmpt_module_format_pattern_row_channel(mod, pi, ri, ci, 0, 0);
				rowArr.push(lib.UTF8ToString(cell));
				lib._openmpt_free_string(cell);
				if (wantCells)
					cellArr.push([
						cmd(mod, pi, ri, ci, 0), // note
						cmd(mod, pi, ri, ci, 1), // instrument
						cmd(mod, pi, ri, ci, 2), // volume effect
						cmd(mod, pi, ri, ci, 4), // volume
						cmd(mod, pi, ri, ci, 3), // effect
						cmd(mod, pi, ri, ci, 5) // parameter
					]);
			}
			pattern.rows.push(rowArr);
			if (wantCells) pattern.cells.push(cellArr);
		}
		song.patterns.push(pattern);
	}
	return song;
}
// Build the full metadata object (incl. the structured song) for a given module.
function metaFor(mod) {
	const data = {};
	data.dur = lib._openmpt_module_get_duration_seconds(mod);
	const keys = lib.UTF8ToString(lib._openmpt_module_get_metadata_keys(mod)).split(';');
	for (let i = 0; i < keys.length; i++) {
		const kb = lib._malloc(keys[i].length + 1);
		writeAscii(keys[i], kb);
		data[keys[i]] = lib.UTF8ToString(lib._openmpt_module_get_metadata(mod, kb));
		lib._free(kb);
	}
	data.song = getSong(mod);
	data.totalOrders = data.song.orders.length;
	data.totalPatterns = data.song.patterns.length;
	data.libopenmptVersion = lib.version;
	data.libopenmptBuild = lib.build;
	return data;
}
function getMeta() {
	const data = metaFor(modulePtr);
	if (data.dur === 0) self.postMessage({ cmd: 'err', val: 'dur' });
	return data;
}

// Decode a module's full metadata + song (patterns/cells) without starting audio
// (no pcmPort, no pump). Lets the app show the pattern for a track restored on a
// cold reload, where the browser blocks the audio worklet until a user gesture —
// audio then starts later via a normal load.
//
// When nothing is playing (the cold-restore case) we keep the decoded module
// RESIDENT as `modulePtr` instead of discarding it: readSample/readSampleRaw read
// off `modulePtr`, so a throwaway would leave the samples view with names but no
// waveform/props/jam until a gesture starts audio. If a song is actively playing
// we stay a throwaway (destroy `m`) so we never disturb live playback; a later
// `load` (play) recreates the module fresh via createModule().
function decodeSong(id, file) {
	if (!lib) return self.postMessage({ cmd: 'decoded', id, meta: null });
	const bytes = new Int8Array(file);
	const p = lib._malloc(bytes.byteLength);
	lib.HEAPU8.set(bytes, p);
	const m = lib._openmpt_module_create_from_memory(p, bytes.byteLength, 0, 0, 0);
	lib._free(p);
	if (!m) return self.postMessage({ cmd: 'decoded', id, meta: null });
	const meta = metaFor(m);
	if (playing) {
		lib._openmpt_module_destroy(m);
	} else {
		destroyModule(); // drop any previously-resident (idle) module first
		modulePtr = m;
		channels = lib._openmpt_module_get_num_channels(m);
	}
	self.postMessage({ cmd: 'decoded', id, meta });
}

// --- command handling -------------------------------------------------------
function onPcmAck(e) {
	const d = e.data;
	if (d.cmd === 'ack' && d.gen === gen) {
		inflight--;
		pump();
	}
}

self.onmessage = (e) => {
	const d = e.data;
	switch (d.cmd) {
		case 'config':
			config = { ...config, ...d.val };
			break;
		case 'init':
			sampleRate = d.sampleRate || sampleRate;
			break;
		case 'pcmport':
			sampleRate = d.sampleRate || sampleRate;
			if (d.config) config = { ...config, ...d.config };
			pcmPort = d.port;
			pcmPort.onmessage = onPcmAck;
			break;
		case 'load':
			if (!lib) return self.postMessage({ cmd: 'err', val: 'notready' });
			gen = d.gen;
			eof = false;
			inflight = 0;
			if (!createModule(d.bytes)) {
				playing = false;
				return self.postMessage({ cmd: 'err', val: 'ptr' });
			}
			playing = true;
			self.postMessage({ cmd: 'meta', meta: getMeta() });
			pump();
			break;
		case 'stop':
			playing = false;
			eof = true;
			inflight = 0;
			destroyModule();
			break;
		case 'setPos':
			if (!modulePtr) return;
			gen = d.gen;
			eof = false;
			inflight = 0;
			lib._openmpt_module_set_position_seconds(modulePtr, d.val);
			pump();
			break;
		case 'setOrderRow':
			if (!modulePtr) return;
			gen = d.gen;
			eof = false;
			inflight = 0;
			lib._openmpt_module_set_position_order_row(modulePtr, d.val.o, d.val.r);
			pump();
			break;
		case 'repeatCount':
			config.repeatCount = d.val;
			if (modulePtr) lib._openmpt_module_set_repeat_count(modulePtr, d.val);
			break;
		case 'setPitch':
			if (modulePtr && lib.stackSave) {
				const s = lib.stackSave();
				lib._openmpt_module_ctl_set(modulePtr, asciiToStack('play.pitch_factor'), asciiToStack(String(d.val)));
				lib.stackRestore(s);
			}
			break;
		case 'setTempo':
			if (modulePtr && lib.stackSave) {
				const s = lib.stackSave();
				lib._openmpt_module_ctl_set(modulePtr, asciiToStack('play.tempo_factor'), asciiToStack(String(d.val)));
				lib.stackRestore(s);
			}
			break;
		case 'selectSubsong':
			if (modulePtr) lib._openmpt_module_select_subsong(modulePtr, d.val);
			break;
		case 'muteChannel':
			// Mute/unmute a pattern channel on the live module (editor solo/mute).
			if (modulePtr && typeof lib._chan_mute === 'function')
				lib._chan_mute(modulePtr, d.ch | 0, d.on ? 1 : 0);
			break;
		case 'parse':
			if (lib) parse(d.id, d.file);
			break;
		case 'decodeSong':
			decodeSong(d.id, d.file);
			break;
		case 'readSample': {
			const res = readSample(d.idx | 0);
			if (res)
				self.postMessage({ cmd: 'sample', id: d.id, idx: d.idx, info: res.info, pcm: res.pcm }, [
					res.pcm.buffer
				]);
			else self.postMessage({ cmd: 'sample', id: d.id, idx: d.idx, info: null, pcm: null });
			break;
		}
		case 'readSampleRaw': {
			const res = readSampleRaw(d.idx | 0);
			if (res)
				self.postMessage({ cmd: 'sampleRaw', id: d.id, idx: d.idx, info: res.info, raw: res.raw }, [
					res.raw.buffer
				]);
			else self.postMessage({ cmd: 'sampleRaw', id: d.id, idx: d.idx, info: null, raw: null });
			break;
		}
		default:
			break;
	}
};
