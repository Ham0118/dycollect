const args = process.argv.slice(2);
const command = args.shift();

if (command !== "crawl") {
  console.log('用法：npm run cli -- crawl --profile "<抖音主页URL>" --count 20 [--wait] [--retry-permanent]');
  process.exitCode = 1;
} else {
  const valueAfter = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const profileUrl = valueAfter("--profile");
  const targetCount = Number(valueAfter("--count"));
  if (!profileUrl || !Number.isInteger(targetCount)) {
    console.error("缺少 --profile 或有效的 --count");
    process.exitCode = 1;
  } else {
    const baseUrl = process.env.DYCOLLECT_URL ?? "http://127.0.0.1:3210";
    const response = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileUrl, targetCount, retryPermanent: args.includes("--retry-permanent") }),
    }).catch(() => null);
    if (!response?.ok) {
      console.error(response ? await response.text() : "无法连接 DyCollect，请先运行 npm start");
      process.exitCode = 1;
    } else {
      const job = await response.json() as { id: number; status: string };
      console.log(`任务已提交：#${job.id}`);
      if (args.includes("--wait")) {
        while (true) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
          const statusResponse = await fetch(`${baseUrl}/api/jobs/${job.id}`);
          const current = await statusResponse.json() as {
            status: string; processedCount: number; completedCount: number; targetCount: number; failedCount: number;
          };
          console.log(`[${current.status}] 已处理 ${current.processedCount}/${current.targetCount}，成功 ${current.completedCount}，失败 ${current.failedCount}`);
          if (["completed", "completed_partial", "cancelled", "failed"].includes(current.status)) break;
        }
      }
    }
  }
}

export {};
