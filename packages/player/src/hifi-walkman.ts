// The portrait chassis: a personal stereo, with the same cassette stood on its short edge.
//
// A separates stack is the wrong object for a tall pane; a personal stereo is the object
// that IS this shape — built around one cassette standing upright, because that is the
// smallest box a cassette fits in. So the cassette gets a quarter turn and nearly the whole
// pane: 100.5mm of tape shell in a body about 113mm tall, the label reading sideways.
//
// Everything is drawn from hifi-parts, so this is the same cassette as the deck's, not a
// second drawing of one that will drift.

import { type DeckState, reelState } from "./cassette";
import {
  BAY,
  brushed,
  CASS_ASPECT,
  drawMechanism,
  drawReels,
  drawTransport,
  type HifiButton,
  type HifiButtonId,
  INK,
  label,
  paintCassette,
  paintPressed,
  type Rect,
  rr,
} from "./hifi-parts";

export type WalkmanLayout = {
  /** The whole object, front face plus the side band. */
  body: Rect;
  /** The front plate — everything printed or mounted on the front is laid out in here, not
   *  in `body`, or it sits off-centre by half the side band. */
  face: Rect;
  /** The clear door over the cassette well. */
  well: Rect;
  /**
   * The cassette, in its OWN landscape coordinates — the space `cassTurn` maps into.
   *
   * Kept unrotated because every part of the cassette drawing works in a landscape rect and
   * expects `w > h`. The transform is applied around it instead, which means the deck and
   * the walkman hand `paintCassette` and `drawReels` exactly the same shape.
   */
  cass: Rect;
  /** Where the VFD canvas is parked, in CSS pixels. */
  glass: Rect;
  /** The machine's right-hand SIDE, running the full height in its own finish — bare metal
   *  against the painted front, as on the real thing. The transport buttons are mounted on
   *  it, which is why none of them are on the face. Decoration: from the front you are
   *  looking along that side, not at it. */
  sideKeys: Rect;
  /** The HOLD switch — drawn per frame, because it slides when you throw it. */
  hold: Rect;
  buttons: HifiButton[];
};

/**
 * The body's proportions. Driven by the cassette, not chosen: a shell is 100.5mm long, it
 * stands upright behind the lid, and the display strip has to go somewhere under it.
 * 92 × 140 is what that adds up to, and it puts the door at nearly three-quarters of the
 * front — which is what a personal stereo looked like, because the door is where the tape is.
 */
export const BODY_ASPECT = 92 / 140;

/**
 * Apply the quarter turn that stands the cassette on its short edge, run `fn`, and put the
 * canvas back.
 *
 * Anticlockwise: the cassette's RIGHT edge goes to the top, which puts the label down the
 * left of the lid and the reels down the right, with the full pack at the bottom at the head
 * of a side. That is the way round a tape sits in one of these — you load it label-out with
 * the open edge downward, into the mechanism.
 */
function turnedCassette(ctx: CanvasRenderingContext2D, l: WalkmanLayout, fn: (c: Rect) => void) {
  ctx.save();
  // Rotate about the well's centre, then hand `fn` a landscape rect centred on the origin.
  ctx.translate(l.well.x + l.well.w / 2, l.well.y + l.well.h / 2);
  ctx.rotate(-Math.PI / 2);
  fn({ x: -l.cass.w / 2, y: -l.cass.h / 2, w: l.cass.w, h: l.cass.h });
  ctx.restore();
}

