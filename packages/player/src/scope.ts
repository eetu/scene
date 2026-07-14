// Output analysis for visualizers — waveform (scope), frequency magnitudes
// (spectrum), and a 3-band energy split. Reads from an AnalyserNode tapped off
// the audio graph; the store injects that node via setScopeSource once the graph
// exists, so this module has no engine/store dependency of its own.

let analyser: AnalyserNode | null = null;

/** Point the readers at the output analyser (or null to detach). Called by the
 *  store when the audio graph comes up / is torn down. */
export function setScopeSource(node: AnalyserNode | null) {
  analyser = node;
}

/** Output-waveform sample count for the scope (power of two). */
export const SCOPE_SIZE = 2048;
/** Number of frequency bins the analyser exposes (fftSize / 2). */
export const SPECTRUM_SIZE = SCOPE_SIZE / 2;

/** Fill `buf` (length SCOPE_SIZE) with the current output waveform (0–255,
 *  128 = silence). Returns false until the audio graph exists. */
export function readScope(buf: Uint8Array<ArrayBuffer>): boolean {
  if (!analyser) return false;
  analyser.getByteTimeDomainData(buf);
  return true;
}

/** Fill `buf` (length SPECTRUM_SIZE) with the current output frequency
 *  magnitudes (0–255). Returns false until the audio graph exists. Powers the
 *  equalizer/spectrum visualizer. */
export function readSpectrum(buf: Uint8Array<ArrayBuffer>): boolean {
  if (!analyser) return false;
  analyser.getByteFrequencyData(buf);
  return true;
}

/** Output sample rate (Hz) of the analyser's context — needed to map a
 *  frequency bin to a musical pitch (bin `i` ≈ `i * sampleRate / 2 / SPECTRUM_SIZE`
 *  Hz). Falls back to the common 48 kHz until the audio graph exists. */
export function spectrumSampleRate(): number {
  return analyser ? analyser.context.sampleRate : 48000;
}

// Reused across sampleBands() calls so a per-frame viz doesn't allocate.
const bandBuf = new Uint8Array(SPECTRUM_SIZE);

/** Current output energy split into three bands (bass / mid / treble), each
 *  roughly 0–1, from the analyser's frequency magnitudes averaged over fixed Hz
 *  ranges. Zeros until the audio graph exists. Lets visualizers react per-band
 *  (e.g. bass → pulse, treble → sparkle) instead of to one overall level. */
export function sampleBands(): { bass: number; mid: number; treble: number } {
  if (!analyser) return { bass: 0, mid: 0, treble: 0 };
  analyser.getByteFrequencyData(bandBuf);
  const hzPerBin = analyser.context.sampleRate / 2 / bandBuf.length;
  const avg = (loHz: number, hiHz: number) => {
    const lo = Math.max(0, Math.floor(loHz / hzPerBin));
    const hi = Math.min(bandBuf.length, Math.ceil(hiHz / hzPerBin));
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += bandBuf[i];
    return hi > lo ? sum / (hi - lo) / 255 : 0;
  };
  return { bass: avg(20, 200), mid: avg(200, 2000), treble: avg(2000, 8000) };
}
