#!/usr/bin/env python3
"""
blender-chassis-silhouette.py — Fleet Console chassis model (round 3)

Builds public/models/chassis-silhouette.glb from scratch in Blender (headless),
replacing the retired parametric Node generator. ORIGINAL stylized humanoid,
modeled from generic consumer home-robot proportions — design language only,
no third-party imagery or geometry anywhere near this file.

  Run:    /Applications/Blender.app/Contents/MacOS/Blender \
              --background --factory-startup \
              --python scripts/blender-chassis-silhouette.py
  Args:   ... --python scripts/blender-chassis-silhouette.py -- \
              [--out <path.glb>] [--render <dir>] [--no-export]
  Check:  node scripts/verify-chassis-silhouette.mjs
          node scripts/extract-wireframe.mjs

Contract ( /):
  - EIGHT mesh objects, exact names, siblings under an empty "chassis_silhouette":
      head, torso, arm_L, arm_R, leg_L, leg_R, knee_actuator_L, knee_actuator_R
  - knee actuators are separable band modules; object origins at joint centers
  - robot faces -Y in Blender == +Z in glTF (+Y-up export, Blender default);
    _L = robot's anatomical left = +X; ground z=0 (glTF y=0); ~1.61 m tall
    (r3.1 taste gate: short collar + dropped head traded a few cm of height
    for the refs' nesting — verify's 1.6 m floor still holds)
  - exactly 3 matte materials (names kept from rounds 1-2, roles per round 3):
      shell        warm knit-cream  — the suit, head cowl, slip-on shoes
      joint_accent dark grey-brown  — gloves, soles, ear rings, eye dots,
                                      knee wraps
      face_ring    subtle face tone — the near-flush face plane (NOT dark;
                                      round-3 note: no diving-helmet dish)
  - triangle budget sane (< 15k verify contract; QA band below); GLB well
    under 500 KB; no textures, no draco, no animations, no skins

Round 3 (taste gate: the round-2 model read "crash-test dummy")
---------------------------------------------------------------
  HEAD      egg cowl fuller at the BACK (two elliptical arcs sharing the
            widest ring), no dark dish: the face is a shallow watch-glass
            dome behind one deliberate boundary crease, in a subtle tone.
            Two small dark eye discs. Signature thin ear RING on each side:
            flat washer solids sunk into the cowl, extracting as clean
            concentric ellipses at side yaws. A crown HOOP seam at the
            widest latitude — a CLOSED ring, so nothing floats (the round-2
            crown-arc lesson) — draws the cranium outline at yaw 0 and the
            panel seam over the crown at yaw 90, as in the colorway refs.
  SHOULDER  (r3.1) the head nests LOW in a SHORT, wide collar (round-2
            shadow-groove relationship), and the trapezius bell stays narrow
            beside the neck so the deltoid ball — crown at ~82% of stature,
            like a human acromion — rises proud of it and owns the shoulder;
            the yoke seam ring rides the raglan crease where it emerges.
            Arm tops close with smooth POLE DOMES — zero cap rims. Two
            shallow ribbing grooves on the deltoid (the hero closeup's
            concentric knit rings); the lower groove is where the arm's
            contour meridians begin, so their upper ends terminate flush on
            an extracted ellipse.
  TORSO     slimmer + longer; ONE curved chest/abdomen garment seam — a
            grooved ring with a per-station Z-WARP that dips at the front
            (rounded U); a center-BACK zip meridian terminating flush at
            the collar rim and the pelvic rim; a fainter center-front seam.
  ARMS      slimmer, soft elbows (no elbow groove); fingerless mitts in the
            dark accent = articulated gloves, glove-cuff seam at the wrist,
            knuckle crease kept.
  LEGS      longer/slimmer (~1:7.4 head:height); knee modules restyled from
            mech bands to low-profile padded wraps — eased entry/exit, only
            a few mm proud, still 16 segments so the walls extract as the
            one deliberately ribbed patch; trouser cuff flares over the shoe.
  FEET      light rounded slip-ons in shell tone with a dark sole line
            (welt crease + material split), replacing the dark boots.

Wireframe-first topology
------------------------
This mesh's second life is machine space's phosphor line drawing:
scripts/extract-wireframe.mjs selects boundary edges plus crease edges above
a ~17 deg dihedral. So the topology is engineered around that threshold:

  - every part is a loft of elliptical rings sampled at N=24 azimuthal steps
    by EQUAL NORMAL ANGLE, which caps the wall dihedral across vertical edges
    at 360/24 = 15 deg regardless of ring eccentricity -> smooth surfaces
    stay silent (no tessellation noise);
  - profile stations are spaced so slope changes stay <= ~14 deg in smooth
    regions, and deliberate panel lines are hard slope breaks / grooves of
    >= ~22 deg exactly where a garment maker would sew them: crown hoop,
    face boundary, ear rings, eye rims, collar rim + collar base, deltoid
    ribbing, chest seam, back zip + front seam meridians, glove cuff,
    knuckle line, pelvic rim, knee-wrap edges, trouser hem, shoe welt/sole;
  - meridian pulls (2%) fold one clean garment seam into a wall; every
    meridian TERMINATES on an extracted ring or a pole (nothing floats):
    arm meridians start at the lower deltoid ribbing groove and end at the
    mitt tip pole; torso meridians run collar rim -> pelvic rim; leg/shoe
    meridians run into rings hidden inside neighboring parts;
  - the knee wraps alone run 16 segments so their 22.5 deg walls DO extract:
    the serviceable module renders as a ribbed pad against the quiet limbs.

QA below asserts the tri budget, the height, the seam/quiet dihedral split
(no profile turn inside the ambiguous 14.5-21.5 deg band), and the eight-node
contract before anything is exported.
"""

import math
import os
import sys

import bmesh
import bpy

# --------------------------------------------------------------- constants

N = 24                      # azimuthal segments (wall dihedral = 15 deg)
N_KNEE = 16                 # knee wrap: 22.5 deg walls, extracted on purpose
N_RING = 20                 # ear-ring washers
N_EYE = 10                  # eye discs

