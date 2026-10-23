# Uses the existing Node runtime. Does not change PowerShell execution policy.
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Write-Error 'Node.js >=20 is required. Use the Node already provided by SillyTavern.'
    exit 1
}
& $nodeCommand.Source (Join-Path $PSScriptRoot 'install/install.mjs') @args
exit $LASTEXITCODE
