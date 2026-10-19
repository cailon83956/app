import fs from "fs";
import path from "path";
import type { DetectionResult, ProjectType, BuildEngine } from "@uab/shared";

function exists(p: string) { try { return fs.existsSync(p); } catch { return false; } }
function readJson(p: string): any { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function readText(p: string): string { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function listFiles(root: string, max = 2000): string[] {
  const out: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 6 || out.length > max) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "build" || e.name === "dist") continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) { out.push(rel + "/"); walk(full, depth + 1); }
      else { out.push(rel); }
    }
  }
  walk(root, 0);
  return out;
}
function hasFile(root: string, name: string) { return exists(path.join(root, name)); }
function findFile(root: string, predicate: (rel: string) => boolean): string | undefined {
  return listFiles(root).find(predicate);
}

function detectProjectAtRoot(rootDir: string): DetectionResult {
  const notes: string[] = [];
  const entryFiles: string[] = [];
  let projectType: ProjectType = "unknown";
  let engine: BuildEngine = "vite";
  let confidence = 0;
  let framework: string | undefined;
  let frameworkVersion: string | undefined;
  let hasAndroid = false;
  let hasWeb = false;
  const requiredTools: string[] = [];

  const files = listFiles(rootDir);

  // Flutter
  if (exists(path.join(rootDir, "pubspec.yaml"))) {
    const pub = readText(path.join(rootDir, "pubspec.yaml"));
    if (/flutter:/i.test(pub)) {
      projectType = "flutter"; engine = "flutter"; confidence = 0.95; framework = "Flutter";
      requiredTools.push("flutter", "android-sdk");
      hasAndroid = exists(path.join(rootDir, "android"));
      entryFiles.push("pubspec.yaml");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
  }

  // React Native
  const pkg = readJson(path.join(rootDir, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps["react-native"]) {
      projectType = "react-native"; engine = "react-native"; confidence = 0.95; framework = "React Native";
      frameworkVersion = deps["react-native"];
      requiredTools.push("node", "android-sdk", "gradle");
      hasAndroid = exists(path.join(rootDir, "android"));
      entryFiles.push("package.json");
      if (exists(path.join(rootDir, "android", "settings.gradle"))) entryFiles.push("android/settings.gradle");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
  }

  // Capacitor
  const capConfig = findFile(rootDir, (r) => /^capacitor\.config\.(json|ts|js)$/.test(path.basename(r)));
  const capJson = exists(path.join(rootDir, "capacitor.config.json")) ? readJson(path.join(rootDir, "capacitor.config.json")) : null;
  if (capConfig || (pkg && (pkg.dependencies?.["@capacitor/core"] || pkg.devDependencies?.["@capacitor/core"]))) {
    projectType = "capacitor"; engine = "capacitor"; confidence = 0.9; framework = "Capacitor";
    requiredTools.push("node", "capacitor", "android-sdk");
    hasWeb = true;
    hasAndroid = exists(path.join(rootDir, "android"));
    entryFiles.push(capConfig || "package.json");
    if (!hasAndroid) notes.push("Android platform not present; will be added via `cap add android` if tools available.");
    return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
  }

  // Cordova
  if (exists(path.join(rootDir, "config.xml"))) {
    const cx = readText(path.join(rootDir, "config.xml"));
    if (/<widget/i.test(cx)) {
      projectType = "cordova"; engine = "cordova"; confidence = 0.9; framework = "Cordova";
      requiredTools.push("node", "cordova", "android-sdk");
      hasWeb = true;
      hasAndroid = exists(path.join(rootDir, "platforms", "android"));
      entryFiles.push("config.xml");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
  }

  // Android native (Gradle)
  if (exists(path.join(rootDir, "settings.gradle")) || exists(path.join(rootDir, "settings.gradle.kts"))) {
    const sg = readText(path.join(rootDir, "settings.gradle")) + readText(path.join(rootDir, "settings.gradle.kts"));
    if (/android/i.test(sg) || exists(path.join(rootDir, "app", "build.gradle")) || exists(path.join(rootDir, "app", "build.gradle.kts"))) {
      // detect kotlin/java
      const appGradle = readText(path.join(rootDir, "app", "build.gradle")) + readText(path.join(rootDir, "app", "build.gradle.kts"));
      const isKotlin = /\.kt\b/.test(appGradle) || files.some(f => f.endsWith(".kt"));
      projectType = isKotlin ? "kotlin-android" : "android-gradle";
      engine = "gradle"; confidence = 0.95; framework = isKotlin ? "Kotlin Android" : "Android (Gradle)";
      requiredTools.push("java", "gradle", "android-sdk");
      hasAndroid = true;
      entryFiles.push(exists(path.join(rootDir,"settings.gradle.kts")) ? "settings.gradle.kts" : "settings.gradle");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
  }
  // single module android without settings? check build.gradle with android plugin
  const rootGradle = readText(path.join(rootDir, "build.gradle")) + readText(path.join(rootDir, "build.gradle.kts"));
  if (/com\.android\.application|com\.android\.library/.test(rootGradle)) {
    const isKotlin = files.some(f => f.endsWith(".kt"));
    projectType = isKotlin ? "kotlin-android" : "java-android";
    engine = "gradle"; confidence = 0.9; framework = isKotlin ? "Kotlin Android" : "Java Android";
    requiredTools.push("java", "gradle", "android-sdk");
    hasAndroid = true;
    entryFiles.push(exists(path.join(rootDir,"build.gradle.kts")) ? "build.gradle.kts" : "build.gradle");
    return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
  }

  // Frontend frameworks via package.json
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    frameworkVersion = undefined;
    // Next.js
    if (deps["next"]) {
      projectType = "nextjs"; engine = "vite"; confidence = 0.9; framework = "Next.js"; frameworkVersion = deps["next"];
      hasWeb = true; requiredTools.push("node");
      entryFiles.push("package.json");
      notes.push("Next.js supported only in static export mode; ensure next.config.js has output:'export'.");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
    // Vite
    if (deps["vite"] || exists(path.join(rootDir, "vite.config.ts")) || exists(path.join(rootDir, "vite.config.js"))) {
      // refine react/vue/svelte
      if (deps["react"]) { projectType = "react-vite"; framework = "React (Vite)"; }
      else if (deps["vue"]) { projectType = "vue"; framework = "Vue"; }
      else if (deps["svelte"]) { projectType = "svelte"; framework = "Svelte"; }
      else { projectType = "react-vite"; framework = "Vite"; }
      engine = "vite"; confidence = 0.9; frameworkVersion = deps["vite"] || deps["react"] || deps["vue"];
      hasWeb = true; requiredTools.push("node");
      entryFiles.push("package.json");
      const vc = ["vite.config.ts","vite.config.js","vite.config.mjs"].find(f=>exists(path.join(rootDir,f)));
      if (vc) entryFiles.push(vc);
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
    // Create React App
    if (deps["react-scripts"]) {
      projectType = "react-cra"; engine = "vite"; confidence = 0.85; framework = "React (CRA)";
      frameworkVersion = deps["react"];
      hasWeb = true; requiredTools.push("node");
      entryFiles.push("package.json");
      notes.push("CRA detected; will build with npm run build.");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
    // Angular
    if (deps["@angular/core"] || exists(path.join(rootDir, "angular.json"))) {
      projectType = "angular"; engine = "vite"; confidence = 0.9; framework = "Angular";
      frameworkVersion = deps["@angular/core"];
      hasWeb = true; requiredTools.push("node");
      entryFiles.push(exists(path.join(rootDir,"angular.json")) ? "angular.json" : "package.json");
      notes.push("Angular build via ng build.");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
    // Vue CLI
    if (deps["vue"] && (deps["@vue/cli-service"] || exists(path.join(rootDir, "vue.config.js")))) {
      projectType = "vue"; engine = "vite"; confidence = 0.85; framework = "Vue";
      frameworkVersion = deps["vue"];
      hasWeb = true; requiredTools.push("node");
      entryFiles.push("package.json");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
    // Svelte (kit)
    if (deps["svelte"] || deps["@sveltejs/kit"]) {
      projectType = "svelte"; engine = "vite"; confidence = 0.8; framework = "Svelte";
      frameworkVersion = deps["svelte"];
      hasWeb = true; requiredTools.push("node");
      entryFiles.push("package.json");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
    // Generic node web (react/vue present)
    if (deps["react"] || deps["vue"]) {
      projectType = deps["react"] ? "react-vite" : "vue";
      engine = "vite"; confidence = 0.6; framework = deps["react"] ? "React" : "Vue";
      frameworkVersion = deps["react"] || deps["vue"];
      hasWeb = true; requiredTools.push("node");
      entryFiles.push("package.json");
      notes.push("Generic frontend project; attempting npm run build.");
      return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
    }
  }

  // Static HTML
  if (exists(path.join(rootDir, "index.html"))) {
    projectType = "html-static"; engine = "static-web"; confidence = 0.95; framework = "Static HTML";
    hasWeb = true; requiredTools.push("node");
    entryFiles.push("index.html");
    return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
  }
  // html anywhere
  if (files.some(f => f.endsWith(".html"))) {
    projectType = "html-static"; engine = "static-web"; confidence = 0.6; framework = "Static HTML";
    hasWeb = true; requiredTools.push("node");
    const hf = files.find(f => f.endsWith(".html"));
    if (hf) entryFiles.push(hf);
    notes.push("No index.html at root; using first html file.");
    return make(projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes);
  }

  // Unsupported
  notes.push("Could not detect a supported project type.");
  return make("unknown", engine, 0, undefined, undefined, entryFiles, hasAndroid, hasWeb, requiredTools, notes, "Unsupported or unrecognized project structure.");
}

function make(
  projectType: ProjectType, engine: BuildEngine, confidence: number,
  framework: string | undefined, frameworkVersion: string | undefined,
  entryFiles: string[], hasAndroid: boolean, hasWeb: boolean,
  requiredTools: string[], notes: string[], unsupportedReason?: string
): DetectionResult {
  return { projectType, engine, confidence, framework, frameworkVersion, entryFiles, hasAndroid, hasWeb, requiredTools, notes, unsupportedReason };
}

export { listFiles };


function findProjectRoot(rootDir: string): string {
  const markers = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts",
    "pubspec.yaml", "package.json", "config.xml", "capacitor.config.json", "capacitor.config.ts",
    "capacitor.config.js", "index.html", "angular.json"];
  // root itself
  if (markers.some(m => exists(path.join(rootDir, m)))) return rootDir;
  // search depth 1 and 2
  const candidates: string[] = [];
  function collect(dir: string, depth: number) {
    if (depth > 2) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (markers.some(m => exists(path.join(full, m)))) candidates.push(full);
      collect(full, depth + 1);
    }
  }
  collect(rootDir, 0);
  // prefer android project (settings.gradle) then others
  candidates.sort((a,b) => {
    const score = (d: string) => exists(path.join(d,"settings.gradle")) || exists(path.join(d,"settings.gradle.kts")) ? 0 : 1;
    return score(a)-score(b);
  });
  return candidates.length ? candidates[0] : rootDir;
}

export function detectProject(rootDir: string): DetectionResult {
  const actual = findProjectRoot(rootDir);
  const res = detectProjectAtRoot(actual);
  const rel = path.relative(rootDir, actual);
  res.projectRoot = rel === "" ? "." : rel.replace(/\\/g, "/");
  if (res.projectRoot !== ".") res.notes = [...(res.notes||[]), `Project root detected: ${res.projectRoot}`];
  return res;
}
