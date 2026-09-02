// The strip's public surface; the responsibilities are split across the siblings.
export {
  TELEMETRY_STRIP_EXPANDED_HEIGHT,
  TELEMETRY_STRIP_HEIGHT,
  TelemetryStrip,
} from "./strip-host";
export type { TelemetryStripProps } from "./strip-host";
export { breachedRecently, stripTone } from "./strip-tone";
export type { StripTone } from "./strip-tone";
