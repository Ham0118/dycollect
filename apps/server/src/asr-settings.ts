import { execFile } from "node:child_process";
import type { AsrConcreteDevice, AsrDevice, AsrSettingsView } from "@dycollect/shared";
import { QWEN_ASR_PYTHON, QWEN_ASR_VERIFY_SCRIPT } from "./config.js";
import type { DyCollectDatabase } from "./db.js";
import { AppError } from "./errors.js";
import { shutdownQwenAsr } from "./qwen-asr.js";

const DEVICES = new Set<AsrDevice>(["auto", "cpu", "cuda", "mps"]);

interface RuntimeProbe {
  requestedDevice: AsrDevice;
  resolvedDevice: AsrConcreteDevice | null;
  availableDevices: AsrConcreteDevice[];
  diagnostic: string | null;
}

export class AsrSettingsService {
  constructor(
    private readonly database: Pick<DyCollectDatabase, "getAsrDevice" | "saveAsrDevice">,
    private readonly probe: (device: AsrDevice) => Promise<RuntimeProbe> = probeAsrRuntime,
    private readonly resetProcess: () => void = shutdownQwenAsr,
  ) {}

  async getView(): Promise<AsrSettingsView> {
    const selectedDevice = this.database.getAsrDevice();
    const result = await this.probe(selectedDevice);
    return {
      selectedDevice,
      resolvedDevice: result.resolvedDevice,
      availableDevices: result.availableDevices,
      diagnostic: result.diagnostic,
    };
  }

  async saveDevice(device: AsrDevice): Promise<AsrSettingsView> {
    if (!DEVICES.has(device)) throw new AppError("parse_error", "转录设备设置无效");
    const result = await this.probe(device);
    if (!result.resolvedDevice) {
      throw new AppError(
        "asr_device_unavailable",
        result.diagnostic ?? `当前运行环境不支持 ${device.toUpperCase()}`,
      );
    }
    this.database.saveAsrDevice(device);
    this.resetProcess();
    return {
      selectedDevice: device,
      resolvedDevice: result.resolvedDevice,
      availableDevices: result.availableDevices,
      diagnostic: result.diagnostic,
    };
  }
}

export function isAsrDevice(value: unknown): value is AsrDevice {
  return typeof value === "string" && DEVICES.has(value as AsrDevice);
}

export function probeAsrRuntime(device: AsrDevice): Promise<RuntimeProbe> {
  return new Promise((resolveProbe) => {
    execFile(
      QWEN_ASR_PYTHON,
      [QWEN_ASR_VERIFY_SCRIPT, "--device", device],
      { windowsHide: true, timeout: 30_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        try {
          const parsed = JSON.parse(stdout.trim()) as Partial<RuntimeProbe>;
          resolveProbe({
            requestedDevice: device,
            resolvedDevice: parsed.resolvedDevice ?? null,
            availableDevices: Array.isArray(parsed.availableDevices)
              ? parsed.availableDevices.filter((item): item is AsrConcreteDevice => ["cpu", "cuda", "mps"].includes(item))
              : [],
            diagnostic: parsed.diagnostic ?? null,
          });
        } catch {
          const detail = (stderr || error?.message || "Python 转录环境不可用")
            .replace(/[\r\n]+/g, " ")
            .trim()
            .slice(-500);
          resolveProbe({
            requestedDevice: device,
            resolvedDevice: null,
            availableDevices: [],
            diagnostic: `无法检查转录设备：${detail}`,
          });
        }
      },
    );
  });
}
