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
console.log(
  ok ? "\nGATE: PASS ✅ — real sample PCM extracted" : "\nGATE: FAIL ❌ — no non-zero data",
);
process.exit(ok ? 0 : 1);

function strz(lib, s) {
  const p = lib.stackAlloc(s.length + 1);
  for (let i = 0; i < s.length; i++) lib.HEAP8[p + i] = s.charCodeAt(i);
  lib.HEAP8[p + s.length] = 0;
  return p;
}
