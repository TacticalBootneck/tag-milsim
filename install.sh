#!/usr/bin/env bash
set -euo pipefail
umask 077

bundle="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
site="$HOME/tag-website"
bot="$HOME/tag-bot"
if ! command -v node >/dev/null; then
  set +u
  source "$HOME/.nvm/nvm.sh"
  set -u
fi
node --input-type=module -e 'import {DatabaseSync} from "node:sqlite"; new DatabaseSync(":memory:").close()'
for path in "$bundle"/portal/*js "$bundle"/bot/*js "$bundle"/dist/campaign.js; do
  node --check "$path"
done
node --test "$bundle/tests/unit-operations.test.mjs" "$bundle/tests/workspace-ui.test.cjs" "$bundle/tests/training-repeat.test.mjs"

if [[ ! -f "$site/portal/.env" || ! -f "$site/portal/roster.mjs" ||
      ! -f "$bot/.env" || ! -f "$bot/ranks.mjs" || ! -f "$bot/participation.mjs" ]]; then
  printf 'The installed TAG website or bot prerequisites are missing. No files were changed.\n' >&2
  exit 1
fi
if ! node --env-file="$site/portal/.env" -e '
  const {realpathSync}=require("node:fs");
  try { if (realpathSync(process.env.TAG_DATA_DIR)!==realpathSync(process.argv[1])) process.exitCode=1; }
  catch { process.exitCode=1; }
' "$bot"; then
  printf 'TAG_DATA_DIR must point to the installed bot folder so the services share records. No files were changed.\n' >&2
  exit 1
fi
website_key="$(sed -n 's/^TAG_WEB_BRIDGE_KEY=//p' "$site/portal/.env" | tail -1)"
bot_key="$(sed -n 's/^TAG_WEB_BRIDGE_KEY=//p' "$bot/.env" | tail -1)"
if [[ ! "$website_key" =~ ^[a-f0-9]{64}$ || "$website_key" != "$bot_key" ]]; then
  printf 'The website and bot need matching TAG_WEB_BRIDGE_KEY settings. No files were changed.\n' >&2
  exit 1
fi

files=()
destination() {
  case "$1" in
    bot/*) printf '%s/%s' "$bot" "${1#bot/}" ;;
    portal/*|dist/*) printf '%s/%s' "$site" "$1" ;;
    *) return 1 ;;
  esac
}
while IFS=$'\t' read -r path allowed; do
  [[ -f "$bundle/$path" ]]
  target="$(destination "$path")"
  if [[ -e "$target" ]]; then
    if cmp -s "$target" "$bundle/$path"; then continue; fi
    result="$(sha256sum "$target")"
    digest="${result%% *}"
    if [[ " $allowed " != *" $digest "* ]]; then
      printf 'Installed file differs from the versions tested for this update: %s. No files were changed.\n' "$path" >&2
      exit 1
    fi
  elif [[ " $allowed " != *" - "* ]]; then
    printf 'Missing installed file: %s. No files were changed.\n' "$path" >&2
    exit 1
  fi
  files+=("$path")
done < "$bundle/versions.tsv"
if [[ "${#files[@]}" -eq 0 ]]; then
  printf 'The update files are already installed.\n'
  exit 0
fi

backup="$(mktemp -d "$HOME/tag-unit-operations-backup.XXXXXXXX")"
staging="$(mktemp -d "$HOME/.tag-unit-operations.XXXXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
for path in "${files[@]}"; do
  target="$(destination "$path")"
  install -D -m 600 "$bundle/$path" "$staging/$path"
  if [[ -f "$target" ]]; then
    mkdir -p "$backup/$(dirname "$path")"
    cp -p -- "$target" "$backup/$path"
    chmod --reference="$target" "$staging/$path"
  fi
done
printf '%s\n' "${files[@]}" > "$backup/installed-files.txt"

moved=()
rollback() {
  for path in "${moved[@]}"; do
    target="$(destination "$path")"
    if [[ -f "$backup/$path" ]]; then cp -p -- "$backup/$path" "$target"
    else rm -f -- "$target"
    fi
  done
}
trap 'rollback; exit 1' ERR
for path in "${files[@]}"; do
  target="$(destination "$path")"
  mkdir -p -- "$(dirname "$target")"
  mv -f -- "$staging/$path" "$target"
  moved+=("$path")
done
trap - ERR
printf 'TAG management update installed. Backups saved at %s\n' "$backup"
printf 'Restart tag-bot.service and tag-website.service to activate both parts of the update.\n'
