import { type DiagSession } from "@/lib/stores";
import { machineComponent, machineJoint, pad2, pad4 } from "./scan-copy";
import { type ScanLink } from "./scan-state";

/**
 * The program walk, as a list of lines — derived from the session on every
 * render and stored nowhere.
 *
 * That is the whole design of this module and it is not an aesthetic
 * preference. A log is the one component in a streaming UI that *wants* to be
 * an append-only array, and an append-only array is exactly what breaks when
 * the transport reconnects and the host replays the emitted prefix: twenty
 * lines become forty, and the board beside it still says six channels. The
 * store dedupes the events (lib/stores/README.md); this function is a pure
 * projection of what survived. Replay costs a re-render and produces an
 * identical list.
 *
 * The phase lines are derived too, not injected by a timer. `SCAN START`
 * exists because there is a session; `CHANNEL SWEEP BEGIN` because a channel
 * arrived; `DIVERGENCE FLAGGED` because the flag did. The one piece of
 * ordering the store does not preserve — where the flag sits among the
 * channels — is reconstructed from the choreography's tested invariant: the
 * flag always follows its own joint's channel (sim/diagnostics.test.ts,
 * "flags knee_L actuator_A07 gain immediately after knee_L's channel").
 */

export type ScanLogKind = "phase" | "walk" | "channel" | "flag" | "hold";

export interface ScanLogLine {
  /** Stable across re-renders and across a replay — never an array index. */
  key: string;
  kind: ScanLogKind;
  /** Left gutter: a walk ordinal, a channel ordinal, or a rule of dots. */
  gutter: string;
  text: string;
  /** Right-aligned measurement, where the line has one. */
  trailing?: string;
}

export interface ScanLogInput {
  session: DiagSession | null;
  link: ScanLink;
  /** True once the verdict has landed. */
  complete: boolean;
}

const GUTTER_RULE = "····";

export function buildScanLog({ session, link, complete }: ScanLogInput): ScanLogLine[] {
  const lines: ScanLogLine[] = [];
  if (!session) return lines;

  lines.push({
    key: "p:start",
    kind: "phase",
    gutter: GUTTER_RULE,
    text: "SCAN START · SUBSYSTEM TREE",
  });

  session.walkLines.forEach((path, i) => {
    lines.push({
      key: `w:${path}`,
      kind: "walk",
      gutter: pad4(i + 1),
      text: path,
    });
  });

  if (session.channels.length > 0) {
    lines.push({
      key: "p:sweep",
      kind: "phase",
      gutter: GUTTER_RULE,
      text: "CHANNEL SWEEP BEGIN · ACTUATOR BUS",
    });
  }

  const flag = session.flag;
  session.channels.forEach((channel, i) => {
    lines.push({
      key: `c:${channel.joint}`,
      kind: "channel",
      gutter: `CH${pad2(i + 1)}`,
      text: machineJoint(channel.joint),
      // What the log says about a channel is that it arrived and how much of
      // it there was. What it *measured* is in the readout under the traces
      // (channel-readout.tsx), where the number sits beside the picture it
      // describes instead of two columns away from it.
      trailing: `${channel.wave.length} SMPL`,
    });

    // The flag belongs immediately after its own channel — the one ordering
    // fact the store flattens away, restored from the tested invariant.
    if (flag && flag.joint === channel.joint) {
      lines.push(flagLine(flag.joint, flag.component, flag.anomaly));
    }
  });

  // A flag whose channel is not in the session (a prefix replayed out of order,
  // or a future choreography that flags before it measures) still gets said.
  if (flag && !session.channels.some((c) => c.joint === flag.joint)) {
    lines.push(flagLine(flag.joint, flag.component, flag.anomaly));
  }

  if (complete && session.report) {
    lines.push({
      key: "p:verdict",
      kind: "phase",
      gutter: GUTTER_RULE,
      text: `VERDICT LOGGED · ${session.report.anomaly === "none" ? "NO ANOMALY" : machineComponent(session.report.component)}`,
    });
  }

  // Last, always: the hold is about *now*, so it belongs at the tail the log
  // is following, under whatever the scan had managed to say before the drop.
  if (link !== "open") {
    lines.push({
      key: "hold",
      kind: "hold",
      gutter: GUTTER_RULE,
      text:
        link === "lost"
          ? "HOLD — LINK LOST · SEQUENCE SUSPENDED"
          : "HOLD — LINK RESTORED · AWAITING SEQUENCE",
    });
  }

  return lines;
}

function flagLine(joint: string, component: string, anomaly: string): ScanLogLine {
  return {
    key: "flag",
    kind: "flag",
    gutter: "!!!!",
    // Sized to fit the log column. The long form ellipsised the component id,
    // which is the one thing on the line the whole incident is about — so the
    // line gives up the words it can afford to lose instead.
    text: `DIVERGENCE · ${machineJoint(joint)} · ${component.replace(/^actuator_/i, "").toUpperCase()} ${anomaly.toUpperCase()}`,
  };
}
