#!/usr/bin/env node
// Cross-platform launcher for this repo's bash scripts.
//
// On Windows, a bare `bash script.sh` is ambiguous: Windows ships its own
// WSL launcher shim at C:\Windows\System32\bash.exe, which often sits
// earlier on PATH than Git for Windows' real Git Bash. If the WSL shim wins,
// the script runs inside a WSL distro instead of Git Bash — a different
// filesystem view and, for Docker specifically, potentially a different
// Docker context than the one Docker Desktop exposes to Windows. This
// launcher finds Git Bash explicitly on Windows and skips the WSL shim; on
// every other OS (Linux, macOS, GitHub Actions runners) it just runs `bash`
// as usual, since none of this ambiguity exists there.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

function findWindowsGitBash() {
  const programDirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432];
  for (const dir of programDirs) {
    if (!dir) continue;
    const candidate = join(dir, "Git", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }

  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const bashesOnPath = pathEntries
    .map((dir) => join(dir, "bash.exe"))
    .filter((candidate) => existsSync(candidate));

  const gitBashOnPath = bashesOnPath.find((candidate) => /\\Git\\/i.test(candidate) && !/\\System32\\/i.test(candidate));
  if (gitBashOnPath) return gitBashOnPath;

  // Nothing under a "Git" folder — fall back to any bash.exe that is not the
  // WSL launcher shim (better than refusing to run at all).
  return bashesOnPath.find((candidate) => !/\\System32\\/i.test(candidate)) ?? null;
}

const bash = process.platform === "win32" ? findWindowsGitBash() : "bash";

if (!bash) {
  console.error("Could not find Git Bash. Install Git for Windows (https://git-scm.com/download/win) and try again.");
  process.exit(1);
}

const scriptArgs = process.argv.slice(2);
const result = spawnSync(bash, scriptArgs, { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
