param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$ProductName
)

$ErrorActionPreference = 'Stop'
$runKey = $null
try {
    $scheduler = New-Object -ComObject Schedule.Service
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    try {
        $task = $folder.GetTask('ChatGPT Local Connector')
    } catch {
        $cause = $_.Exception
        while ($cause.InnerException) { $cause = $cause.InnerException }
        # Only a missing task is success; permission and service errors must stop the upgrade.
        if ($cause.HResult -eq -2147024894 -or $cause.HResult -eq -2147024893) { exit 0 }
        throw
    }

    $actions = $task.Definition.Actions
    $action = $actions.Item(1)
    # schtasks keeps the executable's surrounding quotes in the action path.
    $actionPath = $action.Path
    if ($actionPath.StartsWith('"') -and $actionPath.EndsWith('"')) {
        $actionPath = $actionPath.Substring(1, $actionPath.Length - 2)
    }
    if ($actions.Count -ne 1 -or $action.Type -ne 0 -or
        [IO.Path]::GetFullPath($actionPath) -ine [IO.Path]::GetFullPath($ExecutablePath) -or
        $action.Arguments -notmatch '(?:^|\s)--autostart(?:\s|$)') {
        throw 'The existing login task does not belong to this installation.'
    }

    $runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
    $hasRunValue = $runKey.GetValueNames() -contains $ProductName
    $createdRunValue = $false
    if ($task.Enabled -and !$hasRunValue) {
        $command = '"{0}" {1}' -f $ExecutablePath, $action.Arguments
        if ($command.Length -gt 260) { throw 'The login startup command exceeds the Windows 260-character limit.' }
        $runKey.SetValue($ProductName, $command, [Microsoft.Win32.RegistryValueKind]::String)
        $createdRunValue = $true
    }
    try {
        $folder.DeleteTask('ChatGPT Local Connector', 0)
    } catch {
        # A failed retirement must not leave a second registration behind.
        if ($createdRunValue) { $runKey.DeleteValue($ProductName, $false) }
        throw
    }
} catch {
    Write-Output $_.Exception.Message
    exit 1
} finally {
    if ($null -ne $runKey) { $runKey.Dispose() }
}