# Ring adjustments: {ring index: radial factor}. Pulls (<1) fold one clean
# garment-seam crease into the wall; pushes (>1) raise a soft ridge.
# Index 0 = +X; N/4 = +Y (robot's BACK); 3N/4 = -Y (front).
K_BACK = N // 4
K_FRONT = 3 * N // 4
SEAMS = {0: 0.98, K_BACK: 0.98, N // 2: 0.98, K_FRONT: 0.98}
# Torso meridians need deeper pulls than the limbs: its rings are flatter
# ellipses (ry = 0.74 rx), and at the +-Y apexes the equal-normal-angle
# chords stretch, so a 2% pull would sit right at the 17 deg extraction
# threshold and draw a patchy line (round-3 lesson, first build).
TORSO_ADJUST = {K_BACK: 0.972, K_FRONT: 0.980}   # zip (strong) + front (faint)
MITT_ADJUST = dict(SEAMS)
MITT_ADJUST[K_FRONT] = 1.12      # thumb ridge along the mitt front (-Y)
# Deltoid dome meridians (r3.2): on the ball's circular rings a 2% pull
# computes to ~17.5 deg of crease — dead on the extraction threshold, so the
# arcs came out patchy. 2.8% (the torso-zip depth, same lesson) lands ~24 deg
# and the shoulder outline extracts whole.
DOME_ADJUST = {0: 0.972, K_BACK: 0.972, N // 2: 0.972, K_FRONT: 0.972}
# The shoe lofts at N_SHOE like the knee wraps (r3.2): its rings are the
# model's most eccentric (ry up to ~2.3x rx), so at the +-X apexes the
# equal-normal-angle chords stretch and NO sane radial pull reaches the
# threshold — reaching 17 deg there would take an ~8 mm dent. With no side
# outline the front view was a hem bar over a centre seam: a music stand,
# not a foot (user report, 2026-08-31). At 22.5 deg walls the whole little
# solid extracts and the luminance tiers shape it the way they shape a limb:
# grazing side walls burn as contour, the centre recedes.
N_SHOE = 16

QUIET_MAX = 14.5            # profile turns below this stay un-extracted
SEAM_MIN = 21.5             # deliberate turns must exceed this
TRI_MIN, TRI_MAX = 5000, 9500

GLTF_COPYRIGHT = (
    "Fleet Console demo. Original stylized asset, inspired by consumer "
    "humanoid robots. All geometry modeled from scratch."
)

# ------------------------------------------------------------------ colors

def srgb_to_linear(hexcode):
    out = []
    for i in (0, 2, 4):
        s = int(hexcode[1 + i:3 + i], 16) / 255.0
        out.append(s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4)
    return out

MATERIAL_SPECS = [
    ("shell", "#E6E0D3", 0.92),        # warm knit-cream suit + shoes
    ("joint_accent", "#4A423A", 0.80), # espresso: gloves, soles, ears, knees
    ("face_ring", "#CFC8B9", 0.65),    # near-flush face plane (subtle tone)
]

# ------------------------------------------------------- ring / loft math

def ellipse_ring(rx, ry, n, adjust=None):
    """2D ellipse sampled at n EQUAL NORMAL-ANGLE steps (index 0 at +axis1).

    Equal normal angles make consecutive edge directions rotate by exactly
    360/n, so wall dihedrals never exceed 360/n even on eccentric rings.
    `adjust` maps ring indices to radial factors: <1 folds one deliberate
    seam crease into the wall, >1 raises a soft ridge (the thumb line).
    """
    pts = []
    for k in range(n):
        psi = 2.0 * math.pi * k / n
        t = math.atan2(ry * math.sin(psi), rx * math.cos(psi))
        u, v = rx * math.cos(t), ry * math.sin(t)
        f = adjust.get(k) if adjust else None
        if f is not None:
            u *= f
            v *= f
        pts.append((u, v))
    return pts


class Loft:
    """Accumulates rings (each n verts) then emits a closed solid.

    Ring order defines the loft direction; ends are closed with a center
    fan ('cap' = flat, rim reads as a crease ring) or a 'pole' vertex
    (fan center pushed out along the loft axis = smooth dome, NO rim).
    Face material indices are tracked per band so one mesh can carry two
    of the three materials (face plane, glove, sole).
    """

    def __init__(self, n):
        self.n = n
        self.verts = []
        self.rings = []          # list of vertex-index lists
        self.faces = []
        self.face_mats = []

    def ring(self, pts3d):
        base = len(self.verts)
        self.verts.extend(pts3d)
        self.rings.append(list(range(base, base + self.n)))
        return len(self.rings) - 1

    def bridge(self, a, b, mat=0):
        """Quad-bridge ring a -> ring b (used to close washer loops)."""
        n = self.n
        ra, rb = self.rings[a], self.rings[b]
        for k in range(n):
            p, q = ra[k], ra[(k + 1) % n]
            r, s = rb[(k + 1) % n], rb[k]
            self.faces.append((p, q, r))
            self.face_mats.append(mat)
            self.faces.append((p, r, s))
            self.face_mats.append(mat)

    def bridge_all(self, mat=0, band_mats=None):
        """Quad-bridge consecutive rings; band_mats maps band idx -> material."""
        for b in range(len(self.rings) - 1):
            m = band_mats.get(b, mat) if band_mats else mat
            self.bridge(b, b + 1, m)

    def close(self, ring_idx, center, mat=0):
        """Fan-close a ring to a center point (flat cap or rounded pole)."""
        ci = len(self.verts)
        self.verts.append(center)
        ring = self.rings[ring_idx]
        for k in range(self.n):
            self.faces.append((ring[k], ring[(k + 1) % self.n], ci))
            self.face_mats.append(mat)


def merge_lofts(lofts):
    verts, faces, mats = [], [], []
    for lf in lofts:
        off = len(verts)
        verts.extend(lf.verts)
        faces.extend([tuple(i + off for i in f) for f in lf.faces])
        mats.extend(lf.face_mats)
    return verts, faces, mats

# ----------------------------------------------------------- profile QA

def profile_turns(pts):
    """Turn angle (deg) at each interior station of a 2D polyline."""
    turns = []
    for i in range(1, len(pts) - 1):
        ax, ay = pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]
        bx, by = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        la, lb = math.hypot(ax, ay), math.hypot(bx, by)
        if la < 1e-9 or lb < 1e-9:
            turns.append(0.0)
            continue
        d = max(-1.0, min(1.0, (ax * bx + ay * by) / (la * lb)))
        turns.append(math.degrees(math.acos(d)))
    return turns


QA_FAILURES = []

def check_profile(name, pts, hidden=()):
    """Assert no profile turn falls in the ambiguous band around the 17 deg
    extraction threshold. `hidden` = station indices (of the turn's center
    station) that sit inside another part and may be sloppy."""
    for i, turn in enumerate(profile_turns(pts), start=1):
        if i in hidden:
            continue
        if QUIET_MAX < turn < SEAM_MIN:
            QA_FAILURES.append(
                f"{name}: turn {turn:.1f} deg at station {i} "
                f"(u~{pts[i][0]:.4f}) inside dead zone "
                f"[{QUIET_MAX}, {SEAM_MIN}]"
            )

# -------------------------------------------------------------- profiles
# All numbers meters, world space, Blender Z-up, robot faces -Y, _L = +X.
# Total height ~1.652 m; head:height ~1:7.4 (athletic, per the refs).

# ---- head -----------------------------------------------------------------
# Revolution about +Y through HEAD_CENTER; rings are vertical ellipses
# (rho, rho * HEAD_ZSCALE) so the ovoid is taller than wide. The profile in
# (y, rho) is an EGG: back arc and front arc are ellipse quadrants sharing
# the widest ring at y = HEAD_Y0 (back semi-axis shorter -> fuller back).
HEAD_CENTER = (0.0, 0.0, 1.5060)
HEAD_ZSCALE = 1.16
HEAD_RHO = 0.0960             # widest x-radius -> head width 0.192
HEAD_Y0 = 0.0200              # widest ring sits behind the y=0 plane
HEAD_BACK_B = 0.0920          # back semi-axis  (pole at y = +0.112)
HEAD_FRONT_B = 0.1240         # front semi-axis (virtual pole y = -0.104)
HEAD_FACE_T = 44.9            # front-arc angle of the face boundary crease
HEAD_HOOP_PULL = 0.972        # crown hoop groove depth (closed ring seam)
HEAD_HOOP_HALF = 2.6          # hoop groove half-gap, degrees of arc
FACE_DOME_R = 0.158           # watch-glass face: shallow sphere radius
FACE_DOME_T = 22.5            # its half-angle (proud ~12 mm over r 60 mm)

def head_stations():
    """(y, rho, tag) from back pole toward the face rim, then the dome.
    tag: 'cowl' | 'hoop' | 'rim' | 'face' (material + seam bookkeeping)."""
    st = []
    # back arc: s = 90 (pole) -> 0 (widest), even 11.25 deg steps
    for i in range(7, 0, -1):
        s = math.radians(11.25 * i)
        st.append((HEAD_Y0 + HEAD_BACK_B * math.sin(s),
                   HEAD_RHO * math.cos(s), "cowl"))
    # crown hoop: entry / pinched widest / exit
    hh = math.radians(HEAD_HOOP_HALF)
    st.append((HEAD_Y0 + HEAD_BACK_B * math.sin(hh),
               HEAD_RHO * math.cos(hh), "cowl"))
    st.append((HEAD_Y0, HEAD_RHO * HEAD_HOOP_PULL, "hoop"))
    st.append((HEAD_Y0 - HEAD_FRONT_B * math.sin(hh),
               HEAD_RHO * math.cos(hh), "cowl"))
    # front arc: from the hoop exit down to the face boundary crease
    for tdeg in (12.0, 23.0, 34.0, HEAD_FACE_T):
        t = math.radians(tdeg)
        st.append((HEAD_Y0 - HEAD_FRONT_B * math.sin(t),
                   HEAD_RHO * math.cos(t), "cowl"))
    # face: shallow spherical dome behind the crease (near-flush, NOT a dish)
    y_rim = st[-1][0]
    tmax = math.radians(FACE_DOME_T)
    for tdeg in (15.0, 7.5):
        t = math.radians(tdeg)
        st.append((y_rim - FACE_DOME_R * (math.cos(t) - math.cos(tmax)),
                   FACE_DOME_R * math.sin(t), "face"))
    face_pole_y = y_rim - FACE_DOME_R * (1.0 - math.cos(tmax))
    return st, face_pole_y

HEAD_BACK_POLE_Y = HEAD_Y0 + HEAD_BACK_B

# ear rings: flat washer solids on +-X, axis X, sunk into the cowl
EAR_CENTER = (-0.0040, 1.5100)     # (y, z) of the ring axis
EAR_R_OUT = 0.0340
EAR_R_IN = 0.0260
EAR_X_FACE = 0.0952                # visible flat face
EAR_X_BASE = 0.0840                # buried inside the cowl

# eye dots: small discs on the face dome, axis Y, proud ~2.5 mm
EYE_DX = 0.0260                    # +-x
EYE_DZ = 0.0120                    # above head center
EYE_R = 0.0060
EYE_Y_FACE = -0.0815               # proud of the dome (local head y)
EYE_Y_BASE = -0.0690               # buried inside the face

# ---- torso ----------------------------------------------------------------
# (z, rx, warp). ry = RY_RATIO * rx (knit suit slightly flatter front-back).
# warp: the ring's z DIPS by warp*(1+cos(azimuth-front))/2 -> the chest seam
# is a rounded U, low at the sternum, level at the spine. Caps stay flat
# (warp 0 at both ends). Seams: collar rim (cap), collar base, chest groove,
# pelvic rim (cap); meridians: back zip 0.982 + front 0.990, collar->pelvis.
RY_RATIO = 0.74

def torso_stations():
    return [
        # SHORT collar (taste gate r3.1): half the round-3.0 height, wider,
        # deeper sunken mouth — the head sinks ~53 mm into it and a ~5 mm
        # shadow channel rings the cowl (the round-2 nesting, new head)
        (1.4480, 0.0870, 0.0),    # cap: collar mouth (sunken fan, head nests)
        (1.4330, 0.0878, 0.0),
        (1.4180, 0.0885, 0.0),    # SEAM: collar base — hard break below
        # shoulder bell: a steady ~27 deg trapezius slope from the collar,
        # staying NARROW beside the neck so the deltoid ball (crown 1.3405)
        # rises proud of it and owns the shoulder — the r3.1 poncho fix —
        # then swelling under the ball to a crest that seals the armpit
        (1.4110, 0.0921, 0.0),
        (1.3960, 0.1000, 0.0),
        (1.3790, 0.1090, 0.0),
        # SEAM: yoke seam ring — the raglan boundary, riding the crease
        # where the deltoid emerges from the slope
        (1.3670, 0.1152, 0.0),
        (1.3630, 0.1140, 0.0),
        (1.3590, 0.1177, 0.0),
        (1.3450, 0.1280, 0.0),
        (1.3310, 0.1348, 0.0),
        (1.3170, 0.1408, 0.0),
        (1.3030, 0.1460, 0.0),
        (1.2890, 0.1506, 0.0),
        (1.2750, 0.1542, 0.0),
        (1.2600, 0.1566, 0.0),
        (1.2400, 0.1580, 0.0),
        (1.2100, 0.1585, 0.0),
        (1.1900, 0.1578, 0.0),    # yoke fullest (deltoid balls own the width)
        (1.1400, 0.1455, 0.008),
        (1.1000, 0.1400, 0.022),
        (1.0880, 0.1378, 0.030),
        (1.0850, 0.1354, 0.030),  # SEAM: chest garment groove (warped ring)
        (1.0820, 0.1375, 0.030),
        (1.0300, 0.1318, 0.016),
        (0.9800, 0.1262, 0.005),
        (0.9300, 0.1225, 0.0),
        (0.9000, 0.1208, 0.0),
        # pelvis roundoff (round-2 numbers slimmed ~24%): quiet turns until
        # the wall steepens to ~64 deg, so the flat pad's rim IS a crease —
        # the pelvic line the back zip terminates on
        (0.8770, 0.1196, 0.0),
        (0.8570, 0.1174, 0.0),
        (0.8400, 0.1128, 0.0),
        (0.8260, 0.1058, 0.0),
        (0.8140, 0.0965, 0.0),
        (0.8050, 0.0852, 0.0),
        (0.7985, 0.0718, 0.0),    # cap: flat crotch pad, rim = pelvic line
    ]

# ---- arm ------------------------------------------------------------------
# Ball-topped: the deltoid sphere closes with a POLE DOME (no cap rim) and
# carries two ribbing grooves; contour meridians start at the LOWER groove
# (flush termination) and run to the mitt tip pole. Glove (accent) from the
# wrist cuff down. Soft elbow: no groove, just the relaxed bow.
ARM_BALL_C = (0.1530, 0.0, 1.2750)     # (x, y, z) ball center, left side
ARM_BALL_R = 0.0620
ARM_RIB_PULL = 0.968                   # deltoid ribbing groove depth

def arm_stations():
    """(z, rx, ry, cx, cy, phase). phase: 'dome'|'ball'|'arm'|'mitt'.
    Meridian adjusts run the WHOLE arm, pole to mitt tip (r3.2 — the dome
    carries them too, so the shoulder ball has an extracted outline)."""
    bx, _, bz = ARM_BALL_C
    st = []
    def ball(tdeg, pull=1.0, phase="ball"):
        t = math.radians(tdeg)
        r = ARM_BALL_R * math.sin(t) * pull
        st.append((bz + ARM_BALL_R * math.cos(t), r, r, bx, 0.0, phase))
    # sphere sampled at ~12 deg steps (15 deg would sit in the dead zone)
    ball(12.0, phase="dome")
    ball(24.0, phase="dome")
    ball(36.0, phase="dome")
    ball(46.5, phase="dome")
    # ribbing groove 1 (t ~ 57): entry / pinch / exit
    ball(53.5, phase="dome")
    ball(57.0, ARM_RIB_PULL, phase="dome")
    ball(60.5, phase="dome")
    ball(68.0, phase="dome")
    # ribbing groove 2 (t ~ 75): meridians begin below its exit ring
    ball(71.5, phase="dome")
    ball(75.0, ARM_RIB_PULL, phase="dome")
    ball(78.5, phase="arm")
    ball(88.0, phase="arm")
    ball(100.0, phase="arm")
    st += [
        # upper arm -> soft elbow bow -> forearm taper (no elbow groove);
        # tip held at high-mid-thigh while the deltoid rides 30 mm higher
        (1.2200, 0.0490, 0.0504, 0.1530, -0.0016, "arm"),
        (1.1757, 0.0456, 0.0472, 0.1532, -0.0038, "arm"),
        (1.1166, 0.0436, 0.0452, 0.1528, -0.0068, "arm"),
        (1.0574, 0.0425, 0.0441, 0.1518, -0.0098, "arm"),
        (0.9983, 0.0414, 0.0432, 0.1500, -0.0130, "arm"),
        (0.9342, 0.0392, 0.0411, 0.1480, -0.0170, "arm"),
        (0.8800, 0.0363, 0.0384, 0.1466, -0.0208, "arm"),
        (0.8445, 0.0339, 0.0361, 0.1459, -0.0234, "arm"),
        # SEAM: glove cuff groove — the wrist line; accent glove below
        (0.8415, 0.0311, 0.0332, 0.1458, -0.0236, "arm"),
        (0.8385, 0.0338, 0.0359, 0.1457, -0.0238, "mitt"),
        # mitt: paddle swell (deep y), thumb ridge via front push
        (0.8188, 0.0333, 0.0396, 0.1452, -0.0252, "mitt"),
        (0.7932, 0.0320, 0.0436, 0.1446, -0.0270, "mitt"),
        (0.7675, 0.0300, 0.0450, 0.1440, -0.0288, "mitt"),
        (0.7429, 0.0279, 0.0435, 0.1436, -0.0304, "mitt"),
        (0.7262, 0.0260, 0.0405, 0.1432, -0.0315, "mitt"),
        (0.7143, 0.0242, 0.0320, 0.1430, -0.0323, "mitt"),  # SEAM: knuckle
    ]
    # fingertip: ellipse cap from the knuckle ring to the pole, sampled at
    # EQUAL NORMAL ANGLES of the deeper (ry) ellipse so every taper turn
    # stays quiet despite the eccentricity (same trick as ellipse_ring)
    kz, krx, kry, kcx, kcy = 0.7143, 0.0242, 0.0320, 0.1430, -0.0323
    tip_b = 0.0248
    r_mean = math.sqrt(krx * kry)       # split the error between rx and ry
    for i in range(1, 8):
        ang = math.radians(90.0 * i / 8.0)
        t = math.atan((tip_b / r_mean) * math.tan(ang))
        f = (ARM_TIP[1] - kcx) * (1 - math.cos(t))  # drift toward the tip
        st.append((kz - tip_b * math.sin(t), krx * math.cos(t),
                   kry * math.cos(t), kcx + f, kcy, "mitt"))
    return st

ARM_POLE_TOP_Z = ARM_BALL_C[2] + ARM_BALL_R + 0.0035   # dome pole (smooth)
ARM_TIP = (0.6895, 0.1428, -0.0330)                    # fingertip pole

# Raglan hoop (r3.2): a thin closed ring around the deltoid ball in the x-z
# plane, the crown-hoop trick at shoulder scale. Radial pulls cannot outline
# the upper dome — a pull folds out-of-plane only in proportion to the wall's
# steepness (sin t), so above the ribbing grooves it is a planar distortion
# and extracts nothing; that left the shoulder with no drawn crown at all
# (user report, 2026-08-31). A sunk washer solid extracts as clean concentric
# ellipses whatever the surface does: at yaw 0 it IS the ball's outline, at
# yaw 90 the raglan seam over the shoulder — and it is a seam a garment maker
# would actually sew there.
SHOULDER_HOOP_R_OUT = 0.0635   # ~1.5 mm proud of the R = 0.062 ball
SHOULDER_HOOP_R_IN = 0.0540    # buried inside the ball
SHOULDER_HOOP_HALF_W = 0.0028  # half-thickness along Y

# ---- leg ------------------------------------------------------------------
# Thigh dome-topped (pole buried in the pelvis — no exposed hip cap rim),
# knee wrap between thigh and shin as its own node, trouser cuff flaring
# over the shoe, shoe in shell tone with a dark welt/sole.
LEG_CX = 0.0800

def _thigh_dome():
    """Ellipsoid hip cap sampled at 12.5 deg steps (quiet turns), top first."""
    out = []
    for tdeg in (75.0, 62.5, 50.0, 37.5, 25.0, 12.5):
        t = math.radians(tdeg)
        out.append((0.7900 + 0.0555 * math.sin(t), 0.0595 * math.cos(t)))
    return out

THIGH = _thigh_dome() + [
    (0.7900, 0.0595),   # hip fullest
    (0.7400, 0.0585),
    (0.6400, 0.0538),
    (0.5600, 0.0512),
    (0.5200, 0.0498),   # cap: knee joint ring (hidden inside the wrap)
]
THIGH_POLE_Z = 0.8475   # dome pole, buried in the pelvis

SHIN = [
    (0.4520, 0.0455),   # cap: knee joint ring (hidden inside the wrap)
    (0.3400, 0.0430),
    (0.2200, 0.0408),
    (0.1600, 0.0404),
    (0.1250, 0.0425),   # cuff flare over the shoe
    (0.0980, 0.0448),
    (0.0880, 0.0452),   # cap: trouser hem ring (SEAM: pant-over-shoe line)
]

# knee wrap: low-profile padded band, eased entry/exit, 16 segments so the
# walls extract (the one deliberately ribbed patch on the robot).
KNEE = [
    (0.5350, 0.0512),   # cap: top wrap edge (a few mm proud of the thigh)
    (0.5280, 0.0532),
    (0.5150, 0.0542),
    (0.4720, 0.0542),
    (0.4550, 0.0526),
    (0.4430, 0.0486),   # cap: bottom wrap edge (proud of the shin)
]
KNEE_CENTER_Z = 0.4890

# shoe: rounded slip-on lofted on toe/heel silhouettes (footprint drifts
# forward), sole cap rim + welt crease = the dark sole line (accent bands
# below the welt), body in shell tone, ankle stub hidden inside the cuff.
# z toe heel rx
SHOE = [
    (0.0040, -0.1420, 0.0698, 0.0448),
    (0.0160, -0.1470, 0.0730, 0.0470),  # SEAM: welt — sole/upper split
    (0.0360, -0.1455, 0.0702, 0.0460),
    (0.0500, -0.1408, 0.0674, 0.0444),
    (0.0620, -0.1330, 0.0640, 0.0422),
    (0.0730, -0.1218, 0.0600, 0.0396),
    (0.0820, -0.1075, 0.0555, 0.0366),
    (0.0900, -0.0895, 0.0505, 0.0334),
    (0.0970, -0.0670, 0.0448, 0.0300),
    (0.1050, -0.0295, 0.0325, 0.0262),  # cap: ankle ring (hidden in cuff)
]
SHOE_WELT_BAND = 0    # band index below the welt station -> accent sole

# object origins = joint centers (world; glTF translation after y-up swap)
ORIGINS = {
    "head": (0.0, 0.0, 1.4450),
    "torso": (0.0, 0.0, 0.9500),
    "arm_L": (+ARM_BALL_C[0], 0.0, ARM_BALL_C[2]),
    "arm_R": (-ARM_BALL_C[0], 0.0, ARM_BALL_C[2]),
    "leg_L": (+LEG_CX, 0.0, 0.8000),
    "leg_R": (-LEG_CX, 0.0, 0.8000),
    "knee_actuator_L": (+LEG_CX, 0.0, KNEE_CENTER_Z),
    "knee_actuator_R": (-LEG_CX, 0.0, KNEE_CENTER_Z),
}

# ------------------------------------------------------------ part builds

def loft_vertical(stations, side=1, adjust=None, n=N,
                  cap_top=True, cap_bottom=True,
                  pole_top=None, pole_bottom=None, mat=0,
                  cap_top_drop=0.0, band_mats=None):
    """Loft horizontal rings along Z. Station: (z, rx, ry[, cx, cy]).
    cap_top_drop sinks the top fan center (the collar mouth shadow);
    pole_top/pole_bottom close with a smooth dome instead of a flat cap."""
    lf = Loft(n)
    for st in stations:
        z, rx, ry = st[0], st[1], st[2]
        cx = st[3] * side if len(st) > 3 else 0.0
        cy = st[4] if len(st) > 4 else 0.0
        ring2d = ellipse_ring(rx, ry, n, adjust)
        lf.ring([(cx + u, cy + v, z) for (u, v) in ring2d])
    lf.bridge_all(mat=mat, band_mats=band_mats)
    st = stations[0]
    cx = st[3] * side if len(st) > 3 else 0.0
    cy = st[4] if len(st) > 4 else 0.0
    if pole_top is not None:
        lf.close(0, (cx, cy, pole_top), mat)
    elif cap_top:
        lf.close(0, (cx, cy, st[0] - cap_top_drop), mat)
    st = stations[-1]
    cx = st[3] * side if len(st) > 3 else 0.0
    cy = st[4] if len(st) > 4 else 0.0
    if pole_bottom is not None:
        lf.close(len(lf.rings) - 1, (cx, cy, pole_bottom), mat)
    elif cap_bottom:
        lf.close(len(lf.rings) - 1, (cx, cy, st[0]), mat)
    return lf


def build_torso():
    stations = torso_stations()
    lf = Loft(N)
    for (z, rx, warp) in stations:
        ring2d = ellipse_ring(rx, rx * RY_RATIO, N, TORSO_ADJUST)
        pts = []
        for k, (u, v) in enumerate(ring2d):
            psi = 2.0 * math.pi * k / N
            dip = warp * 0.5 * (1.0 + math.cos(psi - 1.5 * math.pi))
            pts.append((u, v, z - dip))
        lf.ring(pts)
    lf.bridge_all(mat=0)
    lf.close(0, (0.0, 0.0, stations[0][0] - 0.018), 0)     # sunken collar fan
    lf.close(len(lf.rings) - 1, (0.0, 0.0, stations[-1][0]), 0)  # crotch pad
    return lf


def build_head():
    """Egg revolve about +Y + crown hoop + flush face + ears + eye dots."""
    cx, cy, cz = HEAD_CENTER
    stations, face_pole_y = head_stations()
    lf = Loft(N)
    band_mats = {}
    for i, (y, rho, tag) in enumerate(stations):
        r = max(rho, 1e-4)
        ring2d = ellipse_ring(r, r * HEAD_ZSCALE, N)
        lf.ring([(cx + u, cy + y, cz + v) for (u, v) in ring2d])
        if tag == "face" and i > 0:
            band_mats[i - 1] = 2          # bands entering face stations
    lf.bridge_all(mat=0, band_mats=band_mats)
    lf.close(0, (cx, cy + HEAD_BACK_POLE_Y, cz), 0)          # back pole
    lf.close(len(lf.rings) - 1, (cx, cy + face_pole_y, cz), 2)  # face pole

    parts = [lf]
    ey, ez = EAR_CENTER
    for side in (+1, -1):
        w = Loft(N_RING)
        def ring_x(x, r):
            return [(x * side,
                     ey + r * math.cos(2 * math.pi * k / N_RING),
                     ez + r * math.sin(2 * math.pi * k / N_RING))
                    for k in range(N_RING)]
        w.ring(ring_x(EAR_X_BASE, EAR_R_OUT))
        w.ring(ring_x(EAR_X_FACE, EAR_R_OUT))
        w.ring(ring_x(EAR_X_FACE, EAR_R_IN))
        w.ring(ring_x(EAR_X_BASE, EAR_R_IN))
        w.bridge_all(mat=1)
        w.bridge(3, 0, mat=1)             # close the washer loop
        if side < 0:                      # mirrored side: flip winding
            w.faces = [(a, c, b) for (a, b, c) in w.faces]
        parts.append(w)

    for side in (+1, -1):
        e = Loft(N_EYE)
        def ring_y(y, r):
            return [(cx + side * EYE_DX + r * math.cos(2 * math.pi * k / N_EYE),
                     cy + y,
                     cz + EYE_DZ + r * math.sin(2 * math.pi * k / N_EYE))
                    for k in range(N_EYE)]
        e.ring(ring_y(EYE_Y_BASE, EYE_R))
        e.ring(ring_y(EYE_Y_FACE, EYE_R))
        e.bridge_all(mat=1)
        e.close(0, (cx + side * EYE_DX, cy + EYE_Y_BASE, cz + EYE_DZ), 1)
        e.close(1, (cx + side * EYE_DX, cy + EYE_Y_FACE - 0.0012,
                    cz + EYE_DZ), 1)
        parts.append(e)
    return merge_lofts(parts)


def build_arm(side):
    stations = arm_stations()
    lf = Loft(N)
    band_mats = {}
    glove_from = None
    for i, (z, rx, ry, cx, cy, phase) in enumerate(stations):
        if phase == "dome":
            # r3.2 (user: "hard to tell what's going on with the shoulders"):
            # the dome used to stay seam-free, which left the deltoid with NO
            # extracted outline at all — the arm appeared to start at the
            # ribbing grooves, a fuzzy flat cap. The meridians now run to the
            # pole (still "nothing floats": a pole is a legal terminus), so
            # the ball reads as a ball at every yaw.
            adjust = DOME_ADJUST
        elif phase == "mitt":
            adjust = MITT_ADJUST
        else:
            adjust = SEAMS
        if phase == "mitt" and glove_from is None:
            glove_from = i - 1            # the cuff groove band
        ring2d = ellipse_ring(rx, ry, N, adjust)
        lf.ring([(cx * side + u, cy + v, z) for (u, v) in ring2d])
    for b in range(glove_from, len(stations) - 1):
        band_mats[b] = 1
    lf.bridge_all(mat=0, band_mats=band_mats)
    lf.close(0, (ARM_BALL_C[0] * side, 0.0, ARM_POLE_TOP_Z), 0)  # dome pole
    tz, tcx, tcy = ARM_TIP
    lf.close(len(lf.rings) - 1, (tcx * side, tcy, tz), 1)        # glove tip

    # raglan hoop: washer ring about +Y through the ball centre (see header).
    # The loft runs along Y, which `side` never negates, so unlike the ear
    # washers the winding holds on both sides.
    bx, _, bz = ARM_BALL_C
    hoop = Loft(N_RING)
    def ring_y(y, r):
        return [(bx * side + r * math.cos(2 * math.pi * k / N_RING),
                 y,
                 bz + r * math.sin(2 * math.pi * k / N_RING))
                for k in range(N_RING)]
    hoop.ring(ring_y(-SHOULDER_HOOP_HALF_W, SHOULDER_HOOP_R_OUT))
    hoop.ring(ring_y(+SHOULDER_HOOP_HALF_W, SHOULDER_HOOP_R_OUT))
    hoop.ring(ring_y(+SHOULDER_HOOP_HALF_W, SHOULDER_HOOP_R_IN))
    hoop.ring(ring_y(-SHOULDER_HOOP_HALF_W, SHOULDER_HOOP_R_IN))
    hoop.bridge_all(mat=0)
    hoop.bridge(3, 0, mat=0)          # close the washer loop
    return merge_lofts([lf, hoop])


def build_leg(side):
    thigh = loft_vertical([(z, r, r * 1.04, LEG_CX, 0.0) for (z, r) in THIGH],
                          side=side, adjust=SEAMS, cap_top=False,
                          pole_top=THIGH_POLE_Z)
    shin = loft_vertical([(z, r, r * 1.06, LEG_CX, 0.0) for (z, r) in SHIN],
                         side=side, adjust=SEAMS)
    shoe = Loft(N_SHOE)
    for (z, toe, heel, rx) in SHOE:
        cy2 = (toe + heel) / 2.0
        ry = (heel - toe) / 2.0
        ring2d = ellipse_ring(rx, ry, N_SHOE)
        shoe.ring([(LEG_CX * side + u, cy2 + v, z) for (u, v) in ring2d])
    shoe.bridge_all(mat=0, band_mats={SHOE_WELT_BAND: 1})
    s0, sl = SHOE[0], SHOE[-1]
    shoe.close(0, (LEG_CX * side, (s0[1] + s0[2]) / 2.0, s0[0]), 1)  # sole
    shoe.close(len(shoe.rings) - 1,
               (LEG_CX * side, (sl[1] + sl[2]) / 2.0, sl[0]), 0)     # ankle
    return merge_lofts([thigh, shin, shoe])


def build_knee(side):
    return loft_vertical([(z, r, r * 1.04, LEG_CX, 0.0) for (z, r) in KNEE],
                         side=side, adjust=None, n=N_KNEE, mat=1)

# --------------------------------------------------------------- assembly

def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)
    for ma in list(bpy.data.materials):
        bpy.data.materials.remove(ma)


