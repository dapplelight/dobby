// Dobby runs on macOS and Linux. On Windows, install inside WSL2 (bin/dobby is a shell script, which cmd and PowerShell cannot run).
if (process.platform === "win32") {
  console.error("Dobby does not run in native Windows. Install it inside WSL2 (wsl --install, then run npx dobby-ai init in the Ubuntu shell).")
  process.exit(1)
}
