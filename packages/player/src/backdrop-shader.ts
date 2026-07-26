// Fragment shader for the dancer viz's backdrop: two overlapping fields of
// concentric circles, shifting in place, after the op-art Spaceballs' "State of
// the Art" (Amiga, 1992) ran behind its dancers.
//
// The effect is moiré interference. Each field on its own is just a bullseye;
// overlap two of them and the places where their rings agree and disagree form
// large rosette bands that sweep across the screen. Crucially those bands move
// far faster and further than the centres do — a couple of pixels of drift
// reads as the whole pattern surging. That's the illusion, and it's why the
// centres only shift a little.
//
// Why a shader and not CSS: a repeating radial gradient can draw one ring field,
// but the interference needs both evaluated per pixel and combined by sign.
//
// Everything is normalised by the SHORT axis, so the rings stay circular and keep
// their spacing on a narrow phone screen instead of smearing into ellipses.
export const BACKDROP_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uPulse;   // bass, 0..1
uniform vec3 uInk;      // pattern colour, from the theme
uniform vec3 uPaper;    // ground colour, from the theme

// One field of concentric rings around c: a cosine of distance, so the value
// swings between crest and trough once per ring.
float rings(vec2 p, vec2 c, float freq, float phase) {
  return sin(length(p - c) * freq + phase);
}

void main() {
  float m = min(uRes.x, uRes.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / m;

  float t = uTime;

  // The two centres sit near the middle and only shift a little — the moiré
  // amplifies the movement enormously, so a wide orbit would be a blur.
  // Separation scales with the frame's half-width. The rich interference lives
  // BETWEEN the two centres; past them the fields turn concentric and go flat. A
  // fixed gap therefore looks right in portrait but leaves a wide screen blank
  // either side, so the centres are placed as a fraction of what's visible.
  float halfW = 0.5 * uRes.x / m;
  float sep = max(0.22, halfW * 0.52);
  // Wide, slow, mutually-prime orbits. The centres wandering is what makes the
  // fringes sweep and turn rather than just breathe in place — and since the
  // moiré amplifies their motion, this is the strongest lever on the illusion.
  vec2 c1 = vec2(-sep, 0.04) + vec2(cos(t * 0.30), sin(t * 0.24)) * 0.19;
  vec2 c2 = vec2(sep, -0.04) + vec2(cos(t * 0.18 + 2.0), sin(t * 0.27 + 1.0)) * 0.22;

  // Tight ring spacing: the finer the rings, the finer and faster-moving the
  // interference fringes, which is the whole effect. Bass tightens them further.
  float freq = 62.0 + uPulse * 12.0;

  // Matched frequencies, counter-rotating phases. Equal ring spacing is what
  // gives the clean hyperbolic fringes of a true two-source interference figure;
  // detuning them muddles it into a checkerboard.
  float a = rings(p, c1, freq, -t * 1.25);
  float b = rings(p, c2, freq, t * 0.98);

  // Sign agreement between the two fields. This is the interference: hard black
  // and white, no midtones, the way a two-colour Amiga screen would do it.
  float ink = step(0.0, a * b);

  // Themed rather than pure black and white. Full-contrast mono is harsh behind a
  // figure and ignores the app's palette; these come from the theme's ground and
  // text tokens, so the backdrop turns over with light/dark.
  vec3 col = mix(uPaper, uInk, ink);

  // CRT scanlines, matching the tunnel viz. Frequency pi = a period of exactly
  // two device pixels, the thinnest a scanline can be and stay coherent; tighter
  // aliases into mush. Shallow depth so it reads as texture rather than banding.
  float scan = 0.88 + 0.12 * sin(gl_FragCoord.y * 3.14159265);
  float vig = smoothstep(0.95, 0.35, length(gl_FragCoord.xy / uRes - 0.5));
  col *= scan * (0.8 + 0.3 * vig) * 1.25;

  gl_FragColor = vec4(col, 1.0);
}
`;

export const BACKDROP_VERTEX = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