def make_materials():
    mats = []
    for name, hexcode, rough in MATERIAL_SPECS:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (*srgb_to_linear(hexcode), 1.0)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = 0.0
        mats.append(m)
    return mats


def add_object(name, verts, faces, face_mats, origin, materials, parent):
    me = bpy.data.meshes.new(name)
    ox, oy, oz = origin
    me.from_pydata([(x - ox, y - oy, z - oz) for (x, y, z) in verts], [], faces)
    me.validate()
    used = sorted(set(face_mats))
    remap = {m: i for i, m in enumerate(used)}
    for m in used:
        me.materials.append(materials[m])
    me.polygons.foreach_set("material_index", [remap[m] for m in face_mats])
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    # outward-consistent normals per closed shell (winding contract)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # crisp shading across deliberate seams; smooth elsewhere
    sharp = math.radians(26.0)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > sharp:
            e.smooth = False
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = origin
    ob.parent = parent
    bpy.context.scene.collection.objects.link(ob)
    return ob


def build_all():
    clear_scene()
    materials = make_materials()
    root = bpy.data.objects.new("chassis_silhouette", None)
    bpy.context.scene.collection.objects.link(root)

    parts = {}
    def emit(name, lofts_or_tuple):
        if isinstance(lofts_or_tuple, Loft):
            verts, faces, mats = lofts_or_tuple.verts, lofts_or_tuple.faces, \
                lofts_or_tuple.face_mats
        else:
            verts, faces, mats = lofts_or_tuple
        parts[name] = add_object(name, verts, faces, mats, ORIGINS[name],
                                 materials, root)

    emit("head", build_head())
    emit("torso", build_torso())
    emit("arm_L", build_arm(+1))
    emit("arm_R", build_arm(-1))
    emit("leg_L", build_leg(+1))
    emit("leg_R", build_leg(-1))
    emit("knee_actuator_L", build_knee(+1))
    emit("knee_actuator_R", build_knee(-1))
    return parts

