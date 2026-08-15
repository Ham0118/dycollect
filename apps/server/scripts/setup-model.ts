import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import {
  HF_CACHE_DIR,
  PROJECT_ROOT,
  QWEN_ASR_MODEL_DIR,
  QWEN_ASR_PYTHON,
} from "../src/config.js";

const PYTHON_DIR = resolve(PROJECT_ROOT, ".uv-python");
const UV_CACHE_DIR = resolve(PROJECT_ROOT, ".uv-cache");
const VENV_DIR = resolve(PROJECT_ROOT, ".venv-qwen-asr");
const PYTHON_SOURCES = resolve(PROJECT_ROOT, "apps", "server", "python");
const REQUIREMENTS = resolve(PYTHON_SOURCES, "requirements.txt");
const VERIFY_SCRIPT = resolve(PYTHON_SOURCES, "verify_qwen_runtime.py");
const DOWNLOAD_SCRIPT = resolve(PYTHON_SOURCES, "download_qwen_model.py");
type SetupDevice = "auto" | "cpu" | "cuda" | "mps";

const requestedDevice = parseDevice(process.argv.slice(2));
const installDevice = resolveInstallDevice(requestedDevice);

const childEnvironment = {
  ...process.env,
  HF_HOME: HF_CACHE_DIR,
  UV_CACHE_DIR,
  UV_PYTHON_INSTALL_DIR: PYTHON_DIR,
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
};

await run("uv", ["python", "install", "3.12"]);
await run("uv", ["venv", "--python", "3.12", "--allow-existing", VENV_DIR]);
const torchArgs = [
  "pip",
  "install",
  "--python",
  QWEN_ASR_PYTHON,
  "--reinstall-package",
  "torch",
  "torch==2.13.0",
];
if (process.platform !== "darwin") {
  torchArgs.push(
    "--default-index",
    installDevice === "cuda"
      ? "https://download.pytorch.org/whl/cu126"
      : "https://download.pytorch.org/whl/cpu",
  );
}
console.log(`正在安装 ${installDevice.toUpperCase()} 转录运行时……`);
await run("uv", torchArgs);
await run("uv", ["pip", "install", "--python", QWEN_ASR_PYTHON, "-r", REQUIREMENTS]);
await run(QWEN_ASR_PYTHON, [
  VERIFY_SCRIPT,
  "--device",
  verificationDevice(requestedDevice, installDevice),
  "--strict",
]);

if (!await exists(resolve(QWEN_ASR_MODEL_DIR, "model.safetensors"))) {
  console.log("正在下载 Qwen3-ASR-0.6B-hf，首次准备约需下载 1.6 GB……");
}
await run(QWEN_ASR_PYTHON, [
  DOWNLOAD_SCRIPT,
  "--destination",
  QWEN_ASR_MODEL_DIR,
  "--cache",
  HF_CACHE_DIR,
]);

console.log(`Qwen3-ASR ${verificationDevice(requestedDevice, installDevice).toUpperCase()} 运行环境已准备完成。`);

function parseDevice(args: string[]): SetupDevice {
  const inline = args.find((item) => item.startsWith("--device="))?.slice("--device=".length);
  const index = args.indexOf("--device");
  const value = inline ?? (index >= 0 ? args[index + 1] : undefined) ?? "auto";
  if (!["auto", "cpu", "cuda", "mps"].includes(value)) {
    throw new Error("--device 必须是 auto、cpu、cuda 或 mps");
  }
  return value as SetupDevice;
}

function resolveInstallDevice(requested: SetupDevice): Exclude<SetupDevice, "auto"> {
  if (requested === "cuda" && process.platform === "darwin") {
    throw new Error("macOS 不支持 NVIDIA CUDA，请使用 auto、cpu 或 mps");
  }
  if (requested === "mps" && process.platform !== "darwin") {
    throw new Error("MPS 只适用于 macOS，请使用 auto、cpu 或 cuda");
  }
  if (requested !== "auto") return requested;
  if (process.platform === "darwin") return "mps";
  const result = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0 ? "cuda" : "cpu";
}

function verificationDevice(
  requested: SetupDevice,
  installed: Exclude<SetupDevice, "auto">,
): SetupDevice {
  return requested === "auto" && process.platform === "darwin" ? "auto" : installed;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: childEnvironment,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", (error) => rejectRun(new Error(`无法启动 ${command}：${error.message}`)));
    child.once("close", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} 执行失败，退出码 ${code ?? "未知"}`));
    });
  });
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}
