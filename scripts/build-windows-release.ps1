[CmdletBinding()]
param(
	[string]$Version = "0.2.1",
	[string]$OutputDirectory,
	[switch]$SkipRunnerBuild,
	[string]$RunnerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ripgrepVersion = "15.2.0"
$ripgrepArchiveName = "ripgrep-$ripgrepVersion-x86_64-pc-windows-msvc.zip"
$ripgrepArchiveSha256 = "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5"
$ripgrepDownloadUrl = "https://github.com/BurntSushi/ripgrep/releases/download/$ripgrepVersion/$ripgrepArchiveName"

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
$ripgrepArchive = Join-Path $temporaryRoot $ripgrepArchiveName
$ripgrepExtractRoot = Join-Path $temporaryRoot "ripgrep"
New-Item -ItemType Directory -Path $packageDirectory -Force | Out-Null

try {
	Invoke-WebRequest -Uri $ripgrepDownloadUrl -OutFile $ripgrepArchive -UseBasicParsing
	$actualRipgrepSha256 = (Get-FileHash -LiteralPath $ripgrepArchive -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($actualRipgrepSha256 -ne $ripgrepArchiveSha256) {
		throw "ripgrep archive SHA256 mismatch: expected $ripgrepArchiveSha256, got $actualRipgrepSha256"
	}
	Expand-Archive -LiteralPath $ripgrepArchive -DestinationPath $ripgrepExtractRoot
	$ripgrepExecutables = @(Get-ChildItem -LiteralPath $ripgrepExtractRoot -Filter "rg.exe" -File -Recurse)
	if ($ripgrepExecutables.Count -ne 1) {
		throw "Expected exactly one rg.exe in $ripgrepArchiveName; found $($ripgrepExecutables.Count)."
	}
	$ripgrepDirectory = $ripgrepExecutables[0].DirectoryName
	$ripgrepMitLicense = Join-Path $ripgrepDirectory "LICENSE-MIT"
	$ripgrepUnlicense = Join-Path $ripgrepDirectory "UNLICENSE"
	foreach ($licensePath in @($ripgrepMitLicense, $ripgrepUnlicense)) {
		if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
			throw "The ripgrep archive is missing its license file: $licensePath"
		}
	}
	$ripgrepVersionOutput = (& $ripgrepExecutables[0].FullName --version | Select-Object -First 1)
	if ($LASTEXITCODE -ne 0 -or $ripgrepVersionOutput -ne "ripgrep $ripgrepVersion") {
		throw "Unexpected bundled ripgrep version: $ripgrepVersionOutput"
	}

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
	Copy-Item -LiteralPath $ripgrepExecutables[0].FullName -Destination (Join-Path $packageDirectory "rg.exe")
	Copy-Item -LiteralPath (Join-Path $repoRoot "docs\release\windows-x64.txt") -Destination (Join-Path $packageDirectory "README.txt")
	Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination (Join-Path $packageDirectory "LICENSE")
	Copy-Item `
		-LiteralPath (Join-Path $repoRoot "THIRD_PARTY_NOTICES.md") `
		-Destination (Join-Path $packageDirectory "THIRD_PARTY_NOTICES.md")
	$thirdPartyLicensesDirectory = Join-Path $packageDirectory "THIRD_PARTY_LICENSES"
	New-Item -ItemType Directory -Path $thirdPartyLicensesDirectory | Out-Null
	Copy-Item `
		-LiteralPath (Join-Path $repoRoot "THIRD_PARTY_LICENSES\BUN-1.3.14-LICENSE.md") `
		-Destination (Join-Path $thirdPartyLicensesDirectory "BUN-1.3.14-LICENSE.md")
	Copy-Item `
		-LiteralPath $ripgrepMitLicense `
		-Destination (Join-Path $thirdPartyLicensesDirectory "RIPGREP-15.2.0-LICENSE-MIT.txt")
	Copy-Item `
		-LiteralPath $ripgrepUnlicense `
		-Destination (Join-Path $thirdPartyLicensesDirectory "RIPGREP-15.2.0-UNLICENSE.txt")
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
