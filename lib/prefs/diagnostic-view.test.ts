// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTIC_VIEW_KEY,
  readDiagnosticView,
  setDiagnosticView,
  useDiagnosticView,
} from "./diagnostic-view";

/**
 * The preference that decides which way a scan opens.
 *
 * Most of what it owes is refusal: the slot it reads is a boundary like any
 * other, and every path out of it has to end in one of the two views the
 * surfaces downstream can actually mount. A third value would not degrade —
 * it would mount nothing.
 */

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  // Only the slot is reset. Notifying here would push an update into whatever
  // this test left mounted, which is a warning about the test, not the module.
  window.localStorage.clear();
});

describe("readDiagnosticView", () => {
  it("is calm with nothing stored", () => {
    expect(readDiagnosticView()).toBe("calm");
  });

  it("returns a stored view", () => {
    window.localStorage.setItem(DIAGNOSTIC_VIEW_KEY, "machine");
    expect(readDiagnosticView()).toBe("machine");
  });

  it("reads anything else as the default", () => {
    for (const junk of ["", "MACHINE", "dark", "{}", "null"]) {
      window.localStorage.setItem(DIAGNOSTIC_VIEW_KEY, junk);
      expect(readDiagnosticView()).toBe("calm");
    }
  });

  it("survives a storage that throws on access", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readDiagnosticView()).toBe("calm");
  });
});

describe("setDiagnosticView", () => {
  it("round-trips through storage", () => {
    setDiagnosticView("machine");
    expect(window.localStorage.getItem(DIAGNOSTIC_VIEW_KEY)).toBe("machine");
    expect(readDiagnosticView()).toBe("machine");
  });

  it("still notifies when the write fails", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useDiagnosticView());
    act(() => setDiagnosticView("machine"));
    // The preference loses its memory, not its effect.
    expect(result.current).toBe("machine");
  });
});

describe("useDiagnosticView", () => {
  it("starts from what is stored", () => {
    window.localStorage.setItem(DIAGNOSTIC_VIEW_KEY, "machine");
    const { result } = renderHook(() => useDiagnosticView());
    expect(result.current).toBe("machine");
  });

  it("moves every subscriber, not only the one that set it", () => {
    const a = renderHook(() => useDiagnosticView());
    const b = renderHook(() => useDiagnosticView());
    act(() => setDiagnosticView("machine"));
    expect(a.result.current).toBe("machine");
    expect(b.result.current).toBe("machine");
  });

  it("follows a write from another tab", () => {
    const { result } = renderHook(() => useDiagnosticView());
    act(() => {
      window.localStorage.setItem(DIAGNOSTIC_VIEW_KEY, "machine");
      window.dispatchEvent(new StorageEvent("storage", { key: DIAGNOSTIC_VIEW_KEY }));
    });
    expect(result.current).toBe("machine");
  });

  it("unsubscribes on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    renderHook(() => useDiagnosticView()).unmount();
    expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
  });
});
