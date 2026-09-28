$ErrorActionPreference = "Stop"

$repository = "SaymonMaster14/opencode-profile-switcher"
if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
  throw "OpenCode was not found in PATH. Install OpenCode first, then run this command again."
}

$release = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/$repository/commits/main" `
  -Headers @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "opencode-profile-switcher-installer" }

if ($release.sha -notmatch "^[0-9a-f]{40}$") {
  throw "GitHub did not return a valid main commit for $repository."
}

$plugin = "github:$repository#$($release.sha)"
Write-Host "Installing OpenCode Profile Switcher globally from commit $($release.sha.Substring(0, 12))..."
& opencode plugin $plugin --global --force
if ($LASTEXITCODE -ne 0) {
  throw "OpenCode could not install $plugin."
}

$paths = (& opencode debug paths | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "OpenCode could not report its global config directory."
}
$configMatch = [regex]::Match($paths, '(?m)^config\s+(.+?)\s*$')
if (-not $configMatch.Success) {
  throw "OpenCode did not report a global config directory."
}
$configDirectory = $configMatch.Groups[1].Value

foreach ($fileName in @("opencode.json", "tui.json")) {
  $configPath = Join-Path $configDirectory $fileName
  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "OpenCode did not create its global $fileName."
  }

  $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  $plugins = [System.Collections.Generic.List[object]]::new()
  foreach ($entry in @($config.plugin)) {
    $spec = if ($entry -is [string]) { $entry } elseif ($entry -is [array] -and $entry.Count -gt 0) { $entry[0] } else { $null }
    if ($spec -is [string] -and $spec.StartsWith("github:$repository#", [StringComparison]::OrdinalIgnoreCase)) { continue }
    $plugins.Add($entry)
  }
  $plugins.Add($plugin)
  $config | Add-Member -NotePropertyName plugin -NotePropertyValue $plugins.ToArray() -Force

  $temporaryPath = "$configPath.tmp"
  $json = ConvertTo-Json -InputObject $config -Depth 100
  [IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force
}

Write-Host "Installed globally. Restart OpenCode, then type /profile in the TUI."
