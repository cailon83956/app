export type ProjectType =
  | "html-static"
  | "react-vite"
  | "react-cra"
  | "vue"
  | "nextjs"
  | "angular"
  | "svelte"
  | "capacitor"
  | "cordova"
  | "android-gradle"
  | "kotlin-android"
  | "java-android"
  | "flutter"
  | "react-native"
  | "unknown";

export type BuildEngine =
  | "vite"
  | "capacitor"
  | "cordova"
  | "gradle"
  | "flutter"
  | "react-native"
  | "static-web";

export type JobStatus =
  | "uploaded"
  | "analyzing"
  | "queued"
  | "installing"
  | "building"
  | "signing"
  | "completed"
  | "failed";

export interface DetectionResult {
  projectType: ProjectType;
  engine: BuildEngine;
  confidence: number;
  framework?: string;
  frameworkVersion?: string;
  entryFiles: string[];
  hasAndroid: boolean;
  hasWeb: boolean;
  requiredTools: string[];
  notes: string[];
  unsupportedReason?: string;
}

export interface JobRecord {
  id: string;
  filename: string;
  size: number;
  status: JobStatus;
  progress: number;
  createdAt: number;
  updatedAt: number;
  detection?: DetectionResult;
  artifactPath?: string;
  artifactSize?: number;
  buildTimeMs?: number;
  shareLink?: string;
  error?: string;
  logs: string[];
}

export interface BuildRequest {
  jobId: string;
  sourceDir: string;
  workDir: string;
  detection: DetectionResult;
  advanced?: AdvancedOptions;
}

export interface AdvancedOptions {
  buildMode?: "debug" | "release";
  signing?: { keystorePath?: string; alias?: string };
  env?: Record<string, string>;
}

export interface EngineAdapter {
  name: BuildEngine;
  canHandle(d: DetectionResult): boolean;
  checkEnvironment(): Promise<{ ok: boolean; missing: string[]; versions: Record<string,string> }>;
  build(req: BuildRequest, ctx: BuildContext): Promise<BuildResult>;
}

export interface BuildContext {
  log: (line: string) => void;
  progress: (p: number, stage?: string) => void;
  signal: AbortSignal;
}

export interface BuildResult {
  success: boolean;
  artifactPath?: string;
  artifactSize?: number;
  error?: string;
  logs: string[];
}
