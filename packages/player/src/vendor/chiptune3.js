// @ts-nocheck
/*
 * Vendored from chiptune3@0.8.7 (DrSnuggles), MIT — libopenmpt parts BSD.
 * https://github.com/DrSnuggles/chiptune
 *
 * Only change from upstream: the AudioWorklet is loaded from a fixed static URL
 * (`workletUrl`, default `/vendor/chiptune3/chiptune3.worklet.js`) instead of
 * `new URL('./chiptune3.worklet.js', import.meta.url)`. We serve the worklet +
 * its embedded-wasm `libopenmpt.worklet.js` verbatim from `static/` so Vite
 * doesn't try to bundle the worklet's internal import. Future: patch the worklet
 * to expose `play_note` for sample keyboard-jamming (see the plan / CLAUDE.md).
 */

const defaultCfg = {
	repeatCount: -1, // -1 = play endless, 0 = play once, do not repeat
	stereoSeparation: 100, // percents
	interpolationFilter: 0,
	context: false,
	workletUrl: '/vendor/chiptune3/chiptune3.worklet.js'
};

export class ChiptuneJsPlayer {
	constructor(cfg) {
		this.config = { ...defaultCfg, ...cfg };

		if (this.config.context) {
			if (!this.config.context.destination) {
				throw 'ChiptuneJsPlayer: This is not an audio context';
			}
			this.context = this.config.context;
			this.destination = false;
		} else {
			this.context = new AudioContext();
			this.destination = this.context.destination;
		}
		const workletUrl = this.config.workletUrl;
		delete this.config.context;
		delete this.config.workletUrl;

		this.gain = this.context.createGain();
		this.gain.gain.value = 1;

		this.handlers = [];

		this.context.audioWorklet
			.addModule(workletUrl)
			.then(() => {
				this.processNode = new AudioWorkletNode(this.context, 'libopenmpt-processor', {
					numberOfInputs: 0,
					numberOfOutputs: 1,
					outputChannelCount: [2]
				});
				this.processNode.port.onmessage = this.handleMessage_.bind(this);
				this.processNode.port.postMessage({ cmd: 'config', val: this.config });
				this.fireEvent('onInitialized');

				this.processNode.connect(this.gain);
				if (this.destination) this.gain.connect(this.destination);
			})
			.catch((e) => console.error(e));
	}

	handleMessage_(msg) {
		switch (msg.data.cmd) {
			case 'meta':
				this.meta = msg.data.meta;
				this.duration = msg.data.meta.dur;
				this.fireEvent('onMetadata', this.meta);
				break;
			case 'pos':
				this.currentTime = msg.data.pos;
				this.order = msg.data.order;
				this.pattern = msg.data.pattern;
				this.row = msg.data.row;
				this.fireEvent('onProgress', msg.data);
				break;
			case 'end':
				this.fireEvent('onEnded');
				break;
			case 'err':
				this.fireEvent('onError', { type: msg.data.val });
				break;
			case 'fullAudioData':
				this.fireEvent('onFullAudioData', msg.data);
				break;
			case 'parsed':
				this.fireEvent('onParsed', msg.data);
				break;
			default:
				console.log('Received unknown message', msg.data);
		}
	}

	fireEvent(eventName, response) {
		const handlers = this.handlers;
		if (handlers.length) {
			handlers.forEach(function (handler) {
				if (handler.eventName === eventName) {
					handler.handler(response);
				}
			});
		}
	}
	addHandler(eventName, handler) {
		this.handlers.push({ eventName: eventName, handler: handler });
	}
	onInitialized(handler) {
		this.addHandler('onInitialized', handler);
	}
	onEnded(handler) {
		this.addHandler('onEnded', handler);
	}
	onError(handler) {
		this.addHandler('onError', handler);
	}
	onMetadata(handler) {
		this.addHandler('onMetadata', handler);
	}
	onProgress(handler) {
		this.addHandler('onProgress', handler);
	}
	onFullAudioData(handler) {
		this.addHandler('onFullAudioData', handler);
	}
	onParsed(handler) {
		this.addHandler('onParsed', handler);
	}

	postMsg(cmd, val) {
		if (this.processNode) this.processNode.port.postMessage({ cmd: cmd, val: val });
	}
	load(url) {
		fetch(url)
			.then((response) => response.arrayBuffer())
			.then((arrayBuffer) => this.play(arrayBuffer))
			.catch(() => {
				this.fireEvent('onError', { type: 'Load' });
			});
	}
	play(val) {
		this.postMsg('play', val);
	}
	stop() {
		this.postMsg('stop');
	}
	pause() {
		this.postMsg('pause');
	}
	unpause() {
		this.postMsg('unpause');
	}
	togglePause() {
		this.postMsg('togglePause');
	}
	setRepeatCount(val) {
		this.postMsg('repeatCount', val);
	}
	setPitch(val) {
		this.postMsg('setPitch', val);
	}
	setTempo(val) {
		this.postMsg('setTempo', val);
	}
	setPos(val) {
		this.postMsg('setPos', val);
	}
	setOrderRow(o, r) {
		this.postMsg('setOrderRow', { o: o, r: r });
	}
	setVol(val) {
		this.gain.gain.value = val;
	}
	selectSubsong(val) {
		this.postMsg('selectSubsong', val);
	}
	seek(val) {
		this.setPos(val);
	}
	getCurrentTime() {
		return this.currentTime;
	}
	decodeAll(ab) {
		this.postMsg('decodeAll', ab);
	}
	parse(id, ab) {
		this.postMsg('parse', { id: id, file: ab });
	}
}