# --------------------------------------------------------------------- QA

def run_qa(parts):
    # profile dead-zone checks (drive the wireframe contract)
    tst = torso_stations()
    check_profile("torso.rx", [(z, rx) for (z, rx, _) in tst])
    check_profile("torso.front(warped)",
                  [(z - w, rx) for (z, rx, w) in tst])
    hst, _ = head_stations()
    check_profile("head.rho", [(y, r) for (y, r, _) in hst])
    ast = arm_stations()
    check_profile("arm.rx", [(z, rx) for (z, rx, *_r) in ast])
    check_profile("arm.ry", [(z, ry) for (z, _, ry, *_r) in ast])
    check_profile("thigh.r", THIGH)
    check_profile("shin.r", SHIN)
    nshoe = len(SHOE)
    check_profile("shoe.toe", [(z, toe) for (z, toe, _, _) in SHOE],
                  hidden=(nshoe - 2,))
    check_profile("shoe.heel", [(z, heel) for (z, _, heel, _) in SHOE],
                  hidden=(nshoe - 2,))
    check_profile("shoe.rx", [(z, rx) for (z, _, _, rx) in SHOE],
                  hidden=(nshoe - 2,))

    # contract checks
    total = 0
    print("\n  per-node triangles:")
    for name in ("head", "torso", "arm_L", "arm_R", "leg_L", "leg_R",
                 "knee_actuator_L", "knee_actuator_R"):
        ob = parts[name]
        ob.data.calc_loop_triangles()
        tris = len(ob.data.loop_triangles)
        total += tris
        print(f"    {name:<18}{tris:>6} tris  {len(ob.data.vertices):>6} verts")
    print(f"    {'TOTAL':<18}{total:>6} tris")
    if not (TRI_MIN <= total <= TRI_MAX):
        QA_FAILURES.append(f"triangle budget: {total} outside [{TRI_MIN}, {TRI_MAX}]")

    zs = []
    for ob in parts.values():
        ox, oy, oz = ob.location
        zs.extend(oz + v.co.z for v in ob.data.vertices)
    zmin, zmax = min(zs), max(zs)
    height = zmax - zmin
    print(f"  height: {height:.4f} m  (z {zmin:.4f} .. {zmax:.4f})")
    if not (1.6 <= height <= 1.7):
        QA_FAILURES.append(f"height {height:.4f} outside [1.6, 1.7]")
    if not (0.0 <= zmin <= 0.012):
        QA_FAILURES.append(f"sole at z={zmin:.4f}, not grounded near 0")
    if len(bpy.data.materials) != 3:
        QA_FAILURES.append(f"{len(bpy.data.materials)} materials, expected 3")

    if QA_FAILURES:
        print("\nQA FAILURES:")
        for f in QA_FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("  QA: all profile/contract checks passed")

