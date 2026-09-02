"use client";

import * as React from "react";
import { getUnitBuffers, TELEMETRY_RING_CAPACITY } from "@/lib/stores";
import { cn } from "@/lib/utils";
import { type ComponentId } from "./component-spec";
import { JOINT_GRID_ORDER, jointLabel, METRICS, type Joint } from "./joint-spec";
import {
  currentPartSelection,
  jointEmphasis,
  subscribeSelection,
  type PartSelection,
} from "./part-selection";
import { SectionLabel } from "./section-label";
import { sampleAt } from "./telemetry-bands";
import {
  clearCursor,
  offsetFromLocalX,
  setCursor,
  subscribeCursor,
} from "./telemetry-hover";
import { TelemetryStrip } from "./telemetry-strip";

/**
 * Eighteen instruments, organised joint-major.
 *
 * Joint-major rather than measure-major because of the question the page is
 * built to answer. An operator arriving from an alert is not asking "how do
 * the six torques compare"; they are asking "what is the left knee doing" —
 * and the answer is heat, effort and draw *together*, since a joint running
 * hot at normal torque is a different fault from one running hot because it
 * is fighting something. Keeping the three measures of a joint in one cell
 * puts that correlation under one glance; spreading them across three
 * columns of six would make the reader assemble it themselves.
 *
 * Laid out a leg at a time (see JOINT_GRID_ORDER): at three columns each row
 * is one leg and each column is a pair, so the left/right comparison a walking
 * machine invites is a glance down a column.
 *
 * The hairlines are the grid's own gaps over a `--line` ground rather than
 * borders on cells: no double rules where cells meet, and no arithmetic about
 * which edge belongs to whom when the column count changes.
 *
 * ## The grid owns the cursor, not the strips
 *
 * A per-strip hover would give eighteen answers to a question that has one:
 * *what was this leg doing at that instant*. So the pointer is handled here,
 * once, converted to a sample offset (telemetry-hover.ts) that every strip
 * resolves through its own scale, and the eighteen canvases draw the same
 * vertical line at the same moment in time. Nothing about that path touches
 * React: the offset goes into a module variable, the strips read it in the
 * frame callback they already run, and the readouts are written with
 * `textContent`. A pointer crossing the grid re-renders nothing.
 *
 * ## The grid answers the viewer, and that costs nothing either
 *
 * Selecting a part in the component view brings that joint's cell forward and
 * pushes the other five back a step. The selection lives in
 * part-selection.ts for the same reason the cursor lives in telemetry-hover.ts,
 * and it is applied the same way: this component subscribes once, and on a
 * change writes one `data-emphasis` attribute onto each of six cells. Six
 * attribute writes per *click*, no render, and the appearance itself is CSS on
 * those attributes — so the eighteen canvases underneath are never told that
 * anything happened.
 *
 * Four of the eight parts (head, torso, both arms) have no instrumented joints.
 * Selecting one of them dims **nothing**: the detail card beside the viewer
 * states the part and the telemetry panel stays exactly as it was. Greying out
 * eighteen instruments to announce that a torso has no strips would be the page
 * making a fuss about an absence.
 */
export interface JointGridProps extends React.ComponentPropsWithoutRef<"div"> {
  unitId: string;
}

/** `joint:metric`, or null. One strip at a time — an expansion is a focus. */
type ExpandedKey = string | null;

