import Fastify from "fastify";
import multipart from "@fastify/multipart";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import os from "os";
import { detectProject } from "@uab/detection";
import { validateZip } from "@uab/security";
import type { JobRecord, DetectionResult } from "@uab/shared";
import { getRedis, saveJob, getJob, listJobs, updateJob, appendLog } from "./store";

const DATA_DIR = process.env.DATA_DIR || "/tmp/opencode/uab-data";
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const ARTIFACT_DIR = path.join(DATA_DIR, "artifacts");
const WORK_DIR = path.join(DATA_DIR, "work");
for (const d of [DATA_DIR, UPLOAD_DIR, ARTIFACT_DIR, WORK_DIR]) fs.mkdirSync(d, { recursive: true });

const redisConnection = { host: process.env.REDIS_HOST || "127.0.0.1", port: Number(process.env.REDIS_PORT || 6379) };
const buildQueue = new Queue("builds", { connection: redisConnection });

const app = Fastify({ logger: true });

app.register(cors, { origin: true });
app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

// Serve built frontend if present
const webDistCandidates = [
  path.join(__dirname, "..", "..", "web", "dist"),
  path.join(process.cwd(), "apps", "web", "dist"),
  path.join(process.cwd(), "..", "web", "dist"),
];
const webDist = webDistCandidates.find((p) => fs.existsSync(p));
if (webDist) app.register(staticPlugin, { root: webDist });

app.get("/api/health", async () => ({ ok: true, time: Date.now() }));

app.get("/api/tools", async () => {
  const { execSync } = require("child_process");
  const tools = ["node", "npm", "java", "gradle", "flutter", "cordova"];
  const res: Record<string, string | null> = {};
  for (const t of tools) {
    try { res[t] = execSync(`command -v ${t}`, { encoding: "utf8" }).trim(); } catch { res[t] = null; }
  }
  res["android-sdk"] = process.env.ANDROID_HOME || (fs.existsSync("/opt/android-sdk") ? "/opt/android-sdk" : null);
  return res;
});

app.post("/api/jobs", async (req, reply) => {
  const data = await req.file();
  if (!data) { reply.code(400); return { error: "No file uploaded" }; }
  const jobId = uuidv4();
  const filename = data.filename || "source.zip";
  const zipPath = path.join(UPLOAD_DIR, `${jobId}.zip`);
  const ws = fs.createWriteStream(zipPath);
  await new Promise<void>((resolve, reject) => {
    data.file.pipe(ws);
    data.file.on("end", resolve);
    data.file.on("error", reject);
    ws.on("error", reject);
  });

  // validate zip
  const v = await validateZip(zipPath);
  if (!v.ok) {
    fs.unlinkSync(zipPath);
    reply.code(400);
    return { error: "Invalid ZIP", details: v.errors };
  }

  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  let sourceDir = path.join(jobDir, "source");
  fs.mkdirSync(sourceDir, { recursive: true });

  // extract
  const unzipper = require("unzipper");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: sourceDir }))
      .on("close", resolve).on("error", reject);
  });

  // detect
  const detection: DetectionResult = detectProject(sourceDir);
  // adjust sourceDir if project is nested
  if (detection.projectRoot && detection.projectRoot !== ".") {
    sourceDir = path.join(sourceDir, detection.projectRoot);
  }

  const job: JobRecord = {
    id: jobId,
    filename,
    size: fs.statSync(zipPath).size,
    status: "analyzing",
    progress: 10,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    detection,
    logs: [],
  };
  await saveJob(job);

  // if unsupported
  if (detection.unsupportedReason) {
    job.status = "failed";
    job.error = detection.unsupportedReason;
    job.progress = 100;
    await saveJob(job);
    return { jobId, detection, status: "failed" };
  }

  // enqueue
  const workDir = path.join(jobDir, "build");
  fs.mkdirSync(workDir, { recursive: true });
  job.status = "queued";
  job.progress = 20;
  await saveJob(job);
  await buildQueue.add("build", { jobId, sourceDir, workDir, detection }, { jobId });

  return { jobId, detection, status: "queued" };
});

app.get("/api/jobs", async () => {
  return await listJobs();
});

app.get("/api/jobs/:id", async (req, reply) => {
  const { id } = req.params as any;
  const job = await getJob(id);
  if (!job) { reply.code(404); return { error: "Not found" }; }
  return job;
});

app.get("/api/jobs/:id/events", async (req, reply) => {
  const { id } = req.params as any;
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  let last = "";
  const interval = setInterval(async () => {
    const job = await getJob(id);
    if (!job) { reply.raw.write(`event: error\ndata: not found\n\n`); return; }
    const payload = JSON.stringify(job);
    if (payload !== last) {
      reply.raw.write(`data: ${payload}\n\n`);
      last = payload;
    }
    if (job.status === "completed" || job.status === "failed") {
      clearInterval(interval);
      reply.raw.end();
    }
  }, 800);
  req.raw.on("close", () => clearInterval(interval));
});

app.get("/api/jobs/:id/download", async (req, reply) => {
  const { id } = req.params as any;
  const job = await getJob(id);
  if (!job || job.status !== "completed" || !job.artifactPath) {
    reply.code(404); return { error: "Artifact not ready" };
  }
  if (!fs.existsSync(job.artifactPath)) { reply.code(404); return { error: "File missing" }; }
  const stream = fs.createReadStream(job.artifactPath);
  reply.header("Content-Disposition", `attachment; filename="${path.basename(job.artifactPath)}"`);
  reply.header("Content-Type", "application/vnd.android.package-archive");
  return reply.send(stream);
});

app.delete("/api/jobs/:id", async (req, reply) => {
  const { id } = req.params as any;
  const job = await getJob(id);
  if (!job) { reply.code(404); return { error: "Not found" }; }
  // cleanup
  const jobDir = path.join(WORK_DIR, id);
  try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(path.join(UPLOAD_DIR, `${id}.zip`)); } catch {}
  await getRedis().del(`job:${id}`);
  await getRedis().zrem("jobs:index", id);
  return { ok: true };
});

const port = Number(process.env.PORT || 3001);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`API listening on ${port}`);
});
