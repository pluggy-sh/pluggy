# install.ps1
#
# Installs the pluggy CLI into %LOCALAPPDATA%\Programs\pluggy and adds it
# to the user PATH. No administrator privileges required.

param(
    [string]$Repo = "ch99q/pluggy",
    [string]$Binary = "pluggy"
)

$ErrorActionPreference = "Stop"

function Get-Arch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64" { return "amd64" }
        "ARM64" { return "arm64" }
        default { throw "Unsupported architecture: $($env:PROCESSOR_ARCHITECTURE)" }
    }
}

function Add-UserPath($InstallDir) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = if ($userPath) { $userPath -split ";" } else { @() }
    if ($entries -notcontains $InstallDir) {
        $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "Added $InstallDir to your user PATH."
        Write-Host "Open a new terminal to pick up the change."
    }
}

$arch = Get-Arch
$os = "windows"
$exeName = "$Binary.exe"
$assetName = "$Binary-$os-$arch.exe"
$downloadUrl = "https://github.com/$Repo/releases/latest/download/$assetName"
$installDir = "$env:LOCALAPPDATA\Programs\$Binary"

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir | Out-Null
}

$dest = Join-Path $installDir $exeName

Write-Host "Downloading $downloadUrl"
Invoke-WebRequest -Uri $downloadUrl -OutFile $dest

Write-Host "Installed $Binary to $dest"

Add-UserPath $installDir

Write-Host "`nRun 'pluggy -V' from a new terminal to verify the install."
