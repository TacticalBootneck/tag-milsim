#!/usr/bin/env bash
set -euo pipefail
if (( EUID == 0 )); then
  echo 'Run this as the Ubuntu account that will own and run the bot.' >&2
  exit 1
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ! -f .env ]]; then
  echo 'Copy your existing .env into this folder before installing.' >&2
  exit 1
fi
node_bin="$(command -v node)" || { echo 'Node.js 22.12 or newer is required.' >&2; exit 1; }
"$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error("Node.js 22.12 or newer is required."); process.exit(1); }'
chmod 600 .env
"$node_bin" --check bot.mjs
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
service_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$service_dir"
cat > "$service_dir/tag-bot.service" <<UNIT
[Unit]
Description=TAG MILSIM Discord bot

[Service]
Type=simple
WorkingDirectory=$PWD
ExecStart="$node_bin" --env-file=.env bot.mjs
Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable tag-bot.service
echo 'Service installed. Stop the Windows bot, copy the final JSON backups, then run systemctl --user start tag-bot.service.'
