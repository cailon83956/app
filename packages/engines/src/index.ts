import { join, resolve } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import type { EngineAdapter, BuildRequest, BuildContext, BuildResult, DetectionResult } from "@uab/shared";
import { runCommand, which } from "./runner";

function findApk(dir: string): string | undefined {
  const out: string[] = [];
  function walk(d: string, depth = 0) {
    if (depth > 8) return;
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const full = join(d, e);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
        else if (e.endsWith(".apk")) out.push(full);
      } catch {}
    }
  }
  walk(dir);
  // prefer debug/release apk not unsigned? sort by mtime desc
  out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return out[0];
}

async function checkTools(tools: string[]): Promise<{ ok: boolean; missing: string[]; versions: Record<string, string> }> {
  const missing: string[] = [];
  const versions: Record<string, string> = {};
  for (const t of tools) {
    const p = which(t);
    if (!p) { missing.push(t); continue; }
    versions[t] = p;
  }
  // android sdk
  if (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) {
    versions["android-sdk"] = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
  } else {
    // common location
    if (existsSync("/opt/android-sdk")) versions["android-sdk"] = "/opt/android-sdk";
    else missing.push("android-sdk");
  }
  return { ok: missing.length === 0, missing, versions };
}

// ---------- Gradle ----------
class GradleEngine implements EngineAdapter {
  name = "gradle" as const;
  canHandle(d: DetectionResult) { return d.engine === "gradle"; }
  async checkEnvironment() { return checkTools(["java", "gradle"]); }
  async build(req: BuildRequest, ctx: BuildContext): Promise<BuildResult> {
    const logs: string[] = [];
    const push = (l: string) => { logs.push(l); ctx.log(l); };
    const mode = req.advanced?.buildMode === "release" ? "assembleRelease" : "assembleDebug";
    const androidDir = existsSync(join(req.sourceDir, "android")) ? join(req.sourceDir, "android") : req.sourceDir;
    // use wrapper if present
    const wrapper = join(androidDir, "gradlew");
    const cmd = existsSync(wrapper) ? wrapper : "gradle";
    const args = existsSync(wrapper) ? [mode, "-Pkotlin.jvm.target.validation.mode=warning"] : [mode, "-Pkotlin.jvm.target.validation.mode=warning"];
    if (!existsSync(wrapper)) {
      // ensure gradle available
      if (!which("gradle")) { const e = "gradle not found"; push(e); return { success: false, error: e, logs }; }
    }
    // make wrapper executable
    if (existsSync(wrapper)) try { require("fs").chmodSync(wrapper, 0o755); } catch {}
    ctx.progress(20, "installing");
    push(`$ ${cmd} ${args.join(" ")} (cwd=${androidDir})`);
    const r = await runCommand(cmd, args, { cwd: androidDir, timeoutMs: 10 * 60 * 1000 }, ctx);
    if (r.code !== 0) {
      const err = `Gradle failed (code ${r.code})`;
      push(err);
      const tail = (r.stderr || r.stdout || "").split(/\r?\n/).filter(Boolean).slice(-40);
      for (const l of tail) push(l);
      logs.push(...tail);
      return { success: false, error: err + (tail.length ? ": " + tail[tail.length-1] : ""), logs };
    }
    ctx.progress(90, "collecting");
    const apk = findApk(join(androidDir, "app", "build")) || findApk(join(androidDir, "build"));
    if (!apk) { const e = "APK not found after build"; push(e); return { success: false, error: e, logs }; }
    push(`APK: ${apk}`);
    return { success: true, artifactPath: apk, artifactSize: (await import("fs")).statSync(apk).size, logs };
  }
}

