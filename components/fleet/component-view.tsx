"use client";

import * as React from "react";
import { preload } from "react-dom";
import dynamic from "next/dynamic";
import { useShallow } from "zustand/react/shallow";
import {
  selectAlerts,
  selectUnit,
  selectUnitHistory,
  useFleetStore,
  useIncidentStore,
  type IncidentState,
} from "@/lib/stores";
import { cn } from "@/lib/utils";
import { ComponentElevation } from "./component-elevation";
import {
  CHASSIS_MODEL_URL,
  COMPONENT_ORDER,
  componentHighlight,
  componentLabel,
  componentStatus,
  selectionKey,
  type ComponentHighlight,
  type ComponentId,
} from "./component-spec";
import {
  ConsoleCard,
  isDescentOccluded,
  StatusChip,
  subscribeDescentOcclusion,
  usePrefersReducedMotion,
} from "@/components/console";
import { PartDetail } from "./part-detail";
import {
  clearSelectedPart,
  selectedPartFor,
  setSelectedPart,
  subscribeSelection,
} from "./part-selection";

/**
 * The component view: a picture of the robot rather than a reading off it.
 *
 * This file is a gate. Everything three.js touches lives behind the
 * `next/dynamic` boundary below, so nothing here imports three and the unit
 * page's initial JS is unchanged. The scene mounts on scroll (an
 * IntersectionObserver with a generous margin), the front elevation holds the
 * frame until it is ready — and forever without WebGL or after a failure —
 * and the incident highlight derives from the same stores as the banner.
 */

const ComponentScene = dynamic(
  () => import("./component-scene").then((m) => m.ComponentScene),
  { ssr: false },
);

/** Narrow subscriptions — the session object churns on every scan line. */
const selectFlaggedJoint = (s: IncidentState): string | null =>
  s.session?.flag?.joint ?? null;
const selectSessionVerdictJoint = (s: IncidentState): string | null =>
  s.session?.report?.joint ?? null;

/** Start fetching the chunk and the model a screenful before they are wanted. */
const PREMOUNT_MARGIN = "600px 0px";

/**
 * The model, fetched beside the chunk rather than behind it.
 *
 * `useGLTF.preload` lives in component-chassis.ts, which imports three — so it
 * is on the far side of the dynamic boundary and cannot run until the scene
 * chunk has downloaded *and* evaluated. That put a 200 KB body behind a
 * 250 KB gz one, in series, for no reason: the URL is a plain string that this
 * side of the gate already knows.
 *
 * `crossOrigin` for the same reason the fleet map's style preload carries it —
 * three's loader reads with XHR at `withCredentials: false`, so only a
 * credentials-mode match lets the preload satisfy that read instead of racing
 * a second copy of it.
 */
function warmChassisModel(): void {
  preload(CHASSIS_MODEL_URL, { as: "fetch", crossOrigin: "anonymous" });
}

export interface ComponentViewProps {
  unitId: string;
}

