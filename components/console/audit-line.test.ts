import { describe, expect, it } from "vitest";
import { type AuditEntry, type AuditKind } from "@/lib/stores";
import { AUDIT_TAG, auditLine } from "./audit-line";

/**
 * The session log is a record, so the default is to print what the store
 * wrote. These tests pin the three exceptions and the reason for each: the two
 * entries that arrive in the wire's or the machine's voice, and the command
 * refs that arrive as command names.
 */

function entry(over: Partial<AuditEntry> & Pick<AuditEntry, "kind">): AuditEntry {
  return {
    id: "audit-1",
    ts: 1_700_000_000_000,
    unitId: "N-07",
    summary: "",
    ...over,
  };
}

describe("auditLine", () => {
  it("prints operator-voice entries verbatim — a log that paraphrases cannot be cited", () => {
    expect(
      auditLine(entry({ kind: "alert-acked", summary: "Acknowledged by Operator" })),
    ).toBe("Acknowledged by Operator");
    expect(
      auditLine(
        entry({ kind: "resolution", summary: "Resolved — diagnostic incident logged" }),
      ),
    ).toBe("Resolved — diagnostic incident logged");
    expect(
      auditLine(entry({ kind: "diag-start", summary: "Diagnostic scan started" })),
    ).toBe("Diagnostic scan started");
  });

  it("trims the house prefix the wire puts on every alert, and re-capitalises", () => {
    const line = auditLine(
      entry({
        kind: "alert-raised",
        summary: "Sagebrush House: left knee actuator running hot",
      }),
      "Sagebrush House",
    );
    expect(line).toBe("Left knee actuator running hot");
  });

  it("leaves the message alone when the name does not match, rather than guessing", () => {
    const summary = "Sagebrush House: left knee actuator running hot";
    expect(auditLine(entry({ kind: "alert-raised", summary }), "Juniper House")).toBe(
      summary,
    );
    expect(auditLine(entry({ kind: "alert-raised", summary }))).toBe(summary);
  });

  it("says escalation in the severity words operator space actually uses", () => {
    // The store writes "Escalated amber → red"; amber and red are the wire's
    // vocabulary and have never been shown to an operator.
    const line = auditLine(
      entry({ kind: "escalation", summary: "Escalated amber → red" }),
    );
    expect(line).toBe("Escalated to alert");
    expect(line).not.toMatch(/amber|red/);
  });

  it("keeps the machine's verdict summary out of operator space", () => {
    const line = auditLine(
      entry({
        kind: "diag-verdict",
        summary: "LIVE TRACE 1.4-1.8x REFERENCE ENVELOPE",
        ref: "inc-N-07-1700000000000",
      }),
    );
    expect(line).toBe("Diagnostic verdict recorded");
  });

  /**
   * One row can stand for several entries; when it does it has to say
   * so, and it has to say so in the store's own sentence rather than in a
   * second copy table that could drift from it.
   */
  it("splices the count into the store's own sentence when a row stands for several", () => {
    const closed = entry({
      kind: "resolution",
      summary: "Resolved — diagnostic incident logged",
    });
    expect(auditLine(closed, undefined, 2)).toBe(
      "Resolved 2 alerts — diagnostic incident logged",
    );
    expect(auditLine(closed, undefined, 3)).toBe(
      "Resolved 3 alerts — diagnostic incident logged",
    );
    // A resolution reason this file has never heard of still reads correctly.
    expect(
      auditLine(
        entry({ kind: "resolution", summary: "Resolved by operator" }),
        undefined,
        2,
      ),
    ).toBe("Resolved 2 alerts by operator");
  });

  it("says nothing about counts at one — the ordinary line is the default", () => {
    const closed = entry({
      kind: "resolution",
      summary: "Resolved — diagnostic incident logged",
    });
    expect(auditLine(closed)).toBe("Resolved — diagnostic incident logged");
    expect(auditLine(closed, undefined, 1)).toBe("Resolved — diagnostic incident logged");
  });

  it("names a command from its ref, so a new command needs no edit here", () => {
    expect(
      auditLine(entry({ kind: "command-accepted", ref: "COMMAND_SAFE_SIT#3" })),
    ).toBe("Safe sit accepted");
    expect(
      auditLine(entry({ kind: "command-complete", ref: "COMMAND_SAFE_SIT#7" })),
    ).toBe("Safe sit complete");
    expect(auditLine(entry({ kind: "command-failed", ref: "COMMAND_SAFE_SIT#4" }))).toBe(
      "Safe sit refused",
    );
  });
});

describe("AUDIT_TAG", () => {
  const kinds: AuditKind[] = [
    "alert-raised",
    "alert-acked",
    "escalation",
    "resolution",
    "diag-start",
    "diag-verdict",
    "command-accepted",
    "command-complete",
    "command-failed",
  ];

  it("names every kind the store can append — no unlabelled row is possible", () => {
    for (const kind of kinds) {
      expect(AUDIT_TAG[kind].label).toBeTruthy();
    }
  });

  it("spends colour only on the two directions a situation can move", () => {
    expect(AUDIT_TAG.escalation.tone).toBe("alert");
    expect(AUDIT_TAG["command-failed"].tone).toBe("alert");
    expect(AUDIT_TAG.resolution.tone).toBe("nominal");
    // Everything else is muted: the tags name kinds, not severities, and an
    // `alert-raised` entry carries no severity to colour honestly from.
    expect(AUDIT_TAG["alert-raised"].tone).toBe("muted");
    expect(AUDIT_TAG["diag-verdict"].tone).toBe("muted");
  });
});
