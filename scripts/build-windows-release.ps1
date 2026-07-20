[CmdletBinding()]
param(
	[string]$Version = "0.1.1",
	[string]$OutputDirectory,
	[switch]$SkipRunnerBuild,
	[string]$RunnerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
	throw "The Windows release can only be built on Windows."
}
if ($Version -notmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$") {
	throw "Version must be a semantic version without a leading v: $Version"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$packageJsonPath = Join-Path $repoRoot "package.json"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
if ($packageJson.version -ne $Version) {
	throw "package.json version $($packageJson.version) does not match requested release $Version."
}

$runnerManifest = Join-Path $repoRoot "native\windows-sandbox-runner\Cargo.toml"
$runnerVersion = Select-String -LiteralPath $runnerManifest -Pattern '^version = "(?<version>[^"]+)"$' | Select-Object -First 1
if ($null -eq $runnerVersion -or $runnerVersion.Matches[0].Groups["version"].Value -ne $Version) {
	throw "The Windows sandbox runner version must match release $Version."
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
	$OutputDirectory = Join-Path $repoRoot "dist\release"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
	$OutputDirectory = Join-Path $repoRoot $OutputDirectory
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$artifactName = "coding-agent-lab-v$Version-windows-x64"
$destinationDirectory = Join-Path $OutputDirectory $artifactName
$zipPath = Join-Path $OutputDirectory "$artifactName.zip"
$checksumPath = "$zipPath.sha256"
foreach ($path in @($destinationDirectory, $zipPath, $checksumPath)) {
	if (Test-Path -LiteralPath $path) {
		throw "Release output already exists; move or remove it before rebuilding: $path"
	}
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("coding-agent-lab-release-" + [guid]::NewGuid().ToString("N"))
$packageDirectory = Join-Path $temporaryRoot $artifactName
$cargoTargetDirectory = Join-Path $temporaryRoot "cargo-target"
$temporaryZip = Join-Path $temporaryRoot "$artifactName.zip"
$temporaryChecksum = "$temporaryZip.sha256"
New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null

try {
	if ($SkipRunnerBuild) {
		if ([string]::IsNullOrWhiteSpace($RunnerPath)) {
			throw "-RunnerPath is required with -SkipRunnerBuild."
		}
		$resolvedRunnerPath = (Resolve-Path -LiteralPath $RunnerPath).Path
	} else {
		& (Join-Path $PSScriptRoot "build-windows-sandbox.ps1") -CargoTargetDir $cargoTargetDirectory
		$resolvedRunnerPath = Join-Path $cargoTargetDirectory "x86_64-pc-windows-msvc\release\cagent-windows-sandbox-runner.exe"
	}
	if (-not (Test-Path -LiteralPath $resolvedRunnerPath -PathType Leaf)) {
		throw "Windows sandbox runner was not found: $resolvedRunnerPath"
	}

	$bunCommand = Get-Command bun -CommandType Application -ErrorAction Stop | Select-Object -First 1
	$cagentPath = Join-Path $packageDirectory "cagent.exe"
	& $bunCommand.Source --no-env-file (Join-Path $repoRoot "scripts\build-windows-cli.ts") $cagentPath
	if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $cagentPath -PathType Leaf)) {
		throw "Bun did not produce the release executable."
	}

	Copy-Item -LiteralPath $resolvedRunnerPath -Destination (Join-Path $packageDirectory "cagent-windows-sandbox-runner.exe")
	Copy-Item -LiteralPath (Join-Path $repoRoot "docs\release\windows-x64.txt") -Destination (Join-Path $packageDirectory "README.txt")
	Compress-Archive -LiteralPath $packageDirectory -DestinationPath $temporaryZip -CompressionLevel Optimal
	$stream = [System.IO.File]::OpenRead($temporaryZip)
	try {
		$sha256 = [System.Security.Cryptography.SHA256]::Create()
		try {
			$hashBytes = $sha256.ComputeHash($stream)
			$hash = ([System.BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
		} finally {
			$sha256.Dispose()
		}
	} finally {
		$stream.Dispose()
	}
	[System.IO.File]::WriteAllText($temporaryChecksum, "$hash  $([System.IO.Path]::GetFileName($zipPath))`n", [System.Text.UTF8Encoding]::new($false))

	New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
	Move-Item -LiteralPath $packageDirectory -Destination $destinationDirectory
	Move-Item -LiteralPath $temporaryZip -Destination $zipPath
	Move-Item -LiteralPath $temporaryChecksum -Destination $checksumPath

	Write-Output "Built release directory: $destinationDirectory"
	Write-Output "Built release archive:   $zipPath"
	Write-Output "SHA256:                 $hash"
} finally {
	if (Test-Path -LiteralPath $temporaryRoot) {
		Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
	}
}
