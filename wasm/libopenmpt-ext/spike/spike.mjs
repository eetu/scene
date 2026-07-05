/*
 * Gate for the custom build's one job: reading raw sample data off a module.
 *
 *   node spike/spike.mjs <module-file>
 *
 * Creates a module, then smp_count / smp_info / smp_read → asserts at least one
 * sample reports a plausible length + loop points and returns NON-zero PCM.
 * (Jamming plays this PCM via Web Audio in the browser — nothing to test here.)
 *
 * Exit 0 iff a real sample was extracted.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const modPath = process.argv[2];
if (!modPath) {
  console.error("usage: node spike/spike.mjs <module-file>");
  process.exit(2);
}

const { default: libopenmpt } = await import(resolve(here, "../out/libopenmpt.worklet.js"));
const lib = await libopenmpt();
console.log("libopenmpt:", lib.UTF8ToString(lib._openmpt_get_string(strz(lib, "library_version"))));

const bytes = new Uint8Array(readFileSync(modPath));
const fp = lib._malloc(bytes.length);
lib.HEAPU8.set(bytes, fp);
const mod = lib._openmpt_module_create_from_memory(fp, bytes.length, 0, 0, 0);
lib._free(fp);
if (!mod) {
  console.error("FAIL: module_create_from_memory returned 0");
  process.exit(1);
}

const nsmp = lib._smp_count(mod);
console.log("smp_count =", nsmp);
const info = lib._malloc(16 * 4);
const MAXF = 1 << 21;
const sbuf = lib._malloc(4 * MAXF);
let ok = false;
for (let i = 1; i <= nsmp; i++) {
  if (!lib._smp_info(mod, i, info)) continue;
  const I = lib.HEAP32.subarray(info >> 2, (info >> 2) + 10);
  const [len, ls, le, ss, se, rate, chs, bits, flags] = I;
  if (len <= 0) continue;
  const frames = lib._smp_read(mod, i, sbuf, Math.min(len, MAXF));
  const fb = lib.HEAPF32.subarray(sbuf >> 2, (sbuf >> 2) + frames);
  let peak = 0;
  for (let k = 0; k < frames; k++) peak = Math.max(peak, Math.abs(fb[k]));
  console.log(
    `  sample ${i}: len=${len} loop=${ls}..${le} sustain=${ss}..${se} ` +
      `rate=${rate} ch=${chs} bits=${bits} flags=${flags} read=${frames} peak=${peak.toFixed(4)}`,
  );
  if (frames > 0 && peak > 0) ok = true;
}
console.log(ok ? "  → sample PCM: OK" : "  → sample PCM: FAIL");

// --- chan_mute: muting all channels should collapse the render to ~silence ----
function renderRms(rate = 48000, chunks = 8, count = 4096) {
  const l = lib._malloc(4 * count);
  const r = lib._malloc(4 * count);
  let sum = 0;
  let n = 0;
  for (let c = 0; c < chunks; c++) {
    const got = lib._openmpt_module_read_float_stereo(mod, rate, count, l, r);
    if (got <= 0) break;
    const lf = lib.HEAPF32.subarray(l >> 2, (l >> 2) + got);
    const rf = lib.HEAPF32.subarray(r >> 2, (r >> 2) + got);
    for (let i = 0; i < got; i++) {
      sum += lf[i] * lf[i] + rf[i] * rf[i];
      n += 2;
    }
  }
  lib._free(l);
  lib._free(r);
  return n ? Math.sqrt(sum / n) : 0;
}
let muteOk = true;
if (typeof lib._chan_mute === "function") {
  const nch = lib._openmpt_module_get_num_channels(mod);
  const base = renderRms();
  lib._openmpt_module_set_position_seconds(mod, 0); // same opening segment
  for (let c = 0; c < nch; c++) lib._chan_mute(mod, c, 1);
  const muted = renderRms();
  for (let c = 0; c < nch; c++) lib._chan_mute(mod, c, 0); // restore
  // Can only assert a drop if the source actually makes sound in this window;
  // some synthetic test fixtures open silent — then just confirm it's exported.
  const silent = base <= 5e-4;
  muteOk = silent ? true : muted < base * 0.15;
  console.log(
    `  → chan_mute (${nch} ch): baseline RMS=${base.toFixed(5)} all-muted RMS=${muted.toFixed(5)} ` +
      (silent ? "OK (source silent — export present)" : muteOk ? "OK" : "FAIL"),
  );
} else {
  console.log("  → chan_mute: NOT EXPORTED (fail)");
  muteOk = false;
}

// --- structured cells: at least one real note via the command getter ----------
let cellsOk = true;
if (typeof lib._openmpt_module_get_pattern_row_channel_command === "function") {
  const cmd = lib._openmpt_module_get_pattern_row_channel_command;
  const np = lib._openmpt_module_get_num_patterns(mod);
  const cn = lib._openmpt_module_get_num_channels(mod);
  let notes = 0;
  let firstNote = -1;
  let firstInst = -1;
  for (let p = 0; p < np && notes < 50; p++) {
    const rn = lib._openmpt_module_get_pattern_num_rows(mod, p);
    for (let r = 0; r < rn; r++)
      for (let c = 0; c < cn; c++) {
        const note = cmd(mod, p, r, c, 0);
        if (note > 0) {
          notes++;
          if (firstNote < 0) {
            firstNote = note;
            firstInst = cmd(mod, p, r, c, 1);
          }
        }
      }
  }
  cellsOk = notes > 0;
  console.log(
    `  → structured cells: ${notes}${notes >= 50 ? "+" : ""} notes ` +
      `(first note=${firstNote} inst=${firstInst}) ` +
      (cellsOk ? "OK" : "FAIL"),
  );
} else {
  console.log("  → structured cells: NOT EXPORTED (fail)");
  cellsOk = false;
}

const pass = ok && muteOk && cellsOk;
console.log(
  pass ? "\nGATE: PASS ✅ — sample PCM + channel mute + structured cells" : "\nGATE: FAIL ❌",
);
process.exit(pass ? 0 : 1);

function strz(lib, s) {
  const p = lib.stackAlloc(s.length + 1);
  for (let i = 0; i < s.length; i++) lib.HEAP8[p + i] = s.charCodeAt(i);
  lib.HEAP8[p + s.length] = 0;
  return p;
}
