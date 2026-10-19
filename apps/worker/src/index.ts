import { Worker } from "bullmq";
import fs from "fs";
import path from "path";
import { selectEngine } from "@uab/engines";
import { getRedis, getJob, updateJob, appendLog } from "./store";
import type { BuildRequest, BuildContext } from "@uab/shared";

const DATA_DIR = process.env.DATA_DIR || "/tmp/opencode/uab-data";
const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const redisConnection = { host: process.env.REDIS_HOST || "127.0.0.1", port: Number(process.env.REDIS_PORT || 6379) };

const worker = new Worker("builds", async (job) => {
  const data = job.data as any;
  const { jobId, sourceDir, workDir, detection, advanced } = data;
  const j = await getJob(jobId);
  if (!j) throw new Error("Job not found");

  const engine = selectEngine(detection);
  if (!engine) {
    await updateJob(jobId, { status: "failed", error: "No suitable engine", progress: 100 });
    throw new Error("No engine");
  }

  // environment check
  const envCheck = await engine.checkEnvironment();
  if (!envCheck.ok) {
    const msg = `Missing tools: ${envCheck.missing.join(", ")}`;
    await appendLog(jobId, msg);
    await updateJob(jobId, { status: "failed", error: msg, progress: 100 });
    throw new Error(msg);
  }

  await updateJob(jobId, { status: "installing", progress: 25 });

  const ctx: BuildContext = {
    log: (line: string) => { appendLog(jobId, line).catch(() => {}); },
    progress: (p: number, stage?: string) => {
      const statusMap: Record<string, any> = {
        installing: "installing", building: "building", signing: "signing",
      };
      const status = stage && statusMap[stage] ? statusMap[stage] : undefined;
      const patch: any = { progress: p };
      if (status) patch.status = status;
      updateJob(jobId, patch).catch(() => {});
    },
    signal: new AbortController().signal,
  };

  const req: BuildRequest = { jobId, sourceDir, workDir, detection, advanced };
  await appendLog(jobId, `Using engine: ${engine.name}`);
  await updateJob(jobId, { status: "building", progress: 30 });

  const result = await engine.build(req, ctx);

  if (!result.success || !result.artifactPath) {
    await appendLog(jobId, result.error || "Build failed");
    await updateJob(jobId, { status: "failed", error: result.error || "Build failed", progress: 100, logs: result.logs });
    throw new Error(result.error || "Build failed");
  }

  // copy artifact
  const ext = path.extname(result.artifactPath);
  const artifactName = `${jobId}${ext || ".apk"}`;
  const artifactPath = path.join(ARTIFACT_DIR, artifactName);
  fs.copyFileSync(result.artifactPath, artifactPath);

  const buildTimeMs = Date.now() - (j.createdAt || Date.now());
  await updateJob(jobId, {
    status: "completed",
    progress: 100,
    artifactPath,
    artifactSize: result.artifactSize || fs.statSync(artifactPath).size,
    buildTimeMs,
    logs: result.logs,
  });
  await appendLog(jobId, `Build completed: ${artifactPath}`);
}, { connection: redisConnection, concurrency: 2 });

worker.on("failed", (job, err) => {
  console.error("Job failed", job?.id, err.message);
});

console.log("Worker started");
