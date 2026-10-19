# Universal APK Builder

A web platform that builds Android APKs from a uploaded source ZIP. It auto-detects the project type and selects an appropriate build engine.

## Features

- Drag-and-drop ZIP upload
- Automatic project detection (HTML, React/Vite, Vue, Next.js, Angular, Svelte, Capacitor, Cordova, Android Gradle, Kotlin/Java, Flutter, React Native)
- Adapter-based build engine selection (no engine runs unless selected)
- Redis + BullMQ job queue with separate worker process
- Server-Sent Events for live progress and terminal logs
- APK download with metadata (size, build time, framework)
- Security: ZIP path traversal/symlink/zip-bomb checks, sandboxed builds, resource limits

## Architecture

```
apps/web      React + Vite + Tailwind frontend
apps/api      Fastify API + upload + detection + queue producer
apps/worker   BullMQ worker + engine adapters
packages/shared      shared types
packages/detection   project detection
packages/engines     build engine adapters
packages/security    ZIP validation
```

## Requirements

- Node.js 18+
- Redis 7+
- For Android builds: JDK 17, Android SDK (platform 34, build-tools 34), Gradle
- For Flutter builds: Flutter SDK
- For Cordova/Capacitor: Node tooling (installed via npm)

## Quick Start (dev)

```bash
npm install
# start redis
redis-server --daemonize yes
# build packages
npm run build -w packages/shared
npm run build -w packages/detection
npm run build -w packages/security
npm run build -w packages/engines
npm run build -w apps/api
npm run build -w apps/worker
npm run build -w apps/web

# run
DATA_DIR=/tmp/opencode/uab-data ANDROID_HOME=/opt/android-sdk node apps/api/dist/index.js &
DATA_DIR=/tmp/opencode/uab-data ANDROID_HOME=/opt/android-sdk node apps/worker/dist/index.js &
# frontend dev server
npm run dev -w apps/web
```

Open http://localhost:5173

## Docker Compose (dev)

```bash
cd infra
docker compose up --build
```

## Environment

See `.env.example`.

## Detection

Detection reads manifests: `package.json`, `capacitor.config.*`, `config.xml`, `settings.gradle[.kts]`, `build.gradle[.kts]`, `pubspec.yaml`, `AndroidManifest.xml`, and source file extensions.

## Security

- ZIP validated for path traversal, symlinks, zip bombs, size limits.
- Builds run in worker process, not API server.
- Per-job isolated working directories; cleanup on delete.
- No arbitrary command execution from UI.

## Tests

```bash
npm run test -w packages/detection
```

## Limitations

- Engines requiring SDKs not present in the host will report `missing tools` and fail the job with a clear message.
- Flutter engine requires Flutter SDK (not bundled by default).
- Cordova engine requires `cordova` CLI (installable via npm).
- Release signing requires user-provided keystore; debug builds are default.
- This MVP focuses on a working end-to-end flow; advanced isolation (Docker-per-build) is represented by compose/worker separation and can be extended.

## Sample ZIPs

See `samples/`: `static-html.zip`, `react-vite.zip`, `android-native.zip`.
