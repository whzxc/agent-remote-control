package core

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

func init() {
	scheduleWindowsUninstall = func(app string, paths []string, purge bool, warnings []any) (object, error) {
		result := filepath.Join(os.TempDir(), "arc-uninstall-"+id()+".json")
		start := platform.ProcessStart(os.Getpid())
		if start == "" {
			return nil, errors.New("Could not verify the uninstall CLI process")
		}
		const script = `
$ErrorActionPreference = 'Stop'
$plan = $env:ARC_UNINSTALL_PLAN | ConvertFrom-Json
$removed = @(); $errors = @()
try {
  $parent = Get-Process -Id $plan.pid -ErrorAction SilentlyContinue
  if ($parent) {
    try {
      # Hold the process handle while checking creation time and waiting.
      $null = $parent.Handle
      if (!$parent.HasExited -and $parent.StartTime.ToFileTimeUtc().ToString() -eq $plan.start) { $parent.WaitForExit() }
    } catch {
      if (!$parent.HasExited) { throw }
    } finally { $parent.Dispose() }
  }
  if (!$plan.purge) {
    if (![Environment]::UserInteractive) { throw 'The Recycle Bin requires an interactive Windows session.' }
    Add-Type -AssemblyName Microsoft.VisualBasic
  }
  foreach ($path in $plan.paths) {
    try {
      if ($plan.purge) { Remove-Item -LiteralPath $path -Recurse -Force }
      elseif ([IO.Directory]::Exists($path)) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin') }
      else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin') }
      $removed += $path
    } catch { $errors += @{path=$path; error=$_.Exception.Message} }
  }
  if ($plan.installation -and !(Test-Path -LiteralPath $plan.installation)) {
    $registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Agent Remote Control'
    $entry = Get-ItemProperty -LiteralPath $registration -ErrorAction SilentlyContinue
    $install = $plan.installation.TrimEnd('\')
    if ($entry.DisplayName -eq 'Agent Remote Control' -and $entry.InstallLocation -and $entry.InstallLocation.Trim('"').TrimEnd('\') -eq $install) {
      Remove-Item -LiteralPath $registration -Recurse -Force
    }
    $location = Get-Item -LiteralPath 'HKCU:\Software\whzxc\Agent Remote Control' -ErrorAction SilentlyContinue
    if ($location -and ([string]$location.GetValue('')).Trim('"').TrimEnd('\') -eq $install) {
      Remove-Item -LiteralPath $location.PSPath -Recurse -Force
    }
    $scheme = 'HKCU:\Software\Classes\agent-remote-control'
    $handlerKey = Get-Item -LiteralPath ($scheme + '\shell\open\command') -ErrorAction SilentlyContinue
    $handler = '"{0}\agent-remote-control-desktop.exe" "%1"' -f $install
    if ($handlerKey -and $handlerKey.GetValue('') -eq $handler) { Remove-Item -LiteralPath $scheme -Recurse -Force }
  }
} catch {
  $errors += @{action='uninstall cleanup'; error=$_.Exception.Message}
} finally {
  $state = if ($errors.Count -or $plan.warnings.Count) { 'incomplete' } else { 'completed' }
  $json = @{state=$state; removed=$removed; errors=$errors; warnings=$plan.warnings} | ConvertTo-Json -Depth 8
  $partial = $plan.result + '.partial'
  [IO.File]::WriteAllText($partial, $json)
  [IO.File]::Move($partial, $plan.result)
}
`
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
		cmd.Dir = os.TempDir()
		// Windows PowerShell silently skips -Command under DETACHED_PROCESS.
		platform.Detach(cmd)
		cmd.Env = append(cmd.Environ(), "ARC_UNINSTALL_PLAN="+wire(object{"pid": os.Getpid(), "start": start, "paths": paths, "purge": purge, "result": result, "warnings": warnings, "installation": app}))
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		_ = cmd.Process.Release()
		return object{"state": "scheduled", "purge": purge, "paths": paths, "resultPath": result, "warnings": warnings}, nil
	}
}
