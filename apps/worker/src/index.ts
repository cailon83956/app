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

  // upload to Gofile for a shareable link
  let shareLink: string | undefined;
  try {
    ctx.log("Uploading artifact to Gofile for shareable link...");
    const serverRes = await fetch("https://api.gofile.io/servers");
    const serverJson: any = await serverRes.json();
    const server = serverJson?.data?.servers?.[0]?.name;
    if (server) {
      const buf = fs.readFileSync(artifactPath);
      const blob = new Blob([buf], { type: "application/vnd.android.package-archive" });
      const form = new FormData();
      form.append("file", blob, path.basename(artifactPath));
      const upRes = await fetch(`https://${server}.gofile.io/uploadFile`, { method: "POST", body: form });
      const upJson: any = await upRes.json();
      if (upJson?.status === "ok" && upJson?.data?.downloadPage) {
        shareLink = upJson.data.downloadPage;
        ctx.log(`Gofile link: ${shareLink}`);
      } else {
        ctx.log(`Gofile upload unexpected response: ${JSON.stringify(upJson).slice(0,200)}`);
      }
    } else {
      ctx.log("Gofile getServer failed.");
    }
  } catch (e: any) {
    ctx.log(`Gofile upload failed: ${e?.message || e}`);
  }

  const buildTimeMs = Date.now() - (j.createdAt || Date.now());
  await updateJob(jobId, {
    status: "completed",
    progress: 100,
    artifactPath,
    artifactSize: result.artifactSize || fs.statSync(artifactPath).size,
    buildTimeMs,
    shareLink,
    logs: result.logs,
  });
  await appendLog(jobId, `Build completed: ${artifactPath}`);
}, { connection: redisConnection, concurrency: 2 });

worker.on("failed", (job, err) => {
  console.error("Job failed", job?.id, err.message);
});

console.log("Worker started");
