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

Write-Host "Installed globally. Restart OpenCode, then type /profile in the TUI."