export function layoutWalkman(w: number, h: number): WalkmanLayout {
  const pad = Math.max(6, Math.min(w, h) * 0.045);
  const availW = Math.max(1, w - pad * 2);
  const availH = Math.max(1, h - pad * 2);

  // The body keeps its proportions and centres — a personal stereo that has been stretched
  // to fill a pane is a slab, not an object.
  let bw = availW;
  let bh = bw / BODY_ASPECT;
  if (bh > availH) {
    bh = availH;
    bw = bh * BODY_ASPECT;
  }
  const body: Rect = { x: pad + (availW - bw) / 2, y: pad + (availH - bh) / 2, w: bw, h: bh };

  // The side band, and the front plate that is left. These machines were two materials: a
  // painted front and a bare metal side carrying the transport — which is why the front
  // carries no buttons. A sliver, not a panel: looking down at the top of the machine you
  // see its side wall recede, not present itself.
  const sideW = body.w * 0.035;
  const sideKeys: Rect = { x: body.x + body.w - sideW, y: body.y, w: sideW, h: body.h };
  const face: Rect = { x: body.x, y: body.y, w: body.w - sideW, h: body.h };

  // The lid is sized FROM the cassette, the way the deck's well is: a door is a door-sized
  // hole. Turned, the cassette's LENGTH runs down the lid and its HEIGHT across it, so the
  // lid comes out about three-quarters of the body's width. A band across the top belongs
  // to the HOLD switch, the way the deck reserves one for its model name.
  const headBand = face.h * 0.055;
  const lidW = face.w * 0.86;
  const lidH = face.h * 0.72;
  const cassLen = Math.min(lidH * 0.96, lidW * 0.96 * CASS_ASPECT);
  const cass: Rect = { x: 0, y: 0, w: cassLen, h: cassLen / CASS_ASPECT };
  const clear = cass.h * 0.045;
  const wellW = cass.h + clear * 2;
  const wellH = cassLen + clear * 2;
  const well: Rect = {
    x: face.x + (face.w - wellW) / 2,
    y: face.y + headBand,
    w: wellW,
    h: wellH,
  };
  /** The chamfer around an opening. Both the door and the display sit in one of these, and
   *  they have to be the same or the two recesses read as two different depths of moulding. */
  const lip = Math.max(2, well.w * 0.02);

  // A single strip of display under the door — a personal stereo had room for one line, and
  // the mini plate declared in vfd-face.ts is that line. It runs out to an even margin off
  // the face's own edges: the same gap left, right, below, and between it and the door.
  //
  // Capped at the mini plate's own 5.2:1, and centred in the band if the cap bites — wider
  // letterboxes the plate INSIDE the strip, which reads as a display that isn't working.
  const m = face.w * 0.045;
  const bandTop = well.y + well.h + lip + m;
  const bandBottom = face.y + face.h - m;
  const glassW = face.w - (m + lip) * 2;
  const glassH = Math.min(bandBottom - bandTop - lip * 2, glassW / 5.2);
  const glass: Rect = {
    x: face.x + m + lip,
    y: bandTop + lip + (bandBottom - bandTop - lip * 2 - glassH) / 2,
    w: glassW,
    h: Math.max(1, glassH),
  };

  // HOLD: on the real thing it locked the transport against pocket presses; here it locks
  // the one gesture this face has — pressing the plate to change what the display shows —
  // which on a phone, where the viz pane is touched by accident, is the same protection.
  const holdW = face.w * 0.17;
  const holdH = Math.max(6, face.h * 0.026);
  const hold: Rect = {
    x: face.x + face.w * 0.85 - holdW,
    // Centred between the face's top edge and the door's RECESS (its opening plus the
    // chamfer), so the switch sits an equal distance from both.
    y: face.y + (well.y - lip - face.y - holdH) / 2,
    w: holdW,
    h: holdH,
  };

  const buttons: HifiButton[] = [
    // The display itself is the button. There is no cap to press because pressing the plate
    // IS the press — and this rect being a real <button> over the glass is what keeps that
    // reachable from a keyboard, which a pointerdown handler on a canvas is not.
    { id: "display", rect: { ...glass }, label: "Change what the display shows" },
    { id: "hold", rect: hold, label: "Hold — lock the display" },
    // The lid latch, at the foot of the door where a thumb reaches it.
    {
      id: "eject",
      rect: {
        x: well.x + well.w * 0.36,
        y: well.y + well.h * 0.945,
        w: well.w * 0.28,
        h: well.h * 0.07,
      },
      label: "Eject",
    },
  ];

  return { body, face, well, cass, glass, sideKeys, hold, buttons };
}

