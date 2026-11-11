param(
    [Parameter(Mandatory = $true)][string]$StateDirectory,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$ruleName = 'ARC-Device-Link'
Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) { exit 0 }
$port = 7143
$configPath = Join-Path $StateDirectory 'device-link\peers.json'
if (Test-Path -LiteralPath $configPath) {
    $configured = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).port
    if ($configured -ge 1 -and $configured -le 65535) { $port = [int]$configured }
}
New-NetFirewallRule -Name $ruleName -DisplayName 'ARC Device link' -Direction Inbound `
    -Action Allow -Protocol TCP -LocalPort $port -Profile Private | Out-Null
