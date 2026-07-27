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
		// Underrun accounting. The queue running dry is the ONLY way this engine drops
		// audio, and it is otherwise silent about it — the gap just gets filled with
		// zeroes below and sounds like the tune stumbled. Counting it is what turns
		// "it hiccups sometimes on Safari" into a number, and tells us how long the
		// decode worker actually stalls, which is what the jitter buffer has to outlast.
		this.underruns = 0; // distinct dry spells
		this.silentFrames = 0; // frames of silence emitted in total
		this.inUnderrun = false;
		this.sinceReport = 0; // frames rendered since the last report
		this.reportedFrames = 0;
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
			// Only count it as a dropout while the song is still running; the tail after
			// the last chunk of a finished tune is silence by definition, not a fault.
			if (!this.eofPending) {
				this.silentFrames += n - i;
				if (!this.inUnderrun) {
					this.underruns++;
					this.inUnderrun = true;
				}
			}
		} else if (this.inUnderrun) {
			this.inUnderrun = false;
		}

		// Report at most once a second, and only when something was actually lost, so a
		// healthy stream posts nothing at all from the audio thread.
		this.sinceReport += n;
		if (this.sinceReport >= sampleRate) {
			if (this.silentFrames > this.reportedFrames) {
				this.port.postMessage({
					cmd: 'underrun',
					events: this.underruns,
					frames: this.silentFrames,
					lostMs: Math.round((this.silentFrames / sampleRate) * 1000),
					sinceMs: Math.round(((this.silentFrames - this.reportedFrames) / sampleRate) * 1000)
				});
				this.reportedFrames = this.silentFrames;
			}
			this.sinceReport = 0;
		}
		if (!this.queue.length && this.eofPending && !this.endSent) {
			this.port.postMessage({ cmd: 'end' });
			this.endSent = true;
		}
		return true;
	}
}

registerProcessor('libopenmpt-processor', MPT);
