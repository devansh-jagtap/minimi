import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["run", "next", "dev"], { stdio: "inherit", env: process.env }),
  spawn(process.execPath, ["run", "src/lib/document-worker.ts"], { stdio: "inherit", env: process.env }),
];

let stopping = false;

function stopAll(exitCode: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }
  const timeout = setTimeout(() => process.exit(exitCode), 1500);
  timeout.unref();
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("[Minimi] Could not start a development process:", error.message);
    stopAll(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stopAll(code ?? 1);
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
