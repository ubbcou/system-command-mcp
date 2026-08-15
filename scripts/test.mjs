import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const tests = (await readdir("dist/test"))
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => `dist/test/${file}`);
const result = spawnSync(process.execPath, ["--test", ...(process.platform === "win32" ? [] : ["--test-concurrency=1"]), ...tests], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
