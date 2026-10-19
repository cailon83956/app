import { spawn } from "child_process";
import type { BuildContext } from "@uab/shared";

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

export function runCommand(cmd: string, args: string[], opts: RunOptions, ctx?: BuildContext): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, shell: false });
    let stdout = "", stderr = "";
    let killed = false;
    const timer = opts.timeoutMs ? setTimeout(() => { killed = true; child.kill("SIGKILL"); }, opts.timeoutMs) : null;
    const handle = (data: Buffer, isErr: boolean) => {
      const text = data.toString();
      if (isErr) stderr += text; else stdout += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === "") continue;
        if (opts.onLine) opts.onLine(line);
        if (ctx) ctx.log(line);
      }
    };
    child.stdout.on("data", (d) => handle(d, false));
    child.stderr.on("data", (d) => handle(d, true));
    child.on("error", (e) => { stderr += e.message; if (ctx) ctx.log("ERROR: " + e.message); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: killed ? 124 : (code ?? 1), stdout, stderr });
    });
  });
}

export function which(bin: string): string | null {
  const { execSync } = require("child_process");
  try { return execSync(`command -v ${bin}`, { encoding: "utf8" }).trim(); } catch { return null; }
}