export function JointGrid({ className, unitId, ...props }: JointGridProps) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = React.useState<ExpandedKey>(null);

  /**
   * The pointer→sample mapping needs one rectangle: the canvas the pointer is
   * over. Cached rather than read per move, because the frame that follows a
   * move writes text into eighteen readouts — reading a rect after that is a
   * forced synchronous layout, sixty times a second, for a number that barely
   * moves. It is re-read when the pointer crosses into another column, and
   * invalidated when the grid resizes; only a *horizontal* scroll could stale
   * it otherwise, and this page is a single column that has none at any width.
   */
  const geometry = React.useRef({
    el: null as Element | null,
    left: 0,
    width: 0,
    stale: true,
  });
  /** Set while a finger is down; a mouse needs no press to scrub. */
  const dragging = React.useRef<number | null>(null);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => {
      geometry.current.stale = true;
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      // A route change with the pointer still over the grid would otherwise
      // leave a cursor pinned to a unit nobody is looking at.
      clearCursor(unitId);
    };
  }, [unitId]);

  /**
   * The cross-highlight, applied imperatively.
   *
   * One subscription, six attribute writes per change, zero renders — the
   * contract in the header. `shown` holds the part the DOM currently reflects
   * so that a re-assertion of the same selection (a second click on the same
   * rail row, a hover that re-emits) cannot re-trigger the reveal below.
   */
  const shown = React.useRef<ComponentId | null>(null);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const apply = (selection: PartSelection | null) => {
      const part =
        selection !== null && selection.unitId === unitId ? selection.part : null;
      const changed = part !== shown.current;
      shown.current = part;

      let focus: HTMLElement | null = null;
      for (const cell of root.querySelectorAll<HTMLElement>("[data-joint-cell]")) {
        const emphasis = jointEmphasis(part, cell.dataset.jointCell ?? "");
        if (emphasis === null) delete cell.dataset.emphasis;
        else cell.dataset.emphasis = emphasis;
        if (emphasis === "on" && focus === null) focus = cell;
      }
      if (changed && focus) reveal(focus);
    };

    apply(currentPartSelection());
    return subscribeSelection(apply);
  }, [unitId]);

  const setScrubbing = (on: boolean) => {
    const root = rootRef.current;
    if (!root) return;
    if (on) root.setAttribute("data-scrubbing", "");
    else root.removeAttribute("data-scrubbing");
  };

  const track = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    const cell = target?.closest("[data-joint-cell]");
    // The 1px hairlines between cells are gaps, not a region: passing over one
    // must not blink the cursor off and back on.
    if (!cell) return;
    const canvas = cell.querySelector("canvas");
    if (!canvas) return;
    const cache = geometry.current;
    if (cache.el !== canvas || cache.stale) {
      const rect = canvas.getBoundingClientRect();
      cache.el = canvas;
      cache.left = rect.left;
      cache.width = rect.width;
      cache.stale = false;
    }
    // Every strip on a unit page is filled from the same batch, so one sample
    // count serves all eighteen and the cursor cannot mean two instants.
    const available = getUnitBuffers(unitId)?.ts.length ?? 0;
    const offset = offsetFromLocalX(
      event.clientX - cache.left,
      cache.width,
      TELEMETRY_RING_CAPACITY,
      available,
    );
    if (offset === null) {
      clearCursor(unitId);
      setScrubbing(false);
      return;
    }
    setCursor(unitId, offset, event.pointerType !== "mouse");
    setScrubbing(true);
  };

  const release = () => {
    dragging.current = null;
    clearCursor(unitId);
    setScrubbing(false);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Mouse hovers; everything else has to be pressed. `touch-pan-y` on the
    // canvas has already told the browser that a vertical drag belongs to the
    // page, so a scrub that starts here is one the scroller declined.
    if (event.pointerType === "mouse") return;
    dragging.current = event.pointerId;
    track(event);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" && dragging.current !== event.pointerId) return;
    track(event);
  };

  const handlePointerLeave = () => {
    if (dragging.current !== null) return;
    clearCursor(unitId);
    setScrubbing(false);
  };

  const toggle = (key: string) => {
    setExpanded((current) => (current === key ? null : key));
  };

  /**
   * On a mouse, the canvas is already the scrub surface, so clicking it is the
   * obvious way to ask for a closer look and the label row's caret is the
   * discoverable one. On a touch screen it is neither: the canvas is inside a
   * vertical scroller and a tap that lands on it during a flick would expand a
   * strip nobody asked to expand. There, the control is the row.
   */
  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element | null;
    if (!(target instanceof HTMLCanvasElement)) return;
    if (!globalThis.matchMedia?.("(pointer: fine)").matches) return;
    const strip = target.closest("[data-slot='telemetry-strip']");
    const joint = strip?.getAttribute("data-joint");
    const metric = strip?.getAttribute("data-metric");
    if (joint && metric) toggle(`${joint}:${metric}`);
  };

  // Escape and a click off the grid both mean "I am done looking closely".
  // Bound only while something is expanded, so the page carries no listeners
  // for a state it is not in.
  React.useEffect(() => {
    if (expanded === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(null);
    };
    const onDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && rootRef.current?.contains(target)) return;
      setExpanded(null);
    };
    globalThis.addEventListener("keydown", onKey);
    globalThis.addEventListener("pointerdown", onDown, true);
    return () => {
      globalThis.removeEventListener("keydown", onKey);
      globalThis.removeEventListener("pointerdown", onDown, true);
    };
  }, [expanded]);

  return (
    <div
      ref={rootRef}
      data-slot="joint-grid"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={handlePointerLeave}
      onClick={handleClick}
      className={cn(
        "group/grid grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3",
        // the ground shows through the gaps; cells paint over it
        className,
      )}
      {...props}
    >
      {JOINT_GRID_ORDER.map((joint) => (
        <JointCell
          key={joint}
          unitId={unitId}
          joint={joint}
          expanded={expanded}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

/**
 * Bring a highlighted cell the rest of the way into view — and only that far.
 *
 * `block: "nearest"` is doing the real work: a cell already fully on screen is
 * left alone, and one hanging off an edge is nudged by the minimum. The extra
 * guard above it is the one the option cannot express. A cross-highlight is a
 * *find*, not a navigation: if the cell is somewhere else entirely — the viewer
 * sits a screenful below the telemetry card, so a selection made down there
 * would otherwise haul the operator back up — the highlight is simply applied
 * and waiting when they scroll to it. The console does not take the wheel
 * because somebody clicked a knee.
 *
 * `scrollIntoView` is absent in jsdom, hence the typeof check rather than a
 * try/catch: a missing scroll must not stop the five other cells being dimmed.
 */
function reveal(cell: HTMLElement): void {
  if (typeof cell.scrollIntoView !== "function") return;
  const rect = cell.getBoundingClientRect();
  const viewport = globalThis.innerHeight || 0;
  const onScreen = rect.top < viewport && rect.bottom > 0;
  if (!onScreen) return;
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  cell.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
}

function JointCell({
  unitId,
  joint,
  expanded,
  onToggle,
}: {
  unitId: string;
  joint: Joint;
  expanded: ExpandedKey;
  onToggle: (key: string) => void;
}) {
  return (
    <section
      data-joint-cell={joint}
      className={cn(
        "flex flex-col gap-4 bg-bg px-5 py-5",
        "transition-[opacity,box-shadow] duration-[var(--dur-enter)] ease-console",
        "motion-reduce:transition-none",
        // The selected joint gets a hairline one step up from the grid's own
        // rules, drawn *inset* so it cannot add a pixel to a cell that shares
        // its edges with five others. No tint underneath it: these cells sit on
        // a `--line` ground and paint over it, so a translucent wash would mix
        // with the rule colour rather than with the page — and an opaque greige
        // across a 330 px box is a louder statement than a selection has earned.
        "data-[emphasis=on]:shadow-[inset_0_0_0_1px_var(--line-strong)]",
        // Recede, do not disappear. The other five joints are still the context
        // that makes the selected one legible — an asymmetry between a pair is
        // only visible if the pair is still on screen.
        "data-[emphasis=off]:opacity-45",
      )}
    >
      {/* One type step above the metric labels inside the cell, in ink
          rather than soft: at the same 11px the joint would read as a
          fourth measure instead of as the thing the three belong to. */}
      <SectionLabel as="h3" tone="ink" className="text-small font-medium">
        {jointLabel(joint)}
      </SectionLabel>
      {METRICS.map((metric) => {
        const key = `${joint}:${metric}`;
        return (
          <TelemetryStrip
            key={metric}
            unitId={unitId}
            joint={joint}
            metric={metric}
            expanded={expanded === key}
            onToggleExpand={() => onToggle(key)}
          />
        );
      })}
    </section>
  );
}

/**
 * The window's description, and the cursor's timestamp, in one slot.
 *
 * Lives in the telemetry card's label row rather than as a chip floating near
 * the pointer. There is exactly one instant under the cursor no matter which of
 * the eighteen strips it is over, so printing it eighteen times would be
 * eighteen copies of one fact — and a tooltip trailing the pointer across a
 * grid of instruments is the dashboard clutter this page is built against. The
 * strips print their own values; the shared half of the readout prints here,
 * where the window's own caption already is.
 *
 * Written from the cursor subscription with `textContent`, so the fastest
 * moving text in the product costs zero renders.
 */
export function TelemetryCursorMeta({ unitId }: { unitId: string }) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const valueRef = React.useRef<HTMLSpanElement | null>(null);

  React.useEffect(
    () =>
      subscribeCursor((cursor) => {
        const host = ref.current;
        const slot = valueRef.current;
        if (!host || !slot) return;
        if (cursor === null || cursor.unitId !== unitId) {
          host.removeAttribute("data-active");
          return;
        }
        const ts = getUnitBuffers(unitId)?.ts;
        const at = ts ? sampleAt(ts, cursor.offset) : undefined;
        if (at === undefined) {
          host.removeAttribute("data-active");
          return;
        }
        slot.textContent = `${cursorAge(cursor.offset)} · ${clock(at)}`;
        host.setAttribute("data-active", "");
      }),
    [unitId],
  );

  return (
    <span
      ref={ref}
      data-slot="telemetry-cursor-meta"
      className="group/meta relative inline-flex tnum text-label text-ink-soft uppercase"
    >
      <span className="group-data-[active]/meta:opacity-0">Last 60 s · 10 Hz</span>
      {/* Sentence case and normal tracking, against the label styling it sits
          inside — these are times, not a label, the same call the timeline's
          own captions make. "−25.2 S" is not a unit of anything. */}
      <span
        ref={valueRef}
        aria-hidden
        className="absolute top-0 right-0 tracking-normal whitespace-nowrap text-ink normal-case opacity-0 group-data-[active]/meta:opacity-100"
      />
    </span>
  );
}

/** "now" at the right edge, "−12.4 s" anywhere else. Tenths, because 10 Hz. */
function cursorAge(offset: number): string {
  if (offset === 0) return "now";
  return `−${(Math.abs(offset) / 10).toFixed(1)} s`;
}

function clock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