// ---------- Flutter ----------
class FlutterEngine implements EngineAdapter {
  name = "flutter" as const;
  canHandle(d: DetectionResult) { return d.engine === "flutter"; }
  async checkEnvironment() { return checkTools(["flutter"]); }
  async build(req: BuildRequest, ctx: BuildContext): Promise<BuildResult> {
    const logs: string[] = [];
    const push = (l: string) => { logs.push(l); ctx.log(l); };
    if (!which("flutter")) { const e = "flutter not found"; push(e); return { success: false, error: e, logs }; }
    ctx.progress(20, "building");
    const args = ["build", "apk", "--debug"];
    push(`$ flutter ${args.join(" ")}`);
    const r = await runCommand("flutter", args, { cwd: req.sourceDir, timeoutMs: 20 * 60 * 1000 }, ctx);
    if (r.code !== 0) { const e = `Flutter failed (code ${r.code})`; push(e); return { success: false, error: e, logs }; }
    ctx.progress(90, "collecting");
    const apk = findApk(join(req.sourceDir, "build"));
    if (!apk) { const e = "APK not found"; push(e); return { success: false, error: e, logs }; }
    push(`APK: ${apk}`);
    const fs = await import("fs");
    return { success: true, artifactPath: apk, artifactSize: require("fs").statSync(apk).size, logs };
  }
}

// ---------- Cordova ----------
class CordovaEngine implements EngineAdapter {
  name = "cordova" as const;
  canHandle(d: DetectionResult) { return d.engine === "cordova"; }
  async checkEnvironment() { return checkTools(["node", "cordova"]); }
  async build(req: BuildRequest, ctx: BuildContext): Promise<BuildResult> {
    const logs: string[] = [];
    const push = (l: string) => { logs.push(l); ctx.log(l); };
    const cordovaBin = which("cordova") || "npx";
    const args = which("cordova") ? ["build", "android"] : ["cordova", "build", "android"];
    // npm install if package.json
    if (existsSync(join(req.sourceDir, "package.json"))) {
      ctx.progress(10, "installing");
      push("$ npm install");
      const r = await runCommand("npm", ["install"], { cwd: req.sourceDir, timeoutMs: 10 * 60 * 1000 }, ctx);
      if (r.code !== 0) { const e = "npm install failed"; push(e); return { success: false, error: e, logs }; }
    }
    ctx.progress(40, "building");
    push(`$ ${cordovaBin} ${args.join(" ")}`);
    const r = await runCommand(cordovaBin, args, { cwd: req.sourceDir, timeoutMs: 20 * 60 * 1000 }, ctx);
    if (r.code !== 0) { const e = `Cordova failed (code ${r.code})`; push(e); return { success: false, error: e, logs }; }
    ctx.progress(90, "collecting");
    const apk = findApk(join(req.sourceDir, "platforms", "android")) || findApk(req.sourceDir);
    if (!apk) { const e = "APK not found"; push(e); return { success: false, error: e, logs }; }
    push(`APK: ${apk}`);
    const fs = await import("fs");
    return { success: true, artifactPath: apk, artifactSize: require("fs").statSync(apk).size, logs };
  }
}

