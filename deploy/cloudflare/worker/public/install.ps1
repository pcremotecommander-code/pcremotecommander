$ErrorActionPreference = 'Stop'

function Get-PcrcVerifiedFile {
    param([string]$Url, [string]$Destination, [string]$Sha256)
    if ((Test-Path -LiteralPath $Destination -PathType Leaf) -and
        (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $Sha256) { return }
    $temporary = $Destination + '.' + [guid]::NewGuid().ToString('N') + '.download'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $temporary -TimeoutSec 180
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $Sha256) {
            throw 'Download verification failed. Nothing from this download was executed. Retry the setup command.'
        }
        Move-Item -LiteralPath $temporary -Destination $Destination -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-PcrcNode {
    param([string]$Root)
    $existing = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existing) {
        $versionOutput = & $existing.Source --version
        $npmBin = Join-Path (Split-Path -Parent $existing.Source) 'node_modules\npm\bin'
        if ($LASTEXITCODE -eq 0 -and "$versionOutput" -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20 -and
            (Test-Path -LiteralPath (Join-Path $npmBin 'npm-cli.js')) -and
            (Test-Path -LiteralPath (Join-Path $npmBin 'npx-cli.js'))) { return $existing.Source }
    }
    $version = '22.23.4'
    $nodeDirectory = Join-Path $Root "node-v$version-win-x64"
    $node = Join-Path $nodeDirectory 'node.exe'
    $nodeHash = 'dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f'
    if ((Test-Path -LiteralPath $node -PathType Leaf) -and
        (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -eq $nodeHash -and
        (Test-Path -LiteralPath (Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $nodeDirectory 'node_modules\npm\bin\npx-cli.js') -PathType Leaf)) { return $node }
    Write-Host 'Preparing the private Node.js runtime (no administrator installation needed)...'
    $zip = Join-Path $Root "node-v$version-win-x64.zip"
    Get-PcrcVerifiedFile "https://nodejs.org/dist/v$version/node-v$version-win-x64.zip" $zip 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
    Expand-Archive -LiteralPath $zip -DestinationPath $Root -Force
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -ne $nodeHash) { throw 'Node.js verification failed. Setup stopped.' }
    return $node
}

function Get-PcrcUserPath { return [Environment]::GetEnvironmentVariable('Path', 'User') }

function Set-PcrcUserPath {
    param([string]$Value)
    [Environment]::SetEnvironmentVariable('Path', $Value, 'User')
    # Notify Explorer so terminals launched afterward inherit the updated user PATH.
    try {
        if (-not ('Pcrc.EnvironmentChange' -as [type])) {
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; namespace Pcrc { public static class EnvironmentChange { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result); } }'
        }
        $result = [UIntPtr]::Zero
        [Pcrc.EnvironmentChange]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$result) | Out-Null
    } catch { Write-Warning 'Node.js commands were saved. Sign out and back in if a newly opened terminal cannot find npx.' }
}

function Enable-PcrcCommands {
    param([string]$Root, [string]$Node)
    $nodeDirectory = Split-Path -Parent $Node
    $npmBin = Join-Path $nodeDirectory 'node_modules\npm\bin'
    foreach ($name in @('npm', 'npx')) {
        if (-not (Test-Path -LiteralPath (Join-Path $npmBin ($name + '-cli.js')) -PathType Leaf)) {
            throw 'The Node.js installation is missing npm/npx. Run the PCRC installer again.'
        }
    }
    $bin = Join-Path $Root 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    $nodeCommand = '"' + $Node.Replace('%', '%%') + '"'
    # CMD shims also work in PowerShell without changing its script execution policy.
    [IO.File]::WriteAllText((Join-Path $bin 'node.cmd'), "@echo off`r`nsetlocal DisableDelayedExpansion`r`n" + $nodeCommand + " %*`r`n", [Text.Encoding]::Default)
    foreach ($name in @('npm', 'npx')) {
        $script = (Join-Path $npmBin ($name + '-cli.js')).Replace('%', '%%')
        [IO.File]::WriteAllText((Join-Path $bin ($name + '.cmd')), "@echo off`r`nsetlocal DisableDelayedExpansion`r`n" + $nodeCommand + ' "' + $script + '" %*' + "`r`n", [Text.Encoding]::Default)
    }
    $userPath = Get-PcrcUserPath
    $entries = @($userPath -split ';' | Where-Object { $_ -and [Environment]::ExpandEnvironmentVariables($_).Trim('"').TrimEnd('\') -ine $bin.TrimEnd('\') })
    $updatedPath = (@($bin) + $entries) -join ';'
    if ($userPath -cne $updatedPath) { Set-PcrcUserPath $updatedPath }
    $env:Path = $bin + ';' + $env:Path
    Write-Host 'Node.js, npm and npx are ready. Next time, open a NEW terminal and run: npx --yes pcremotecommander@beta setup'
}

function Start-Pcrc {
    if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or
        $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'This installer supports Windows 10/11 x64. Linux and Windows ARM require a separate installer.'
    }
    if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { throw 'A normal Windows user profile is required.' }
    $previousProgress = $ProgressPreference
    try {
        $ProgressPreference = 'SilentlyContinue'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $root = Join-Path $env:LOCALAPPDATA 'PCRemoteCommander\bootstrap'
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        $node = Get-PcrcNode $root
        Enable-PcrcCommands $root $node
        $launcher = Join-Path $root 'pcremotecommander-beta49.cjs'
        Get-PcrcVerifiedFile 'https://pc-remote-commander.pcremotecommander.workers.dev/install/pcremotecommander.cjs' $launcher 'bd3edab4fff7f6784de464486470e461c6aa58653ea9bf709b44276c0970baec'
        Get-PcrcVerifiedFile 'https://pc-remote-commander.pcremotecommander.workers.dev/install/PCRC-retro-wide.cmd' (Join-Path $root 'PCRC-retro-wide.cmd') 'c1145849708e7af719b12a94c99718b8a47a15c5efee25423d1cfae8678f5222'
        & $node $launcher setup
        if ($LASTEXITCODE -ne 0) { throw "PCRC stopped (exit $LASTEXITCODE). Retry this same command, or contact support with the error text only." }
    } finally { $ProgressPreference = $previousProgress }
}

if ($MyInvocation.InvocationName -ne '.') { Start-Pcrc }
