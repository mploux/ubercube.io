#!/usr/bin/env bash
# Linux fixture rehearsal: real files/tar/hashes; mocked Bun, systemd, curl and sleep.
set -Eeuo pipefail
source_script=$(cd "$(dirname "$0")/../scripts/release" && pwd)/server.sh
if [[ ${1:-} == --stage ]]; then
  [[ $# -eq 2 && $EUID -ne 0 ]]
  testroot=$2
else
  [[ $# -eq 1 && $EUID -eq 0 && $1 =~ ^--user=([A-Za-z0-9_-]+)$ ]] || {
    echo 'Usage: sudo bash tests/release-server.sh --user=YOUR_LINUX_USER' >&2; exit 1;
  }
  testuser=${BASH_REMATCH[1]}
  [[ $(id -u "$testuser") -ne 0 ]]
  testroot=$(mktemp -d /tmp/ubercube-server-test.XXXXXX)
  chown "$testuser" "$testroot"
fi
[[ $testroot =~ ^/tmp/ubercube-server-test\.[A-Za-z0-9]+$ && ! -L $testroot ]]
export SHELL_TEST_HOME=$testroot/home SHELL_TEST_ROOT=$testroot
bun() { [[ ${FAIL_TESTS:-0} != 1 ]]; }
sleep() { :; }
systemctl() {
  [[ $2 == ubercube || $2 == --quiet ]]
  case "$1" in
    stop) printf 'stop\n' >> "$SHELL_TEST_ROOT/service-mutations"; printf stopped > "$SHELL_TEST_ROOT/service-state" ;;
    start) printf 'start\n' >> "$SHELL_TEST_ROOT/service-mutations"; printf active > "$SHELL_TEST_ROOT/service-state" ;;
    is-active) [[ $(cat "$SHELL_TEST_ROOT/service-state") == active ]] ;;
    show) [[ $# -eq 4 && $3 == --property=User && $4 == --value ]]; printf '%s\n' "${CHECK_SERVICE_USER-}" ;;
    *) return 1 ;;
  esac
}
curl() {
  if [[ ${FAIL_NEW:-0} == 1 ]] && grep -q 'new source' "$SHELL_TEST_ROOT/live/src/server/index.ts"; then return 22; fi
  if [[ ${FAIL_PREVIOUS:-0} == 1 ]] && grep -q 'previous source' "$SHELL_TEST_ROOT/live/src/server/index.ts"; then return 22; fi
  printf '{"ok":true}\n'
}
export -f bun sleep systemctl curl
make_upload() {
  local upload=$SHELL_TEST_HOME/ubercube-releases/$1
  mkdir -p "$upload/input/src/server" "$upload/input/src/shared" "$upload/input/public/maps" \
    "$upload/input/public/map-credits/licenses" "$upload/input/public/map-credits/sources/converter/scripts" \
    "$upload/validation/tests" "$upload/validation/src/client" "$upload/validation/scripts"
  printf 'new source\n' > "$upload/input/src/server/index.ts"
  printf 'protocol fixture\n' > "$upload/input/src/shared/protocol.ts"
  printf 'new catalog\n' > "$upload/input/public/maps/catalog.json"
  printf 'new map\n' > "$upload/input/public/maps/$(printf '%064d' 1).ucmap"
  printf 'new credits\n' > "$upload/input/public/map-credits/index.html"
  printf 'new license\n' > "$upload/input/public/map-credits/licenses/GPL-3.0.txt"
  printf 'new original\n' > "$upload/input/public/map-credits/sources/Original.vxl"
  printf 'new metadata\n' > "$upload/input/public/map-credits/sources/Original.json"
  printf 'new converter\n' > "$upload/input/public/map-credits/sources/converter/scripts/import-vxl.ts"
  printf 'test fixture\n' > "$upload/validation/tests/server.test.ts"
  printf 'client fixture\n' > "$upload/validation/src/client/input-button.ts"
  printf 'client fixture\n' > "$upload/validation/src/client/terrain.worker.ts"
  printf 'client fixture\n' > "$upload/validation/src/client/map-loader.ts"
  printf 'converter fixture\n' > "$upload/validation/scripts/import-vxl.ts"
  tar -czf "$upload/validation.tar.gz" -C "$upload/validation" tests/server.test.ts src/client/input-button.ts src/client/terrain.worker.ts src/client/map-loader.ts scripts/import-vxl.ts
  (cd "$upload/input" && find src public -type f -print0 | sort -z | xargs -0 sha256sum > server.sha256)
  pack_upload "$1"
  # Redirect fixed deployment paths into this disposable fixture; preserve operational logic.
  sed -e "s|^base=/opt/ubercube$|base=$testroot/live|" \
    -e 's/\$HOME/\$SHELL_TEST_HOME/g' \
    -e 's|^    \[\[ $upload =~ .*|    [[ $upload == "$SHELL_TEST_HOME/ubercube-releases/$id" \&\& $(realpath "$upload") == "$upload" ]]|' \
    "$source_script" > "$upload/server.sh"
  grep -q "^base=$testroot/live$" "$upload/server.sh"
  ! grep -q '/opt/ubercube' "$upload/server.sh"
}
pack_upload() {
  local upload=$SHELL_TEST_HOME/ubercube-releases/$1
  (cd "$upload/input" && find src public -type f -o -type l | sort > "$upload/files")
  printf 'server.sha256\n' >> "$upload/files"
  tar -czf "$upload/server.tar.gz" -C "$upload/input" -T "$upload/files"
  (cd "$upload" && sha256sum server.tar.gz validation.tar.gz > archives.sha256)
}
if [[ ${1:-} == --stage ]]; then
  for suffix in {01..12}; do make_upload "20260913-1900$suffix"; done
  for suffix in 01 02 09 10 11 12; do
    id=20260913-1900$suffix
    bash "$SHELL_TEST_HOME/ubercube-releases/$id/server.sh" stage "$id"
  done
  if FAIL_TESTS=1 bash "$SHELL_TEST_HOME/ubercube-releases/20260913-190003/server.sh" stage 20260913-190003; then exit 1; fi
  [[ ! -e $SHELL_TEST_HOME/ubercube-releases/20260913-190003/staged/validated.sha256 ]]
  printf corrupt >> "$SHELL_TEST_HOME/ubercube-releases/20260913-190004/server.tar.gz"
  if bash "$SHELL_TEST_HOME/ubercube-releases/20260913-190004/server.sh" stage 20260913-190004; then exit 1; fi
  [[ ! -d $SHELL_TEST_HOME/ubercube-releases/20260913-190004/staged ]]
  # Links, unrelated public files, unlisted files and duplicate manifest rows all fail closed.
  ln -s /etc/passwd "$SHELL_TEST_HOME/ubercube-releases/20260913-190005/input/public/map-credits/licenses/linked.txt"
  mkdir -p "$SHELL_TEST_HOME/ubercube-releases/20260913-190006/input/public/assets"
  printf unrelated > "$SHELL_TEST_HOME/ubercube-releases/20260913-190006/input/public/assets/unrelated.js"
  printf unlisted > "$SHELL_TEST_HOME/ubercube-releases/20260913-190007/input/public/map-credits/licenses/extra.txt"
  upload=$SHELL_TEST_HOME/ubercube-releases/20260913-190008
  sed -i '/  public\/maps\/catalog.json$/d' "$upload/input/server.sha256"
  head -n 1 "$upload/input/server.sha256" >> "$upload/input/server.sha256"
  for suffix in 05 06 07 08; do
    id=20260913-1900$suffix
    pack_upload "$id"
    if bash "$SHELL_TEST_HOME/ubercube-releases/$id/server.sh" stage "$id"; then exit 1; fi
    [[ ! -e $SHELL_TEST_HOME/ubercube-releases/$id/staged/validated.sha256 ]]
  done
  printf tampered >> "$SHELL_TEST_HOME/ubercube-releases/20260913-190009/staged/public/maps/catalog.json"
  printf unlisted > "$SHELL_TEST_HOME/ubercube-releases/20260913-190010/staged/public/map-credits/licenses/extra.txt"
  if bash "$SHELL_TEST_HOME/ubercube-releases/20260913-190001/server.sh" check; then exit 1; fi
  exit 0