// ---------- React Native ----------
class ReactNativeEngine implements EngineAdapter {
  name = "react-native" as const;
  canHandle(d: DetectionResult) { return d.engine === "react-native"; }
  async checkEnvironment() { return checkTools(["node"]); }
  async build(req: BuildRequest, ctx: BuildContext): Promise<BuildResult> {
    const logs: string[] = [];
    const push = (l: string) => { logs.push(l); ctx.log(l); };
    if (existsSync(join(req.sourceDir, "package.json"))) {
      ctx.progress(10, "installing");
      push("$ npm install");
      const r = await runCommand("npm", ["install"], { cwd: req.sourceDir, timeoutMs: 10 * 60 * 1000 }, ctx);
      if (r.code !== 0) { const e = "npm install failed"; push(e); return { success: false, error: e, logs }; }
    }
    const androidDir = join(req.sourceDir, "android");
    if (!existsSync(androidDir)) { const e = "android/ directory missing"; push(e); return { success: false, error: e, logs }; }
    // gradle wrapper
    const wrapper = join(androidDir, "gradlew");
    if (existsSync(wrapper)) try { require("fs").chmodSync(wrapper, 0o755); } catch {}
    const cmd = existsSync(wrapper) ? wrapper : "gradle";
    ctx.progress(40, "building");
    push(`$ ${cmd} assembleDebug`);
    const r = await runCommand(cmd, ["assembleDebug", "-Pkotlin.jvm.target.validation.mode=warning"], { cwd: androidDir, timeoutMs: 20 * 60 * 1000 }, ctx);
    if (r.code !== 0) { const e = `RN build failed (code ${r.code})`; push(e); return { success: false, error: e, logs }; }
    ctx.progress(90, "collecting");
    const apk = findApk(join(androidDir, "app", "build")) || findApk(androidDir);
    if (!apk) { const e = "APK not found"; push(e); return { success: false, error: e, logs }; }
    push(`APK: ${apk}`);
    const fs = await import("fs");
    return { success: true, artifactPath: apk, artifactSize: require("fs").statSync(apk).size, logs };
  }
}

// ---------- Capacitor (web -> apk) ----------
class CapacitorEngine implements EngineAdapter {
  name = "capacitor" as const;
  canHandle(d: DetectionResult) { return d.engine === "capacitor"; }
  async checkEnvironment() { return checkTools(["node"]); }
  async build(req: BuildRequest, ctx: BuildContext): Promise<BuildResult> {
    const logs: string[] = [];
    const push = (l: string) => { logs.push(l); ctx.log(l); };
    const src = req.sourceDir;
    // npm install
    if (existsSync(join(src, "package.json"))) {
      ctx.progress(5, "installing");
      push("$ npm install");
      const r = await runCommand("npm", ["install"], { cwd: src, timeoutMs: 10 * 60 * 1000 }, ctx);
      if (r.code !== 0) { const e = "npm install failed"; push(e); return { success: false, error: e, logs }; }
    }
    // build web
    const pkg = (() => { try { return JSON.parse(require("fs").readFileSync(join(src, "package.json"), "utf8")); } catch { return null; } })();
    if (pkg?.scripts?.build) {
      ctx.progress(25, "building web");
      push("$ npm run build");
      const r = await runCommand("npm", ["run", "build"], { cwd: src, timeoutMs: 10 * 60 * 1000 }, ctx);
      if (r.code !== 0) { const e = "web build failed"; push(e); return { success: false, error: e, logs }; }
    }
    // ensure android platform
    const androidDir = join(src, "android");
    const capCmd = which("cap") ? "cap" : null;
    const npxCap = ["npx", "cap"];
    if (!existsSync(androidDir)) {
      ctx.progress(45, "adding android");
      push("$ npx cap add android");
      const r = await runCommand("npx", ["cap", "add", "android"], { cwd: src, timeoutMs: 10 * 60 * 1000 }, ctx);
      if (r.code !== 0) { const e = "cap add android failed"; push(e); return { success: false, error: e, logs }; }
    }
    ctx.progress(60, "syncing");
    push("$ npx cap sync android");
    const sync = await runCommand("npx", ["cap", "sync", "android"], { cwd: src, timeoutMs: 10 * 60 * 1000 }, ctx);
    if (sync.code !== 0) { const e = "cap sync failed"; push(e); return { success: false, error: e, logs }; }
    // gradle build
    const gradleDir = androidDir;
    const wrapper = join(gradleDir, "gradlew");
    if (existsSync(wrapper)) try { require("fs").chmodSync(wrapper, 0o755); } catch {}
    const cmd = existsSync(wrapper) ? wrapper : "gradle";
    ctx.progress(75, "building apk");
    push(`$ ${cmd} assembleDebug`);
    const r = await runCommand(cmd, ["assembleDebug", "-Pkotlin.jvm.target.validation.mode=warning"], { cwd: gradleDir, timeoutMs: 20 * 60 * 1000 }, ctx);
    if (r.code !== 0) { const e = `Android build failed (code ${r.code})`; push(e); return { success: false, error: e, logs }; }
    ctx.progress(95, "collecting");
    const apk = findApk(join(gradleDir, "app", "build")) || findApk(gradleDir);
    if (!apk) { const e = "APK not found"; push(e); return { success: false, error: e, logs }; }
    push(`APK: ${apk}`);
    const fs = await import("fs");
    return { success: true, artifactPath: apk, artifactSize: require("fs").statSync(apk).size, logs };
  }
}

