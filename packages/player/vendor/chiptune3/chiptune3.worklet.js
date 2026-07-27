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
		this.primed = false; // has a chunk of the current generation played yet?
		this.primeSilent = 0; // silence emitted while waiting for it

		// Rate drift, measured HERE rather than on the main thread. Two reasons the main
		// thread cannot see it: its timers are throttled to about once a minute once the
		// page is hidden, which is exactly when this is reported to happen, and a one-second
		// average flattens a wobble to nothing. This callback runs on the audio thread every
		// 128 frames and is not throttled while audio is playing.
		//
		// currentTime advances by one quantum per call, so comparing its advance against the
		// wall clock measures how fast the device is actually consuming audio. A device
		// running slow calls us less often than 128/sampleRate seconds, and the ratio is the
		// pitch error you can hear.
		this.driftCtx = 0;
		this.driftWall = 0;
		this.driftReportedAt = 0;
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
				// Waiting on the first chunk of a new song or seek. The silence until it
				// arrives is the load — fetch, parse, render — not the decoder falling
				// behind, and conflating the two makes the dropout count useless for
				// spotting the real thing.
				this.primed = false;
				this.primeSilent = 0;
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
			if (!this.primed) {
				// First audio of this song/seek is going out now: the load is over, and
				// anything that starves us after this really is the decoder falling behind.
				this.primed = true;
				this.port.postMessage({
					cmd: 'loadgap',
					ms: Math.round((this.primeSilent / sampleRate) * 1000)
				});
				this.primeSilent = 0;
			}
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
			if (this.eofPending) {
				// Tail of a finished song: silence by definition.
			} else if (!this.primed) {
				this.primeSilent += n - i;
			} else {
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
		// Rate check, about four times a second — fine enough to catch a wobble, coarse
		// enough that one late callback doesn't read as drift.
		const nowWall = Date.now();
		if (!this.driftWall) {
			this.driftWall = nowWall;
			this.driftCtx = currentTime;
		} else if (currentTime - this.driftCtx >= 0.25) {
			const ctxMs = (currentTime - this.driftCtx) * 1000;
			const wallMs = nowWall - this.driftWall;
			const errPct = ((wallMs - ctxMs) / ctxMs) * 100;
			// Over ~3% is audible as pitch; report at most once a second so a sustained
			// wobble doesn't flood the port from the audio thread.
			if (Math.abs(errPct) > 3 && nowWall - this.driftReportedAt > 1000) {
				this.driftReportedAt = nowWall;
				this.port.postMessage({
					cmd: 'ratedrift',
					percent: Math.round(errPct * 10) / 10,
					windowMs: Math.round(ctxMs)
				});
			}
			this.driftWall = nowWall;
			this.driftCtx = currentTime;
		}

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
