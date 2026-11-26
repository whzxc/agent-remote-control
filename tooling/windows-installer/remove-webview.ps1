$ErrorActionPreference = 'Stop'
$profilePath = Join-Path $env:LOCALAPPDATA 'Agent Remote Control\WebView2'

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        # Directory.Delete removes junctions as links instead of walking their targets.
        [IO.Directory]::Delete($profilePath, $true)
        exit 0
    } catch [IO.DirectoryNotFoundException] {
        exit 0
    } catch {
        if ($attempt -eq 29) {
            Write-Output $_.Exception.Message
            exit 1
        }
        # WebView2 can still hold file handles briefly after Desktop exits.
        Start-Sleep -Milliseconds 200
    }
}
