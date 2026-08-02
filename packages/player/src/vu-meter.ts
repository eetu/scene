// One analogue VU meter, drawn on a 2D canvas: a backlit amber dial face, a curved scale
// that goes red past 80%, a slim black needle and the dark bezel its pivot emerges from.
//
// Shared, because two visualisers want the same object for the same reason. The `vu`
// visualiser is a pair of these filling the pane; the hi-fi deck wears two small ones on
// its faceplate, where illuminated VU meters were the single most recognisable thing about
// a cassette deck — the reason people photographed them.
//
// The face caps itself to ASPECT and centres inside whatever box it is given, so a cell
// that is the wrong shape adds margin rather than stretching the dial. That is what lets
// the same function serve a 400px pane and a 60px faceplate inset.

/** Dial face width:height. */
const ASPECT = 1.5;
/** Needle sweep, ±72°. */
const SWEEP = Math.PI * 0.4;
const MINOR = 20;
/** Every fourth minor tick is major, and labelled. */
const MAJOR = 4;

/**
 * Draw a meter reading `level` (0..1) inside the box, labelled underneath the arc.
 *
 * `detail` scales the printed matter down for small instances: at faceplate size the
 * numbers are illegible anyway and drawing them just muddies the face, so below a
 * threshold the labels drop and only the ticks remain. The needle and the red zone are
 * what carry the reading at any size.
 */
export function drawVuMeter(
  g2: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  cw: number,
  ch: number,
  level: number,
  label: string,
) {
  const pad = Math.min(cw, ch) * 0.06;
  const availW = cw - pad * 2;
  const availH = ch - pad * 2;
  if (availW <= 0 || availH <= 0) return;
  let fw = availW;
  let fh = fw / ASPECT;
  if (fh > availH) {
    fh = availH;
    fw = fh * ASPECT;
  }
  const fx = x0 + (cw - fw) / 2;
  const fy = y0 + (ch - fh) / 2;
  const pivotX = fx + fw / 2;
  const pivotY = fy + fh * 0.92;
  const r = Math.min(fw * 0.46, fh * 0.86);
  const numbered = r > 26;

  g2.save();

  // Backlit amber face.
  const face = g2.createRadialGradient(
    pivotX,
    fy + fh * 0.35,
    fh * 0.05,
    pivotX,
    fy + fh * 0.35,
    fh * 1.1,
  );
  face.addColorStop(0, "#ffe0a4");
  face.addColorStop(0.55, "#f0a338");
  face.addColorStop(1, "#7c4214");
  g2.fillStyle = face;
  g2.beginPath();
  g2.roundRect(fx, fy, fw, fh, Math.min(fw, fh) * 0.07);
  g2.fill();

  // Scale ticks + numbers.
  g2.textAlign = "center";
  g2.textBaseline = "middle";
  const numFont = Math.max(7, r * 0.1);
  for (let i = 0; i <= MINOR; i++) {
    const f = i / MINOR;
    const ang = -Math.PI / 2 + (f - 0.5) * 2 * SWEEP;
    const major = i % MAJOR === 0;
    const red = f > 0.8;
    const r0 = r * (major ? 0.84 : 0.9);
    g2.strokeStyle = red ? "#bb2d1c" : "#3a2206";
    g2.lineWidth = major ? 2 : 1;
    g2.beginPath();
    g2.moveTo(pivotX + Math.cos(ang) * r0, pivotY + Math.sin(ang) * r0);
    g2.lineTo(pivotX + Math.cos(ang) * r, pivotY + Math.sin(ang) * r);
    g2.stroke();
    if (major && numbered) {
      g2.fillStyle = red ? "#bb2d1c" : "#42280a";
      g2.font = `${numFont}px ui-monospace, monospace`;
      g2.fillText(
        String(i * 5),
        pivotX + Math.cos(ang) * r * 0.72,
        pivotY + Math.sin(ang) * r * 0.72,
      );
    }
  }

  // Label (channel) under the arc.
  if (label) {
    g2.fillStyle = "rgba(60,34,8,0.7)";
    g2.font = `${Math.max(7, r * (numbered ? 0.13 : 0.22))}px ui-monospace, monospace`;
    g2.fillText(label, pivotX, fy + fh * 0.52);
  }

  // Needle (black) with a soft shadow.
  const ang = -Math.PI / 2 + (Math.min(1, Math.max(0, level)) - 0.5) * 2 * SWEEP;
  g2.strokeStyle = "#1a1206";
  g2.shadowColor = "rgba(0,0,0,0.35)";
  g2.shadowBlur = 3;
  g2.lineWidth = Math.max(1.5, r * 0.022);
  g2.lineCap = "round";
  g2.beginPath();
  g2.moveTo(pivotX, pivotY);
  g2.lineTo(pivotX + Math.cos(ang) * r * 0.92, pivotY + Math.sin(ang) * r * 0.92);
  g2.stroke();
  g2.shadowBlur = 0;

  // Dark bezel under the pivot — a dome sitting on a flat bottom edge (the needle emerges
  // from its top), matching the meters this is drawn from.
  const bezBottom = fy + fh;
  const bezHalf = fw * 0.34;
  g2.fillStyle = "#0e0a05";
  g2.beginPath();
  g2.moveTo(pivotX - bezHalf, bezBottom);
  g2.quadraticCurveTo(pivotX, pivotY - fh * 0.22, pivotX + bezHalf, bezBottom);
  g2.closePath();
  g2.fill();
  g2.fillStyle = "#2a1c0c";
  g2.beginPath();
  g2.arc(pivotX, pivotY, Math.max(2, r * 0.05), 0, Math.PI * 2);
  g2.fill();

  g2.restore();
}

/**
 * Meter ballistics: fast rise, slow fall.
 *
 * A real VU movement is a damped mass, so it lags going up and coasts coming down. Feeding
 * a meter the raw level makes the needle chatter, which is the one thing a moving-coil
 * instrument physically cannot do.
 */
export function vuEase(pos: number, target: number): number {
  return pos + (target - pos) * (target > pos ? 0.3 : 0.1);
}