export function ComponentView({ unitId }: ComponentViewProps) {
  const highlight = useComponentHighlight(unitId);
  const reducedMotion = usePrefersReducedMotion();

  // The selection lives in part-selection.ts (a module singleton read through
  // useSyncExternalStore) because the joint grid and the detail card read it
  // too; lifting it into the page would re-render every canvas per click.
  const selected = React.useSyncExternalStore(
    subscribeSelection,
    () => selectedPartFor(unitId),
    () => null,
  );
  const setSelected = React.useCallback(
    (id: ComponentId | null) => setSelectedPart(unitId, id),
    [unitId],
  );
  // A selection is only true of the page it was made on.
  React.useEffect(() => () => clearSelectedPart(unitId), [unitId]);

  const [hovered, setHovered] = React.useState<ComponentId | null>(null);
  const [sceneReady, setSceneReady] = React.useState(false);
  const [sceneFailed, setSceneFailed] = React.useState(false);

  const frameRef = React.useRef<HTMLDivElement>(null);
  const { mounted, visible } = useViewportGate(frameRef);
  const webgl = useWebglSupport();

  const use3d = webgl && mounted && !sceneFailed;
  const showElevation = !use3d || !sceneReady;

  const onReady = React.useCallback(() => setSceneReady(true), []);

  // Arrow keys walk the eight parts, Escape drops the selection. The region is
  // the tab stop: eight focusable meshes inside a canvas would be a tab trap.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = selectionKey(e.key, selected);
    if (next === undefined) return;
    e.preventDefault();
    setSelected(next);
  };

  return (
    <ConsoleCard
      label="Component view"
      labelAs="h2"
      action={
        <span className="text-label text-ink-soft uppercase">
          {use3d ? "Drag to turn" : "Front elevation"}
        </span>
      }
    >
      {/* Capped measure inside a full-width card; side by side only from `lg`. */}
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-7 lg:flex-row lg:items-stretch lg:gap-10">
        <div className="flex flex-1 items-center justify-center">
          <div
            ref={frameRef}
            tabIndex={0}
            role="group"
            aria-label={`Chassis component view for ${unitId}. Arrow keys cycle through the eight components, Escape clears the selection.`}
            onKeyDown={onKeyDown}
            onClick={(e) => {
              // A click that reached the frame itself missed every part.
              if (e.target === e.currentTarget) setSelected(null);
            }}
            className={cn(
              "relative aspect-[4/5] w-full max-w-[420px] rounded-lg",
              "outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
            )}
          >
            {/* The drawing sits underneath the whole time. */}
            <div
              className={cn(
                "absolute inset-0 transition-opacity duration-[var(--dur-enter)] ease-console",
                showElevation ? "opacity-100" : "pointer-events-none opacity-0",
              )}
            >
              <ComponentElevation
                selected={selected}
                highlight={highlight}
                onSelect={setSelected}
                interactive={!use3d}
              />
            </div>

            {use3d ? (
              <SceneBoundary onFailure={() => setSceneFailed(true)}>
                <ComponentScene
                  className={cn(
                    // Deliberate 2x --dur-enter: at 180ms the drawing->render
                    // handover reads as a blink.
                    "absolute inset-0 transition-opacity duration-[calc(var(--dur-enter)*2)] ease-console",
                    sceneReady ? "opacity-100" : "opacity-0",
                  )}
                  selected={selected}
                  hovered={hovered}
                  highlight={highlight}
                  onSelect={setSelected}
                  onHover={setHovered}
                  onReady={onReady}
                  reducedMotion={reducedMotion}
                  visible={visible}
                />
              </SceneBoundary>
            ) : null}
          </div>
        </div>

        <ComponentList
          unitId={unitId}
          selected={selected}
          hovered={hovered}
          highlight={highlight}
          onSelect={setSelected}
          onHover={setHovered}
        />
      </div>
    </ConsoleCard>
  );
}

/**
 * The eight parts as words, beside the picture of them — the accessible copy
 * of the canvas, and the only place a selection has a visible name. A row
 * states its status only when flagged or selected, so the one reading
 * ATTENTION is not out-shouted by seven reading NOMINAL.
 */