// ---------- Vite / static web (wrap via capacitor automatically) ----------
class StaticWebEngine implements EngineAdapter {
  name = "static-web" as const;
  canHandle(d: DetectionResult) { return d.engine === "static-web"; }
  async checkEnvironment() { return checkTools(["node"]); }
  async build(req: BuildRequest, ctx: BuildContext): Promise<BuildResult> {
    // Wrap static site using capacitor by creating a minimal capacitor project? 
    // Simpler: delegate to CapacitorEngine after scaffolding a minimal package.json if missing.
    const logs: string[] = [];
    const push = (l: string) => { logs.push(l); ctx.log(l); };
    const src = req.sourceDir;
    // If no package.json, create minimal one for capacitor
    if (!existsSync(join(src, "package.json"))) {
      const minimal = {
        name: "static-web-app",
        version: "1.0.0",
        dependencies: { "@capacitor/core": "^6.0.0", "@capacitor/android": "^6.0.0" },
        devDependencies: { "@capacitor/cli": "^6.0.0" }
      };
      require("fs").writeFileSync(join(src, "package.json"), JSON.stringify(minimal, null, 2));
      push("Created minimal package.json for Capacitor wrapping.");
    }
    // Determine web root containing index.html
    let webDir = "www";
    function findIndex(dir: string, rel: string, depth: number): string | null {
      if (depth > 4) return null;
      let entries: string[] = [];
      try { entries = require("fs").readdirSync(dir); } catch { return null; }
      if (entries.includes("index.html")) return rel === "" ? "." : rel;
      for (const e of entries) {
        if (e === "node_modules" || e === "android" || e === "ios" || e === ".git" || e === "www") continue;
        const full = join(dir, e);
        try {
          if (require("fs").statSync(full).isDirectory()) {
            const r = findIndex(full, rel === "" ? e : rel + "/" + e, depth + 1);
            if (r) return r;
          }
        } catch {}
      }
      return null;
    }
    const idxRel = findIndex(src, "", 0);
    if (idxRel && idxRel !== ".") {
      webDir = idxRel;
      push(`Detected web root: ${webDir}`);
    } else if (idxRel === ".") {
      webDir = "www";
      const webDirPath = join(src, webDir);
      if (!existsSync(webDirPath)) require("fs").mkdirSync(webDirPath, { recursive: true });
      for (const f of require("fs").readdirSync(src)) {
        if (f === "www" || f === "node_modules" || f === "android" || f === "ios") continue;
        const full = join(src, f);
        try { if (require("fs").statSync(full).isFile()) require("fs").copyFileSync(full, join(webDirPath, f)); } catch {}
      }
      push(`Created ${webDir}/ with web assets.`);
    } else {
      webDir = "www";
      const webDirPath = join(src, webDir);
      if (!existsSync(webDirPath)) require("fs").mkdirSync(webDirPath, { recursive: true });
      push("Warning: no index.html found; build may fail.");
    }
    // capacitor config
    if (!existsSync(join(src, "capacitor.config.json")) && !existsSync(join(src, "capacitor.config.ts"))) {
      const cfg = { appId: "com.example.staticapp", appName: "StaticApp", webDir };
      require("fs").writeFileSync(join(src, "capacitor.config.json"), JSON.stringify(cfg, null, 2));
      push("Created capacitor.config.json.");
    }
    // delegate
    const cap = new CapacitorEngine();
    const res = await cap.build(req, ctx);
    return { ...res, logs: [...logs, ...res.logs] };
  }
}

