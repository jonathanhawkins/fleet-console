// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
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
