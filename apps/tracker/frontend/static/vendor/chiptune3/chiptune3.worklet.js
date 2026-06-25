/*
 * PCM-drainer AudioWorklet (paired with decoder.worker.js).
 *
 * libopenmpt no longer runs here — the Worker renders PCM and ships fixed-size
 * chunks over a MessagePort. This processor just copies queued frames into the
 * output (a memcpy, never a parse), so the audio thread can't stall on a song
 * change. It acks each finished chunk back to the Worker (credit-based flow
 * control), reports playback position synced to what's actually being heard,
 * and drops chunks whose generation is stale (after a load/seek).
 */
class MPT extends AudioWorkletProcessor {
	constructor() {
		super();
		this.port.onmessage = this.onControl.bind(this);
		this.queue = [];
		this.paused = false;
		this.currentGen = -1;
		this.pcmPort = null;
		this.eofPending = false;
		this.endSent = false;
		this.lastReported = null;
	}

	onControl(e) {
		const d = e.data;
		switch (d.cmd) {
			case 'pcmport':
				this.pcmPort = d.port;
				this.pcmPort.onmessage = this.onPcm.bind(this);
				break;
			case 'pause':
				this.paused = true;
				break;
			case 'unpause':
				this.paused = false;
				break;
			case 'togglePause':
				this.paused = !this.paused;
				break;
			case 'flush':
				// New generation (load/seek): drop everything buffered.
				this.queue = [];
				this.currentGen = d.gen;
				this.eofPending = false;
				this.endSent = false;
				this.lastReported = null;
				break;
			default:
				break;
		}
	}

	onPcm(e) {
		const d = e.data;
		if (d.gen !== this.currentGen) return; // stale chunk from before a flush
		if (d.eof) {
			this.eofPending = true;
			return;
		}
		d.read = 0;
		this.queue.push(d);
	}

	process(_in, outputList) {
		const out = outputList[0];
		const left = out[0];
		const right = out[1];
		const n = left.length;

		if (this.paused) {
			left.fill(0);
			right.fill(0);
			return true;
		}

		let i = 0;
		while (i < n && this.queue.length) {
			const head = this.queue[0];
			if (head !== this.lastReported) {
				// Report position/VU at the moment this chunk starts playing.
				this.port.postMessage({
					cmd: 'pos',
					pos: head.pos,
					order: head.order,
					pattern: head.pattern,
					row: head.row,
					vu: head.vu
				});
				this.lastReported = head;
			}
			const count = Math.min(n - i, head.frames - head.read);
			left.set(head.left.subarray(head.read, head.read + count), i);
			right.set(head.right.subarray(head.read, head.read + count), i);
			i += count;
			head.read += count;
			if (head.read >= head.frames) {
				this.queue.shift();
				this.lastReported = null;
				if (this.pcmPort) this.pcmPort.postMessage({ cmd: 'ack', gen: head.gen });
			}
		}
		if (i < n) {
			// Underrun (worker fell behind) or end of song — fill with silence.
			left.fill(0, i);
			right.fill(0, i);
		}
		if (!this.queue.length && this.eofPending && !this.endSent) {
			this.port.postMessage({ cmd: 'end' });
			this.endSent = true;
		}
		return true;
	}
}

registerProcessor('libopenmpt-processor', MPT);