/** The parts that never change: the body, its mouldings, the silkscreen and the key caps. */
export function paintWalkmanStill(
  g: CanvasRenderingContext2D,
  l: WalkmanLayout,
  w: number,
  h: number,
) {
  const { face, well, glass, buttons } = l;

  const room = g.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.5, Math.max(w, h) * 0.75);
  room.addColorStop(0, INK.roomHi);
  room.addColorStop(1, INK.room);
  g.fillStyle = room;
  g.fillRect(0, 0, w, h);

  // The machine, in the order you actually see it: the side wall behind, the transport
  // mounted THROUGH that wall, and the top panel laid over both. The buttons are drawn
  // BEFORE the top panel so its edge cuts them off — a profile peeking over the edge is all
  // you can see of a control mounted on the side of something you are looking down at.
  const side = l.sideKeys;
  const r = Math.max(3, face.w * 0.05);

  // Nothing is drawn behind them: looking down past the top's edge there is the button and
  // then the room. The buttons run well under where the panel will land, so only their
  // outer ends survive the occlusion.
  for (let i = 0; i < 4; i++) {
    const kh = side.h * 0.05;
    const ky = side.y + side.h * 0.32 + i * kh * 2.2;
    const kg = g.createLinearGradient(0, ky, 0, ky + kh);
    kg.addColorStop(0, INK.keyTop);
    kg.addColorStop(1, INK.keyBot);
    g.fillStyle = kg;
    // Square, not rounded: a button seen from the side is a slab with a flat top and two
    // corners; rounding them turns the profile back into a face-on pill.
    const kx = side.x - side.w * 1.2;
    const kw = side.w * 2.2;
    g.fillRect(kx, ky, kw, kh);
    g.strokeStyle = INK.edgeLo;
    g.lineWidth = 1;
    g.strokeRect(kx + 0.5, ky + 0.5, kw - 1, kh - 1);
  }

  // …and the top panel over the lot of them.
  rr(g, face.x, face.y, face.w, face.h, r);
  g.save();
  g.clip();
  brushed(g, face, INK.face, INK.faceLo);
  g.restore();
  g.strokeStyle = INK.edgeLo;
  g.lineWidth = 1;
  rr(g, face.x + 0.5, face.y + 0.5, face.w - 1, face.h - 1, r);
  g.stroke();
  // The panel's own lit top edge, so it reads as a plate lying on top rather than a hole.
  g.fillStyle = INK.edgeHi;
  g.fillRect(face.x + r, face.y + 1, face.w - r * 2, 1);

  // The two openings in the top plate, cut the same way: each is its rect chamfered outward
  // by one `lip`. Same helper for both, because the moment they are computed separately they
  // start to look like two different depths of moulding on one piece of metal.
  const lip = Math.max(2, well.w * 0.02);
  const recess = (r0: Rect, fill: string) => {
    g.fillStyle = fill;
    rr(g, r0.x - lip, r0.y - lip, r0.w + lip * 2, r0.h + lip * 2, lip);
    g.fill();
    g.strokeStyle = INK.edgeLo;
    g.lineWidth = 1;
    g.stroke();
    g.strokeStyle = INK.edgeHi;
    rr(g, r0.x - lip + 0.5, r0.y - lip + 0.5, r0.w + lip * 2 - 1, r0.h + lip * 2 - 1, lip);
    g.stroke();
  };
  // The lid's. The door itself is drawn per frame, since it opens.
  recess(well, INK.recess);
  // The display's — darker, because what is behind it is a tube and not a hole.
  recess(glass, INK.glassWell);

  // HOLD's track and its legend. The slider itself moves, so it is drawn per frame.
  const hd = l.hold;
  g.fillStyle = INK.recess;
  rr(g, hd.x, hd.y, hd.w, hd.h, hd.h / 2);
  g.fill();
  g.strokeStyle = INK.edgeLo;
  g.lineWidth = 1;
  g.stroke();
  label(
    g,
    "HOLD",
    hd.x - Math.max(3, face.w * 0.015),
    hd.y + hd.h / 2,
    Math.max(4, face.w * 0.028),
    INK.printDim,
    "right",
  );
}