function ComponentList({
  unitId,
  selected,
  hovered,
  highlight,
  onSelect,
  onHover,
}: {
  unitId: string;
  selected: ComponentId | null;
  hovered: ComponentId | null;
  highlight: ComponentHighlight | null;
  onSelect: (id: ComponentId | null) => void;
  onHover: (id: ComponentId | null) => void;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-[420px] flex-col justify-center gap-5",
        "lg:mx-0 lg:w-[300px] lg:max-w-none lg:shrink-0",
        "lg:border-l lg:border-line lg:pl-8",
      )}
    >
      {/* One live region for the whole list: arrowing speaks the landing. */}
      <ul aria-label="Chassis components" aria-live="polite" className="flex flex-col">
        {COMPONENT_ORDER.map((id) => {
          const status = componentStatus(id, highlight);
          const isSelected = selected === id;
          const flagged = highlight?.id === id;
          return (
            <li key={id}>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelect(isSelected ? null : id)}
                onPointerEnter={() => onHover(id)}
                onPointerLeave={() => onHover(null)}
                onFocus={() => onHover(id)}
                onBlur={() => onHover(null)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2",
                  "text-left text-small transition-colors duration-[var(--dur-press)] ease-console",
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                  // Too wide to scale under a thumb; the press is a ground step.
                  "active:bg-press active:text-ink",
                  isSelected
                    ? "bg-bg text-ink shadow-[var(--elev-card)]"
                    : hovered === id
                      ? "bg-bg/60 text-ink"
                      : "text-ink-soft",
                )}
              >
                {/* The explicit space keeps the accessible name from running
                    the part and its status together. */}
                <span className="truncate">{componentLabel(id)}</span>{" "}
                {flagged || isSelected ? (
                  <StatusChip status={status} tone={flagged ? "quiet" : "bare"}>
                    {status === "nominal" ? "Nominal" : "Attention"}
                  </StatusChip>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {selected ? (
        <PartDetail unitId={unitId} part={selected} highlight={highlight} />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Store derivation
--------------------------------------------------------------------------- */

/**
 * Which part is lit and why, from the same facts every other region reads.
 * No telemetry subscription: re-deriving a suspect from ring buffers would
 * re-render a WebGL host at 10 Hz to say nothing new.
 */
export function useComponentHighlight(unitId: string): ComponentHighlight | null {
  const unit = useFleetStore(selectUnit(unitId));
  const alerts = useFleetStore(selectAlerts);
  const flaggedJoint = useIncidentStore(selectFlaggedJoint);
  const sessionVerdict = useIncidentStore(selectSessionVerdictJoint);
  const history = useIncidentStore(useShallow(selectUnitHistory(unitId)));

  const alertMessage = alerts.find((a) => a.unitId === unitId)?.message ?? null;
  const verdictJoint = history[0]?.report.joint ?? sessionVerdict;

  return React.useMemo(
    () =>
      componentHighlight({
        status: unit?.status,
        alertMessage,
        flaggedJoint,
        verdictJoint,
      }),
    [unit?.status, alertMessage, flaggedJoint, verdictJoint],
  );
}

/* ---------------------------------------------------------------------------
   Gates
--------------------------------------------------------------------------- */

/**
 * Two observers, because the two questions want opposite margins. "Should the
 * viewer exist yet?" mounts a screenful early and latches (a WebGL context is
 * not churned on scroll). "Should it animate?" wants no margin, and ANDs in
 * descent occlusion: an observer measures intersection, not occlusion, and
 * the turntable must stop under the opaque descent surface.
 */
export function useViewportGate(ref: React.RefObject<HTMLElement | null>): {
  mounted: boolean;
  visible: boolean;
} {
  const [mounted, setMounted] = React.useState(false);
  const [intersecting, setIntersecting] = React.useState(false);
  const occluded = React.useSyncExternalStore(
    subscribeDescentOcclusion,
    isDescentOccluded,
    () => false,
  );

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver !== "function") {
      // No observer (jsdom, very old browsers): mount rather than withhold.
      warmChassisModel();
      setMounted(true);
      setIntersecting(true);
      return;
    }

    const approaching = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        warmChassisModel();
        setMounted(true);
      },
      { rootMargin: PREMOUNT_MARGIN },
    );
    const onScreen = new IntersectionObserver(([entry]) =>
      setIntersecting(entry?.isIntersecting ?? false),
    );
    approaching.observe(el);
    onScreen.observe(el);

    return () => {
      approaching.disconnect();
      onScreen.disconnect();
    };
  }, [ref]);

  return { mounted, visible: intersecting && !occluded };
}

/** One probe, cached: whether this browser can give us a context at all. */
let webglSupport: boolean | null = null;

function probeWebgl(): boolean {
  if (webglSupport !== null) return webglSupport;
  try {
    const canvas = document.createElement("canvas");
    webglSupport = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

function useWebglSupport(): boolean {
  // Server and first client render agree on `false`, so the elevation is what
  // hydrates and the probe cannot cause a mismatch.
  const [supported, setSupported] = React.useState(false);
  React.useEffect(() => setSupported(probeWebgl()), []);
  return supported;
}

/**
 * If the model or the renderer fails, the section quietly becomes a drawing:
 * the boundary reports upward, the parent stops asking for 3D, and the
 * elevation underneath stays.
 */
class SceneBoundary extends React.Component<
  { onFailure: () => void; children: React.ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error("Component view failed to render; falling back to elevation.", error);
    this.props.onFailure();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