// ---------- Vite frontend (build only, then capacitor wrap) ----------
class ViteEngine implements EngineAdapter {
  name = "vite" as const;
  canHandle(d: DetectionResult) { return d.engine === "vite"; }
  async checkEnvironment() { return checkTools(["node"]); }
  async build(req: BuildRequest, ctx: BuildContext): Promise<BuildResult> {
    const logs: string[] = [];
    const push = (l: string) => { logs.push(l); ctx.log(l); };
    const src = req.sourceDir;
    if (existsSync(join(src, "package.json"))) {
      ctx.progress(5, "installing");
      push("$ npm install");
      const r = await runCommand("npm", ["install"], { cwd: src, timeoutMs: 10 * 60 * 1000 }, ctx);
      if (r.code !== 0) { const e = "npm install failed"; push(e); return { success: false, error: e, logs }; }
    }
    // Determine build output dir
    const pkg = (() => { try { return JSON.parse(require("fs").readFileSync(join(src, "package.json"), "utf8")); } catch { return null; } })();
    if (pkg?.scripts?.build) {
      ctx.progress(20, "building");
      push("$ npm run build");
      const r = await runCommand("npm", ["run", "build"], { cwd: src, timeoutMs: 10 * 60 * 1000 }, ctx);
      if (r.code !== 0) { const e = "frontend build failed"; push(e); return { success: false, error: e, logs }; }
    }
    // Detect webDir
    let webDir = "dist";
    for (const c of ["dist", "build", "out", ".next"]) {
      if (existsSync(join(src, c))) { webDir = c; break; }
    }
    // If capacitor already configured, delegate to capacitor engine (it will sync). But need webDir config.
    if (existsSync(join(src, "capacitor.config.json")) || existsSync(join(src, "capacitor.config.ts")) || (pkg?.dependencies?.["@capacitor/core"])) {
      const cap = new CapacitorEngine();
      // skip npm install/build? capacitor engine does them; but already built. It will npm install again (idempotent) and npm run build again (idempotent). Fine.
      const res = await cap.build(req, ctx);
      return { ...res, logs: [...logs, ...res.logs] };
    }
    // Otherwise scaffold capacitor wrapping around built web dir
    if (!existsSync(join(src, "package.json"))) {
      // create minimal
    }
    // add capacitor deps if missing
    if (!pkg?.dependencies?.["@capacitor/core"]) {
      push("$ npm install @capacitor/core @capacitor/android @capacitor/cli");
      await runCommand("npm", ["install", "@capacitor/core", "@capacitor/android", "@capacitor/cli"], { cwd: src, timeoutMs: 10 * 60 * 1000 }, ctx);
    }
    if (!existsSync(join(src, "capacitor.config.json")) && !existsSync(join(src, "capacitor.config.ts"))) {
      const cfg = { appId: "com.example.app", appName: "App", webDir };
      require("fs").writeFileSync(join(src, "capacitor.config.json"), JSON.stringify(cfg, null, 2));
      push("Created capacitor.config.json.");
    }
    const cap = new CapacitorEngine();
    const res = await cap.build(req, ctx);
    return { ...res, logs: [...logs, ...res.logs] };
  }
}

export const engines: EngineAdapter[] = [
  new GradleEngine(),
  new FlutterEngine(),
  new CordovaEngine(),
  new ReactNativeEngine(),
  new CapacitorEngine(),
  new StaticWebEngine(),
  new ViteEngine(),
];

export function getEngine(name: string): EngineAdapter | undefined {
  return engines.find((e) => e.name === name);
}

export function selectEngine(d: DetectionResult): EngineAdapter | undefined {
  return engines.find((e) => e.canHandle(d));
}