/** The parts that move: the tape behind the lid, the lid itself, and the play lamp. */
export function drawWalkmanFrame(
  ctx: CanvasRenderingContext2D,
  l: WalkmanLayout,
  tape: HTMLCanvasElement,
  W: number,
  H: number,
  input: {
    deck: DeckState;
    playing: boolean;
    paused: boolean;
    pressed: HifiButtonId | null;
    /** HOLD thrown — locks the press-the-plate gesture. */
    hold: boolean;
    /** Whether there is a cassette in the well at all. */
    loaded: boolean;
  },
) {
  const { body, well, buttons } = l;

  const open = input.deck.door;
  const lip = Math.max(2, well.w * 0.02);
  // The lid is the whole top plate above the display strip, not a frame around the window:
  // on these machines the window is a hole in the top, and the top is what lifts.
  const lid: Rect = {
    x: l.face.x + l.face.w * 0.04,
    y: well.y - lip,
    w: l.face.w * 0.92,
    h: well.h + lip * 2,
  };

  // The bay, seen when the lid is up.
  //
  // Clipped to the LID's footprint rather than the window's, because with the top open there
  // is no window — the whole opening is bay. The mechanism is drawn in the cassette's own
  // coordinates so the spindles land exactly where the hubs will sit.
  ctx.save();
  rr(ctx, lid.x, lid.y, lid.w, lid.h, lip * 1.6);
  ctx.clip();
  ctx.fillStyle = INK.wellFloor;
  ctx.fillRect(lid.x, lid.y, lid.w, lid.h);
  turnedCassette(ctx, l, (c) => drawMechanism(ctx, c));
  // The tape lifts out at the top of the travel; below that it is still in and the reels
  // still turn. With the tape OUT the bay stays empty however far the lid has travelled —
  // `loaded` is a state the player itself does not have (a track selected but not in the
  // machine), so it can only come from here.
  if (input.loaded && open < 0.88) {
    turnedCassette(ctx, l, (c) => {
      drawReels(ctx, c, input.deck, reelState(input.deck.frac));
      // The same transport as the deck's, in the same place on the same cassette — the
      // quarter turn is the only difference, and `turnedCassette` has already applied it.
      // Its bay is the clearance the lid leaves below the shell's bottom edge, expressed
      // here in the cassette's own frame so the two machines cannot drift apart.
      const bay = c.h * BAY;
      drawTransport(ctx, c, c.y + c.h + bay, bay, input.deck.engage);
    });
    ctx.drawImage(tape, 0, 0, W, H);
  }
  ctx.restore();

  // The lid itself, hinged along its LEFT edge. Which edge matters: the view is from above,
  // looking down at the machine lying flat, and the top plate swings up and over to the
  // left on two hinges — so it foreshortens ACROSS, not down, and the bay is uncovered from
  // the right.
  const cos = Math.cos(open * 1.34);
  ctx.save();
  ctx.translate(lid.x, 0);
  ctx.scale(Math.max(0.001, cos), 1);
  ctx.translate(-lid.x, 0);

  // The lid's own metal, with the window CUT OUT of it (two subpaths, an even-odd fill)
  // rather than painted over — a translucent tint on top of a filled lid would tint the
  // metal and lose the tape behind it.
  const winR = Math.max(2, well.w * 0.02);
  const ring = (x: number, y: number, w: number, h: number, r: number) => {
    const k = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.moveTo(x + k, y);
    ctx.arcTo(x + w, y, x + w, y + h, k);
    ctx.arcTo(x + w, y + h, x, y + h, k);
    ctx.arcTo(x, y + h, x, y, k);
    ctx.arcTo(x, y, x + w, y, k);
    ctx.closePath();
  };
  ctx.beginPath();
  ring(lid.x, lid.y, lid.w, lid.h, lip * 1.6);
  ring(well.x, well.y, well.w, well.h, winR);
  ctx.fillStyle = INK.face;
  ctx.fill("evenodd");
  ctx.strokeStyle = INK.edgeLo;
  ctx.lineWidth = 1;
  ctx.stroke();

  // …and the smoked acrylic glazed into that hole.
  const dg = ctx.createLinearGradient(0, well.y, 0, well.y + well.h);
  dg.addColorStop(0, INK.doorTop);
  dg.addColorStop(0.55, INK.doorMid);
  dg.addColorStop(1, INK.doorBot);
  ctx.fillStyle = dg;
  rr(ctx, well.x, well.y, well.w, well.h, winR);
  ctx.fill();
  ctx.strokeStyle = INK.edgeLo;
  ctx.stroke();
  const sg = ctx.createLinearGradient(well.x, well.y, well.x + well.w * 0.8, well.y + well.h);
  sg.addColorStop(0, "rgba(255,255,255,0)");
  sg.addColorStop(0.42, "rgba(200,225,255,0.09)");
  sg.addColorStop(0.52, "rgba(200,225,255,0.02)");
  sg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sg;
  rr(ctx, well.x, well.y, well.w, well.h, winR);
  ctx.fill();
  ctx.fillStyle = INK.edgeHi;
  ctx.fillRect(lid.x + lip, lid.y + 1, lid.w - lip * 2, 1);
  ctx.restore();

  // The hinges down the left edge. Drawn always — two barrels screwed to the case, and a
  // shut lid still has them.
  const hingeW = Math.max(1.5, lid.w * 0.014);
  for (const f of [0.16, 0.84]) {
    const hy = lid.y + lid.h * f;
    const hh = lid.h * 0.11;
    const hg = ctx.createLinearGradient(lid.x - hingeW, 0, lid.x + hingeW, 0);
    hg.addColorStop(0, INK.keyBot);
    hg.addColorStop(0.5, INK.keyTop);
    hg.addColorStop(1, INK.keyMid);
    ctx.fillStyle = hg;
    rr(ctx, lid.x - hingeW, hy, hingeW * 2, hh, hingeW * 0.5);
    ctx.fill();
    ctx.strokeStyle = INK.edgeLo;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // The lid's own thickness on the swinging edge, which only exists while it is off the seat.
  if (open > 0.02) {
    const edgeX = lid.x + lid.w * cos;
    const t = Math.max(1, lid.w * 0.018);
    ctx.fillStyle = "rgba(150,170,190,0.3)";
    rr(ctx, edgeX - t, lid.y, t, lid.h, t * 0.4);
    ctx.fill();
  }

  if (input.pressed) {
    const b = buttons.find((k) => k.id === input.pressed);
    if (b && !b.inert) paintPressed(ctx, b.rect);
  }

  // HOLD's slider, thrown to one end or the other. Amber when it is on, because a lock you
  // cannot see the state of is worse than no lock.
  const hd = l.hold;
  const knobW = hd.w * 0.52;
  const kx = input.hold ? hd.x + hd.w - knobW : hd.x;
  const kg = ctx.createLinearGradient(0, hd.y, 0, hd.y + hd.h);
  kg.addColorStop(0, INK.keyTop);
  kg.addColorStop(1, INK.keyBot);
  ctx.fillStyle = kg;
  rr(ctx, kx, hd.y, knobW, hd.h, hd.h / 2);
  ctx.fill();
  ctx.strokeStyle = input.hold ? INK.trimHi : INK.edgeLo;
  ctx.lineWidth = 1;
  ctx.stroke();

  void body;
}

/** Paint the cassette's shell and label into the tape offscreen, turned. */
export function paintWalkmanTape(
  g: CanvasRenderingContext2D,
  l: WalkmanLayout,
  taped: { title: string; artist: string; side: "A" | "B"; seed: number },
) {
  turnedCassette(g, l, (c) =>
    paintCassette(g, c, taped.title, taped.artist, taped.side, taped.seed),
  );
}
