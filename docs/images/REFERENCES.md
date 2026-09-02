# Design references

The visual targets for the two spaces, described in words. The reference
captures themselves are third-party material and are kept local only
(`docs/images/*.png` is gitignored); nothing in this repository or the shipped
app copies a frame, a logo, or an asset from any of them.

## Operator space (light, the default)

- **Map style.** White ground, fine grey line-art, isometric-illustration
  energy. The fleet map should read like a product illustration, not like
  a navigation app.
- **Typography.** A neutral grotesk at a small number of sizes, generous
  spacing, muted greys, wide tracking on small-caps labels.
- **Palette.** Warm whites and greige, soft shadows, a single dark accent.
  Rounded pill buttons. Status colours stay muted: sage, amber, clay.

## Machine space (dark, diagnostics)

The language is the classic anime diagnostic board: phosphor mono type on
near-black, luminance for hierarchy, radius zero, no shadows.

- **Parts board.** A numbered per-component list stamped OPERATING or
  DAMAGED, the damaged rows inverted. This is the key reference; it became
  the parts manifest.
- **Waveforms.** Green traces on black with a reference envelope and a red
  cursor; the live-versus-reference channel sweep.
- **Program walk.** A streaming file-system walk in mono green; the
  subsystem log on the left of the scan.
- **Body columns.** Full-body component columns with terse labels; the
  layout of the elevation beside the manifest.
- **Dense status grids and wireframes.** Used only as pacing references
  for the "scanning all channels" beat and the wireframe elevation.

## Usage rules

- Inspiration only. No copied frames, no third-party assets, no company or
  product names anywhere in the repo or the app.
- The chassis silhouette is original work, modelled in Blender from generic
  consumer home-robot proportions (`scripts/blender-chassis-silhouette.py`).
- The diagnostic sequence: light UI → alert → descent into machine space →
  scripted scan (walk, then channels) → one red flag on a single actuator →
  verdict and recommendation → ascent with the incident logged.
