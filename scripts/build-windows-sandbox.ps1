[CmdletBinding()]
param(
	[switch]$Install,
	[string]$CargoTargetDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$toolchain = "1.96.0-x86_64-pc-windows-msvc"
$target = "x86_64-pc-windows-msvc"
$binaryName = "cagent-windows-sandbox-runner.exe"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
	throw "The Windows sandbox runner can only be built on Windows."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$manifestPath = Join-Path $repoRoot "native\windows-sandbox-runner\Cargo.toml"
$userProfile = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($userProfile)) {
	throw "Windows did not return the current user's profile directory."
}

if ($Install) {
	if ($PSBoundParameters.ContainsKey("CargoTargetDir")) {
		throw "-CargoTargetDir cannot be used with -Install."
	}
	$localAppData = Join-Path $userProfile "AppData\Local"
	$targetDir = Join-Path $localAppData "cagent\build\windows-sandbox-runner"
	$destinationDir = Join-Path $localAppData "cagent\bin"
	$destinationPath = Join-Path $destinationDir $binaryName
} else {
	if (-not $PSBoundParameters.ContainsKey("CargoTargetDir") -or [string]::IsNullOrWhiteSpace($CargoTargetDir)) {
		throw "An absolute -CargoTargetDir is required when building without -Install."
	}
	if (
		-not [System.IO.Path]::IsPathRooted($CargoTargetDir) -or
		$CargoTargetDir -match "^[A-Za-z]:(?:$|[^\\/])" -or
		$CargoTargetDir -match "^[\\/](?![\\/])"
	) {
		throw "-CargoTargetDir must be an absolute filesystem path: $CargoTargetDir"
	}
	$targetDir = [System.IO.Path]::GetFullPath($CargoTargetDir)
}
$sourcePath = Join-Path $targetDir "$target\release\$binaryName"

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
	throw "Sandbox runner manifest not found: $manifestPath"
}

$rustupPath = Join-Path $userProfile ".cargo\bin\rustup.exe"
if (-not (Test-Path -LiteralPath $rustupPath -PathType Leaf)) {
	throw "Trusted rustup.exe was not found at $rustupPath. Install rustup and the $toolchain toolchain first."
}

$installedToolchains = & $rustupPath toolchain list
if ($LASTEXITCODE -ne 0) {
	throw "Unable to query installed rustup toolchains."
}
$toolchainPattern = "^$([regex]::Escape($toolchain))(?:\s|$)"
if (-not ($installedToolchains | Where-Object { $_ -match $toolchainPattern })) {
	throw "Rust toolchain $toolchain is not installed. Run: rustup toolchain install $toolchain"
}

$programFilesX86 = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFilesX86)
$vswherePath = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
	throw "vswhere.exe was not found. Install Visual Studio 2022 C++ build tools first."
}
$visualStudioPath = & $vswherePath -latest -version "[17.0,18.0)" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($visualStudioPath)) {
	throw "Visual Studio C++ build tools were not found."
}
$vsDevCmd = Join-Path $visualStudioPath.Trim() "Common7\Tools\VsDevCmd.bat"
if (-not (Test-Path -LiteralPath $vsDevCmd -PathType Leaf)) {
	throw "VsDevCmd.bat was not found: $vsDevCmd"
}
$environmentCommand = "call `"$vsDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
$trustedCmd = Join-Path ([System.Environment]::SystemDirectory) "cmd.exe"
$visualStudioEnvironment = & $trustedCmd /d /s /c $environmentCommand
if ($LASTEXITCODE -ne 0) {
	throw "Failed to initialize the Visual Studio x64 build environment."
}
foreach ($entry in $visualStudioEnvironment) {
	$separator = $entry.IndexOf("=")
	if ($separator -le 0) {
		continue
	}
	$name = $entry.Substring(0, $separator)
	$value = $entry.Substring($separator + 1)
	[System.Environment]::SetEnvironmentVariable($name, $value, "Process")
}

# Cargo resolves its compiler child through configuration and PATH. A separate
# Chocolatey/MSYS Rust or wrapper can otherwise mix a GNU compiler with the
# MSVC target. Resolve the selected toolchain's executables up front, clear
# common override variables, and prepend that toolchain to PATH.
$rustcPath = & $rustupPath which rustc --toolchain $toolchain
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($rustcPath)) {
	throw "Unable to resolve rustc for toolchain $toolchain."
}
$rustdocPath = & $rustupPath which rustdoc --toolchain $toolchain
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($rustdocPath)) {
	throw "Unable to resolve rustdoc for toolchain $toolchain."
}
$rustcPath = $rustcPath.Trim()
$rustdocPath = $rustdocPath.Trim()
$toolchainBin = Split-Path -Parent $rustcPath
$cargoPath = & $rustupPath which cargo --toolchain $toolchain
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($cargoPath)) {
	throw "Unable to resolve cargo for toolchain $toolchain."
}
$cargoPath = $cargoPath.Trim()
foreach ($name in @(
	"RUSTC_WRAPPER",
	"RUSTC_WORKSPACE_WRAPPER",
	"RUSTFLAGS",
	"CARGO_ENCODED_RUSTFLAGS",
	"CARGO_BUILD_RUSTC",
	"CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER",
	"CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS"
)) {
	[System.Environment]::SetEnvironmentVariable($name, $null, "Process")
}
$env:RUSTC = $rustcPath
$env:RUSTDOC = $rustdocPath
$env:RUSTUP_TOOLCHAIN = $toolchain
$env:Path = "$toolchainBin;$env:Path"

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Push-Location $targetDir
try {
	& $cargoPath build `
		--manifest-path $manifestPath `
		--target $target `
		--target-dir $targetDir `
		--release `
		--locked
} finally {
	Pop-Location
}
if ($LASTEXITCODE -ne 0) {
	throw "Windows sandbox runner build failed with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
	throw "Expected sandbox runner was not produced: $sourcePath"
}

if ($Install) {
	New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
	$stagedPath = Join-Path $destinationDir ".$binaryName.$([guid]::NewGuid().ToString('N')).tmp"
	$backupPath = Join-Path $destinationDir ".$binaryName.$([guid]::NewGuid().ToString('N')).bak"
	$installError = $null
	$cleanupError = $null
	$installSucceeded = $false
	try {
		Copy-Item -LiteralPath $sourcePath -Destination $stagedPath
		if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
			[System.IO.File]::Replace($stagedPath, $destinationPath, $backupPath, $true)
		} else {
			[System.IO.File]::Move($stagedPath, $destinationPath)
		}
		$installSucceeded = $true
	} catch {
		$installError = $_
	}
	if (Test-Path -LiteralPath $stagedPath -PathType Leaf) {
		try {
			Remove-Item -LiteralPath $stagedPath -Force
		} catch {
			$cleanupError = $_
		}
	}
	if ($installSucceeded -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
		try {
			Remove-Item -LiteralPath $backupPath -Force
		} catch {
			$cleanupError = $_
		}
	} elseif (Test-Path -LiteralPath $backupPath -PathType Leaf) {
		Write-Warning "Installation failed; retained recovery backup at $backupPath"
	}
	if ($null -ne $installError) {
		throw $installError
	}
	if ($null -ne $cleanupError) {
		throw $cleanupError
	}
	$resultPath = $destinationPath
} else {
	$resultPath = $sourcePath
}

$stream = [System.IO.File]::OpenRead($resultPath)
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
if ($Install) {
	Write-Output "Built and installed $resultPath"
} else {
	Write-Output "Built $resultPath"
}
Write-Output "SHA256 $hash"
