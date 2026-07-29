[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)]
	[string]$PackagePath,
	[Parameter(Mandatory = $true)]
	[string]$ExpectedVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
	throw "The Windows package smoke test can only run on Windows."
}

$resolvedPackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if ([System.IO.Path]::GetExtension($resolvedPackagePath) -ne ".zip") {
	throw "PackagePath must point to a ZIP archive: $resolvedPackagePath"
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("coding-agent-lab-release-smoke-" + [guid]::NewGuid().ToString("N"))
$extractRoot = Join-Path $temporaryRoot "package"
$workspaceRoot = Join-Path $temporaryRoot "untrusted-workspace"
$preloadMarker = Join-Path $workspaceRoot "preload-ran.txt"
New-Item -ItemType Directory -Path $extractRoot, $workspaceRoot -Force | Out-Null

try {
	Expand-Archive -LiteralPath $resolvedPackagePath -DestinationPath $extractRoot
	$cagentFiles = @(Get-ChildItem -LiteralPath $extractRoot -Filter "cagent.exe" -File -Recurse)
	if ($cagentFiles.Count -ne 1) {
		throw "Expected exactly one cagent.exe in the release archive; found $($cagentFiles.Count)."
	}
	$cagentPath = $cagentFiles[0].FullName
	$runnerPath = Join-Path $cagentFiles[0].DirectoryName "cagent-windows-sandbox-runner.exe"
	if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
		throw "The native sandbox runner is not beside cagent.exe."
	}
	$ripgrepPath = Join-Path $cagentFiles[0].DirectoryName "rg.exe"
	if (-not (Test-Path -LiteralPath $ripgrepPath -PathType Leaf)) {
		throw "The bundled ripgrep executable is not beside cagent.exe."
	}
	$ripgrepVersionOutput = (& $ripgrepPath --version | Select-Object -First 1)
	if ($LASTEXITCODE -ne 0 -or $ripgrepVersionOutput -ne "ripgrep 15.2.0") {
		throw "Unexpected bundled ripgrep version: $ripgrepVersionOutput"
	}
	$licensePath = Join-Path $cagentFiles[0].DirectoryName "LICENSE"
	if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
		throw "The release archive does not contain the project license."
	}
	$thirdPartyNoticesPath = Join-Path `
		$cagentFiles[0].DirectoryName `
		"THIRD_PARTY_NOTICES.md"
	if (-not (Test-Path -LiteralPath $thirdPartyNoticesPath -PathType Leaf)) {
		throw "The release archive does not contain third-party notices."
	}
	$bunLicensePath = Join-Path `
		$cagentFiles[0].DirectoryName `
		"THIRD_PARTY_LICENSES\BUN-1.3.14-LICENSE.md"
	if (-not (Test-Path -LiteralPath $bunLicensePath -PathType Leaf)) {
		throw "The release archive does not contain Bun's pinned license."
	}
	foreach ($ripgrepLicenseName in @("RIPGREP-15.2.0-LICENSE-MIT.txt", "RIPGREP-15.2.0-UNLICENSE.txt")) {
		$ripgrepLicensePath = Join-Path $cagentFiles[0].DirectoryName "THIRD_PARTY_LICENSES\$ripgrepLicenseName"
		if (-not (Test-Path -LiteralPath $ripgrepLicensePath -PathType Leaf)) {
			throw "The release archive does not contain ripgrep license material: $ripgrepLicenseName"
		}
	}

	[System.IO.File]::WriteAllText((Join-Path $workspaceRoot ".env"), "DEEPSEEK_API_KEY=must-not-be-loaded`n", [System.Text.UTF8Encoding]::new($false))
	[System.IO.File]::WriteAllText((Join-Path $workspaceRoot "bunfig.toml"), "preload = [`"./preload.ts`"]`n", [System.Text.UTF8Encoding]::new($false))
	[System.IO.File]::WriteAllText((Join-Path $workspaceRoot "preload.ts"), "await Bun.write(`"preload-ran.txt`", `"unsafe`");`n", [System.Text.UTF8Encoding]::new($false))

	Push-Location $workspaceRoot
	try {
		$versionOutput = (& $cagentPath --version | Out-String).Trim()
		if ($LASTEXITCODE -ne 0) {
			throw "cagent --version exited with code $LASTEXITCODE."
		}
		if ($versionOutput -ne "cagent $ExpectedVersion") {
			throw "Unexpected version output: $versionOutput"
		}
		$helpOutput = (& $cagentPath --help | Out-String)
		if ($LASTEXITCODE -ne 0 -or $helpOutput -notmatch "Usage:" -or $helpOutput -notmatch "--resume" -or $helpOutput -notmatch "--memory-check") {
			throw "cagent --help did not return the expected usage text."
		}
		$memoryCheckOutput = (& $cagentPath --memory-check | Out-String)
		if ($LASTEXITCODE -ne 0 -or $memoryCheckOutput -notmatch "Memory check: OK" -or $memoryCheckOutput -notmatch "Store: not initialized") {
			throw "cagent --memory-check did not return a clean read-only report."
		}
	} finally {
		Pop-Location
	}

	if (Test-Path -LiteralPath $preloadMarker) {
		throw "The packaged executable evaluated the workspace bunfig preload."
	}
	if (Test-Path -LiteralPath (Join-Path $workspaceRoot ".cagent")) {
		throw "Metadata commands unexpectedly initialized workspace state."
	}

	Write-Output "Windows release smoke test passed."
	Write-Output "  version: cagent $ExpectedVersion"
	Write-Output "  runner: sibling executable present"
	Write-Output "  ripgrep: bundled version 15.2.0"
	Write-Output "  memory check: clean and read-only"
	Write-Output "  workspace dotenv/preload: not evaluated"
} finally {
	if (Test-Path -LiteralPath $temporaryRoot) {
		Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
	}
}
