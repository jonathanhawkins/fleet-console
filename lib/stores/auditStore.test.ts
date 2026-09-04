// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  FLEET_AUDIT_SCOPE,
  OPERATOR,
  selectAuditLog,
  selectUnitAuditLog,
  useAuditStore,
  type AuditEntry,
} from "./auditStore";

const entry = (over: Partial<Omit<AuditEntry, "id">> = {}): Omit<AuditEntry, "id"> => ({
  ts: 1000,
  kind: "alert-raised",
  unitId: "N-07",
  summary: "Sagebrush House: left knee actuator running hot",
  ref: "al-001",
  ...over,
});

beforeEach(() => {
  useAuditStore.getState().reset();
});

describe("audit store — append-only session log", () => {
  it("appends newest first with session-unique ids", () => {
    const s = () => useAuditStore.getState();
    s().append(entry({ ts: 1000, ref: "al-001" }));
    s().append(
      entry({ ts: 2000, kind: "alert-acked", summary: "Acknowledged by Operator" }),
    );
    const log = selectAuditLog(s());
    expect(log.map((e) => e.kind)).toEqual(["alert-acked", "alert-raised"]);
    expect(log.map((e) => e.id)).toEqual(["audit-2", "audit-1"]);
  });

  it("dedupes replayed facts by (kind, ref) — and only by that pair", () => {
    const s = () => useAuditStore.getState();
    s().append(entry({ kind: "alert-raised", ref: "al-001" }));
    s().append(entry({ kind: "alert-raised", ref: "al-001" })); // replay: dropped
    s().append(entry({ kind: "escalation", ref: "al-001" })); // same ref, other kind: admitted
    s().append(entry({ kind: "alert-raised", ref: "al-002" })); // other ref: admitted
    expect(selectAuditLog(s()).map((e) => e.kind)).toEqual([
      "alert-raised",
      "escalation",
      "alert-raised",
    ]);
  });

  it("admits ref-less entries unconditionally (their producers dedupe)", () => {
    const s = () => useAuditStore.getState();
    const diagStart: Omit<AuditEntry, "id"> = {
      ts: 1000,
      kind: "diag-start",
      unitId: "N-07",
      summary: "Diagnostic scan started",
    };
    s().append(diagStart);
    s().append(diagStart);
    expect(selectAuditLog(s())).toHaveLength(2);
  });

  it("returns identity for a deduped append — no re-render for subscribers", () => {
    const s = () => useAuditStore.getState();
    s().append(entry());
    const before = selectAuditLog(useAuditStore.getState());
    s().append(entry());
    expect(selectAuditLog(useAuditStore.getState())).toBe(before);
  });

  it("filters one unit's log (fresh array — useShallow in React)", () => {
    const s = () => useAuditStore.getState();
    s().append(entry({ unitId: "N-07", ref: "al-001" }));
    s().append(entry({ unitId: "N-03", ref: "al-002" }));
    s().append(entry({ unitId: "N-07", kind: "alert-acked", ref: "al-001" }));
    expect(selectUnitAuditLog("N-07")(s()).map((e) => e.kind)).toEqual([
      "alert-acked",
      "alert-raised",
    ]);
    expect(selectUnitAuditLog("N-99")(s())).toEqual([]);
  });
});

describe("attribution", () => {
  /**
   * The field is optional in the type and never absent in the store — that
   * promise is kept here rather than by the compiler, because requiring it of
   * every producer would make a dozen call sites answer a question they have
   * no better answer to than this default.
   */
  it("attributes every entry, whether or not the producer said so", () => {
    const audit = useAuditStore.getState();
    audit.append({ ts: 1, kind: "alert-raised", unitId: "N-07", summary: "hot" });
    audit.append({
      ts: 2,
      kind: "rollout-halted",
      unitId: FLEET_AUDIT_SCOPE,
      summary: "halted",
    });
    audit.append({
      ts: 3,
      kind: "command-accepted",
      unitId: "N-07",
      summary: "SAFE SIT accepted",
      actor: OPERATOR,
    });

    const entries = useAuditStore.getState().entries;
    expect(entries.every((e) => e.actor !== undefined)).toBe(true);

    const byKind = Object.fromEntries(entries.map((e) => [e.kind, e.actor]));
    // Unattributed and about a unit: the robot said it.
    expect(byKind["alert-raised"]).toEqual({ kind: "unit", unitId: "N-07" });
    // Unattributed and fleet-scoped: nobody's hand was on it at that instant.
    expect(byKind["rollout-halted"]).toEqual({ kind: "system" });
    // Attributed: the operator pressed something.
    expect(byKind["command-accepted"]).toEqual({ kind: "operator", label: "Operator" });
  });
});