fi
cleanup() {
  local status=$?
  if [[ $status -ne 0 && -f $testroot/results.log ]]; then cat "$testroot/results.log" >&2; fi
  [[ $testroot =~ ^/tmp/ubercube-server-test\.[A-Za-z0-9]+$ && ! -L $testroot ]] && rm -rf -- "$testroot"
  exit "$status"
}
trap cleanup EXIT
runuser -u "$testuser" -- bash "$(realpath "$0")" --stage "$testroot" > "$testroot/results.log" 2>&1
{
  mkdir -p "$testroot/live/src/server" "$testroot/live/src/shared"
  printf 'previous source\n' > "$testroot/live/src/server/index.ts"
  printf 'previous protocol\n' > "$testroot/live/src/shared/protocol.ts"
  printf active > "$testroot/service-state"
  export CHECK_SERVICE_USER=$testuser
  installed_helper=$testroot/ubercube-release
  cp "$SHELL_TEST_HOME/ubercube-releases/20260913-190001/server.sh" "$installed_helper"
  chmod 755 "$installed_helper"
  helper_hash=$(sha256sum "$installed_helper")
  printf -v expected_check '{"ready":true,"service":"ubercube","serviceUid":%s,"helperSha256":"%s"}' "$(id -u "$testuser")" "${helper_hash%% *}"
  [[ $("$installed_helper" check) == "$expected_check" ]]
  if "$installed_helper" check extra; then exit 1; fi
  if CHECK_SERVICE_USER=root "$installed_helper" check; then exit 1; fi
  if CHECK_SERVICE_USER=0 "$installed_helper" check; then exit 1; fi
  if CHECK_SERVICE_USER='' "$installed_helper" check; then exit 1; fi
  printf stopped > "$testroot/service-state"
  if "$installed_helper" check; then exit 1; fi
  [[ $(cat "$testroot/service-state") == stopped && ! -e $testroot/service-mutations ]]
  printf active > "$testroot/service-state"
  # Reject post-test mutation and additions before stopping the service.
  for suffix in 09 10; do
    id=20260913-1900$suffix
    if "$installed_helper" activate "$id" "$SHELL_TEST_HOME/ubercube-releases/$id"; then exit 1; fi
    [[ ! -e $testroot/service-mutations ]]
  done
  [[ ! -e $testroot/live/public ]]
  id=20260913-190001
  "$installed_helper" activate "$id" "$SHELL_TEST_HOME/ubercube-releases/$id"
  grep -q 'new source' "$testroot/live/src/server/index.ts"
  grep -q 'new catalog' "$testroot/live/public/maps/catalog.json"
  grep -q 'new original' "$testroot/live/public/map-credits/sources/Original.vxl"
  [[ ! -e $testroot/live/src/client && ! -e $testroot/live/scripts ]]
  if FAIL_PREVIOUS=1 bash "$testroot/live/releases/$id/server.sh" rollback "$id"; then exit 1; fi
  grep -q 'new source' "$testroot/live/src/server/index.ts"
  grep -q 'new catalog' "$testroot/live/public/maps/catalog.json"
  # An extra or changed live asset must prevent rolling back another state.
  printf extra > "$testroot/live/public/maps/$(printf '%064d' 2).ucmap"
  if "$installed_helper" rollback "$id"; then exit 1; fi
  rm "$testroot/live/public/maps/$(printf '%064d' 2).ucmap"
  printf tampered >> "$testroot/live/public/map-credits/index.html"
  if "$installed_helper" rollback "$id"; then exit 1; fi
  cp "$testroot/live/releases/$id/public/map-credits/index.html" "$testroot/live/public/map-credits/index.html"
  "$installed_helper" rollback "$id"
  grep -q 'previous source' "$testroot/live/src/server/index.ts"
  [[ ! -e $testroot/live/public/maps && ! -e $testroot/live/public/map-credits ]]
  mkdir -p "$testroot/live/public/assets"
  printf untouched > "$testroot/live/public/assets/client.js"
  id=20260913-190002
  if FAIL_NEW=1 bash "$SHELL_TEST_HOME/ubercube-releases/$id/server.sh" activate "$id" "$SHELL_TEST_HOME/ubercube-releases/$id"; then exit 1; fi
  grep -q 'previous source' "$testroot/live/src/server/index.ts"
  [[ ! -e $testroot/live/public/maps && ! -e $testroot/live/public/map-credits ]]
  # The same success/failure paths preserve an existing asset set, removing obsolete files on activation.
  mkdir -p "$testroot/live/public/maps" "$testroot/live/public/map-credits/licenses"
  printf 'previous catalog\n' > "$testroot/live/public/maps/catalog.json"
  printf 'previous map\n' > "$testroot/live/public/maps/$(printf '%064d' 3).ucmap"
  printf 'previous credits\n' > "$testroot/live/public/map-credits/index.html"
  printf 'previous license\n' > "$testroot/live/public/map-credits/licenses/old.txt"
  id=20260913-190011
  "$installed_helper" activate "$id" "$SHELL_TEST_HOME/ubercube-releases/$id"
  [[ ! -e $testroot/live/public/maps/$(printf '%064d' 3).ucmap && ! -e $testroot/live/public/map-credits/licenses/old.txt ]]
  if FAIL_PREVIOUS=1 "$installed_helper" rollback "$id"; then exit 1; fi
  grep -q 'new catalog' "$testroot/live/public/maps/catalog.json"
  [[ ! -e $testroot/live/public/map-credits/licenses/old.txt ]]
  "$installed_helper" rollback "$id"
  grep -q 'previous catalog' "$testroot/live/public/maps/catalog.json"
  grep -q 'previous license' "$testroot/live/public/map-credits/licenses/old.txt"
  [[ ! -e $testroot/live/public/map-credits/sources ]]
  id=20260913-190012
  if FAIL_NEW=1 "$installed_helper" activate "$id" "$SHELL_TEST_HOME/ubercube-releases/$id"; then exit 1; fi
  grep -q 'previous source' "$testroot/live/src/server/index.ts"
  grep -q 'previous catalog' "$testroot/live/public/maps/catalog.json"
  grep -q 'previous license' "$testroot/live/public/map-credits/licenses/old.txt"
  [[ ! -e $testroot/live/public/map-credits/sources ]]
  [[ $(cat "$testroot/live/public/assets/client.js") == untouched ]]
  [[ $(cat "$testroot/service-state") == active ]]
} >> "$testroot/results.log" 2>&1
echo 'PASS: privileged checks; staging and map assets; failed tests, corrupt/unsafe archives and manifests; post-test and live mutations; activation/rollback and failure recovery with existing or absent map assets; unrelated public files preserved.'
