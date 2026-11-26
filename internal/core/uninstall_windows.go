package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

func init() {
	scheduleWindowsUninstall = func(app string, paths []string, purge bool, warnings []any) (object, error) {
		result := filepath.Join(os.TempDir(), "arc-uninstall-"+id()+".json")
		var installation any
		if app != "" {
			installation = app
		}
		const script = `
$ErrorActionPreference = 'Stop'
$plan = $env:ARC_UNINSTALL_PLAN | ConvertFrom-Json
Wait-Process -Id $plan.pid -ErrorAction SilentlyContinue
Add-Type -AssemblyName Microsoft.VisualBasic
$removed = @(); $errors = @()
foreach ($path in $plan.paths) {
  try {
    if ($plan.purge) { Remove-Item -LiteralPath $path -Recurse -Force }
    elseif ([IO.Directory]::Exists($path)) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    $removed += $path
  } catch { $errors += @{path=$path; error=$_.Exception.Message} }
}
if ($plan.installation -and !(Test-Path -LiteralPath $plan.installation)) {
  try {
    Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {
      $entry = Get-ItemProperty -LiteralPath $_.PSPath
      if ($entry.DisplayName -eq 'Agent Remote Control' -and $entry.InstallLocation -and $entry.InstallLocation.TrimEnd('\') -eq $plan.installation.TrimEnd('\')) {
        Remove-Item -LiteralPath $_.PSPath -Recurse -Force
      }
    }
    $scheme = 'HKCU:\Software\Classes\agent-remote-control'
    $handlerKey = Get-Item -LiteralPath "$scheme\shell\open\command" -ErrorAction SilentlyContinue
    if ($handlerKey -and $handlerKey.GetValue('').Contains($plan.installation)) { Remove-Item -LiteralPath $scheme -Recurse -Force }
  } catch { $errors += @{action='registration cleanup'; error=$_.Exception.Message} }
}
@{state= $(if ($errors.Count) {'incomplete'} else {'completed'}); removed=$removed; errors=$errors; warnings=$plan.warnings} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $plan.result
`
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
		cmd.Dir = os.TempDir()
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW | windows.DETACHED_PROCESS}
		cmd.Env = append(cmd.Environ(), "ARC_UNINSTALL_PLAN="+wire(object{"pid": os.Getpid(), "paths": paths, "purge": purge, "result": result, "warnings": warnings, "installation": installation}))
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		_ = cmd.Process.Release()
		return object{"state": "scheduled", "purge": purge, "paths": paths, "resultPath": result, "warnings": warnings}, nil
	}
}
