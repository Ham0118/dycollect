import { describe, expect, it, vi } from "vitest";
import type { AsrDevice } from "@dycollect/shared";
import { AsrSettingsService, isAsrDevice } from "./asr-settings.js";

describe("ASR settings", () => {
  it("validates public device values", () => {
    expect(["auto", "cpu", "cuda", "mps"].every(isAsrDevice)).toBe(true);
    expect(isAsrDevice("metal")).toBe(false);
  });

  it("persists a supported device and resets the resident process", async () => {
    let selected: AsrDevice = "auto";
    const database = {
      getAsrDevice: vi.fn(() => selected),
      saveAsrDevice: vi.fn((device: AsrDevice) => { selected = device; return device; }),
    };
    const reset = vi.fn();
    const service = new AsrSettingsService(database, vi.fn(async (device) => ({
      requestedDevice: device,
      resolvedDevice: device === "auto" ? "cuda" : device as "cpu" | "cuda" | "mps",
      availableDevices: ["cuda", "cpu"] as Array<"cuda" | "cpu">,
      diagnostic: null,
    })), reset);

    await expect(service.saveDevice("cpu")).resolves.toMatchObject({ selectedDevice: "cpu", resolvedDevice: "cpu" });
    expect(database.saveAsrDevice).toHaveBeenCalledWith("cpu");
    expect(reset).toHaveBeenCalledOnce();
  });

  it("does not persist an unavailable device", async () => {
    const database = { getAsrDevice: vi.fn(() => "auto" as const), saveAsrDevice: vi.fn() };
    const service = new AsrSettingsService(database, vi.fn(async () => ({
      requestedDevice: "mps" as const,
      resolvedDevice: null,
      availableDevices: ["cpu" as const],
      diagnostic: "当前环境不支持 MPS",
    })), vi.fn());
    await expect(service.saveDevice("mps")).rejects.toThrow("当前环境不支持 MPS");
    expect(database.saveAsrDevice).not.toHaveBeenCalled();
  });
});
