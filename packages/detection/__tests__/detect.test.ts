import { detectProject } from "../src/index";
import fs from "fs";
import path from "path";
import os from "os";

function makeProject(files: Record<string,string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
  for (const [p, c] of Object.entries(files)) {
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, c);
  }
  return dir;
}

test("detects static html", () => {
  const dir = makeProject({ "index.html": "<h1>hi</h1>" });
  const r = detectProject(dir);
  expect(r.projectType).toBe("html-static");
  expect(r.engine).toBe("static-web");
});

test("detects flutter", () => {
  const dir = makeProject({ "pubspec.yaml": "name: x\nflutter:\n  uses-material-design: true\n", "android/app/build.gradle": "" });
  const r = detectProject(dir);
  expect(r.projectType).toBe("flutter");
  expect(r.engine).toBe("flutter");
});

test("detects react native", () => {
  const dir = makeProject({ "package.json": JSON.stringify({ dependencies: { "react-native": "0.73.0" } }) });
  const r = detectProject(dir);
  expect(r.projectType).toBe("react-native");
});

test("detects android gradle", () => {
  const dir = makeProject({ "settings.gradle": "include ':app'", "app/build.gradle": "plugins { id 'com.android.application' }" });
  const r = detectProject(dir);
  expect(r.engine).toBe("gradle");
});

test("detects capacitor", () => {
  const dir = makeProject({ "package.json": JSON.stringify({ dependencies: { "@capacitor/core": "^6.0.0" } }), "capacitor.config.json": "{}" });
  const r = detectProject(dir);
  expect(r.projectType).toBe("capacitor");
});

test("unknown project", () => {
  const dir = makeProject({ "readme.txt": "hello" });
  const r = detectProject(dir);
  expect(r.projectType).toBe("unknown");
  expect(r.unsupportedReason).toBeTruthy();
});
