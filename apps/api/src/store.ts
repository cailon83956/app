import Redis from "ioredis";
import type { JobRecord } from "@uab/shared";

const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

export function getRedis() { return redis; }

export async function saveJob(job: JobRecord) {
  await redis.set(`job:${job.id}`, JSON.stringify(job));
  await redis.zadd("jobs:index", job.createdAt, job.id);
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const raw = await redis.get(`job:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function listJobs(limit = 50): Promise<JobRecord[]> {
  const ids = await redis.zrevrange("jobs:index", 0, limit - 1);
  const jobs: JobRecord[] = [];
  for (const id of ids) {
    const j = await getJob(id);
    if (j) jobs.push(j);
  }
  return jobs;
}

export async function appendLog(id: string, line: string) {
  const job = await getJob(id);
  if (!job) return;
  job.logs.push(line);
  if (job.logs.length > 2000) job.logs = job.logs.slice(-2000);
  job.updatedAt = Date.now();
  await saveJob(job);
}

export async function updateJob(id: string, patch: Partial<JobRecord>) {
  const job = await getJob(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
  await saveJob(job);
}