# ----------------------------------------------------------------- export

def export_glb(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    desired = dict(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_texcoords=False,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_copyright=GLTF_COPYRIGHT,
        export_image_format="NONE",
    )
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    bpy.ops.export_scene.gltf(**{k: v for k, v in desired.items() if k in props})
    print(f"  wrote {path} ({os.path.getsize(path) / 1024:.1f} KB)")

# ----------------------------------------------------------------- render

def render_previews(out_dir):
    """Front + three-quarter taste-gate renders: Cycles CPU, 3-point light."""
    os.makedirs(out_dir, exist_ok=True)
    scene = bpy.context.scene

    # ground + world
    world = bpy.data.worlds.new("preview_world")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.92, 0.91, 0.89, 1.0)
    bg.inputs[1].default_value = 1.0
    scene.world = world

    ground_me = bpy.data.meshes.new("ground")
    s = 8.0
    ground_me.from_pydata(
        [(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [],
        [(0, 1, 2, 3)])
    ground = bpy.data.objects.new("ground", ground_me)
    gmat = bpy.data.materials.new("ground_mat")
    gmat.use_nodes = True
    gb = gmat.node_tree.nodes["Principled BSDF"]
    gb.inputs["Base Color"].default_value = (*srgb_to_linear("#F1EFEA"), 1.0)
    gb.inputs["Roughness"].default_value = 0.95
    ground_me.materials.append(gmat)
    scene.collection.objects.link(ground)

    def area(name, loc, rot, size, energy):
        light = bpy.data.lights.new(name, "AREA")
        light.size = size
        light.energy = energy
        ob = bpy.data.objects.new(name, light)
        ob.location = loc
        ob.rotation_euler = rot
        scene.collection.objects.link(ob)
        return ob

    d = math.radians
    area("key", (1.9, -2.3, 2.7), (d(38), d(18), d(38)), 2.6, 420)
    area("fill", (-2.5, -1.9, 1.3), (d(72), d(-28), d(-48)), 3.2, 130)
    area("rim", (0.4, 2.6, 2.3), (d(-40), d(6), d(172)), 2.2, 260)

    target = bpy.data.objects.new("cam_target", None)
    target.location = (0.0, 0.0, 0.84)
    scene.collection.objects.link(target)

    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.device = "CPU"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 1200
    scene.render.film_transparent = False

    shots = {
        "model-front.png": (0.0, -3.4, 1.02),
        "model-quarter.png": (1.95, -2.75, 1.25),
    }
    for fname, loc in shots.items():
        cam.location = loc
        scene.render.filepath = os.path.join(out_dir, fname)
        bpy.ops.render.render(write_still=True)
        print(f"  rendered {scene.render.filepath}")

# ------------------------------------------------------------------- main

def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "public", "models", "chassis-silhouette.glb")
    render_dir = None
    no_export = "--no-export" in argv
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    if "--render" in argv:
        render_dir = argv[argv.index("--render") + 1]

    parts = build_all()
    run_qa(parts)
    if not no_export:
        export_glb(os.path.normpath(out))
    if render_dir:
        render_previews(render_dir)


if __name__ == "__main__":
    main()
