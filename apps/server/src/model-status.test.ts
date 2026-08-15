import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelStatusService,
  QWEN_ASR_MODEL_BYTES,
  QWEN_ASR_REQUIRED_FILES,
} from "./model-status.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function modelDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dycollect-model-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("ModelStatusService", () => {
  it("reports a missing model without leaking its directory", async () => {
    const directory = await modelDirectory();
    const status = await new ModelStatusService(directory, 0).getStatus();
    expect(status.state).toBe("missing");
    expect(status.missingFiles).toContain("model.safetensors");
    expect(JSON.stringify(status)).not.toContain(directory);
  });

  it("reports a partial or wrong-sized model as incomplete", async () => {
    const directory = await modelDirectory();
    await writeFile(join(directory, "model.safetensors"), "partial");
    const status = await new ModelStatusService(directory, 0).getStatus();
    expect(status.state).toBe("incomplete");
    expect(status.missingFiles).toContain("model.safetensors");
  });

  it("accepts the complete runtime file set", async () => {
    const directory = await modelDirectory();
    await Promise.all(QWEN_ASR_REQUIRED_FILES.map((file) => writeFile(join(directory, file), "ok")));
    await truncate(join(directory, "model.safetensors"), QWEN_ASR_MODEL_BYTES);
    const status = await new ModelStatusService(directory, 0).getStatus();
    expect(status).toMatchObject({ state: "ready", missingFiles: [] });
  });
});
