#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 || ! "$1" =~ ^[0-9]{17,20}$ ]]; then
  printf 'Pass the Discord TAG Commander role ID as the only argument.\n' >&2
  exit 1
fi
bundle="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
website_env="$HOME/tag-website/portal/.env"
units=(tag-bot.service tag-website.service)

for unit in "${units[@]}"; do
  if [[ "$(systemctl --user show "$unit" -p LoadState --value)" != loaded ]]; then
    printf 'The existing service %s could not be found. No files were changed.\n' "$unit" >&2
    exit 1
  fi
done

bash "$bundle/install.sh"

if ! grep -Fxq "TAG_HONOURS_COMMANDER_ROLE_ID=$1" "$website_env"; then
  config_backup="$(mktemp "$HOME/tag-website-env-backup.XXXXXXXX")"
  cp -- "$website_env" "$config_backup"
  sed -i -E '/^[[:space:]]*(export[[:space:]]+)?TAG_HONOURS_COMMANDER_ROLE_ID[[:space:]]*=/d' "$website_env"
  printf '\nTAG_HONOURS_COMMANDER_ROLE_ID=%s\n' "$1" >> "$website_env"
fi

systemctl --user restart "${units[@]}"
for attempt in {1..20}; do
  invocation="$(systemctl --user show tag-bot.service -p InvocationID --value)"
  if systemctl --user is-active --quiet tag-bot.service &&
     systemctl --user is-active --quiet tag-website.service &&
     [[ -n "$invocation" ]] &&
     journalctl --user "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager -o cat |
       grep -F 'Ready in ' > /dev/null &&
     homepage="$(curl -fsS --max-time 5 https://tagmilsim.co.uk/ 2>/dev/null)" &&
     [[ "$homepage" == *'Recognising service in TAG'* ]] &&
     curl -fsS --max-time 5 -o /dev/null https://tagmilsim.co.uk/members/ 2>/dev/null; then
    printf '\nTAG UPDATE COMPLETE. The new homepage, members portal and Discord bot are responding.\n'
    exit 0
  fi
  sleep 3
done
printf '\nThe files were installed, but a live health check did not pass.\n' >&2
systemctl --user show "${units[@]}" -p Id -p ActiveState -p SubState
exit 1
