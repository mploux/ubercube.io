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
    stop) printf stopped > "$SHELL_TEST_ROOT/service-state" ;;
    start) printf active > "$SHELL_TEST_ROOT/service-state" ;;
    is-active) [[ $(cat "$SHELL_TEST_ROOT/service-state") == active ]] ;;
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
  mkdir -p "$upload/input/src/server" "$upload/input/src/shared" "$upload/validation/tests" "$upload/validation/src/client"
  printf 'new source\n' > "$upload/input/src/server/index.ts"
  printf 'protocol fixture\n' > "$upload/input/src/shared/protocol.ts"
  printf 'test fixture\n' > "$upload/validation/tests/server.test.ts"
  printf 'client fixture\n' > "$upload/validation/src/client/input-button.ts"
  printf 'client fixture\n' > "$upload/validation/src/client/terrain.worker.ts"
  (cd "$upload/input" && sha256sum src/server/index.ts src/shared/protocol.ts > server.sha256)
  tar -czf "$upload/server.tar.gz" -C "$upload/input" src/server/index.ts src/shared/protocol.ts server.sha256
  tar -czf "$upload/validation.tar.gz" -C "$upload/validation" tests/server.test.ts src/client/input-button.ts src/client/terrain.worker.ts
  (cd "$upload" && sha256sum server.tar.gz validation.tar.gz > archives.sha256)
  # Redirect fixed deployment paths into this disposable fixture; preserve operational logic.
  sed -e "s|^base=/opt/ubercube$|base=$testroot/live|" \
    -e 's/\$HOME/\$SHELL_TEST_HOME/g' \
    -e 's|^    \[\[ $upload =~ .*|    [[ $upload == "$SHELL_TEST_HOME/ubercube-releases/$id" \&\& $(realpath "$upload") == "$upload" ]]|' \
    "$source_script" > "$upload/server.sh"
  grep -q "^base=$testroot/live$" "$upload/server.sh"
  ! grep -q '/opt/ubercube' "$upload/server.sh"
}
if [[ ${1:-} == --stage ]]; then
  for id in 20260913-190001 20260913-190002 20260913-190003 20260913-190004; do make_upload "$id"; done
  bash "$SHELL_TEST_HOME/ubercube-releases/20260913-190001/server.sh" stage 20260913-190001
  bash "$SHELL_TEST_HOME/ubercube-releases/20260913-190002/server.sh" stage 20260913-190002
  if FAIL_TESTS=1 bash "$SHELL_TEST_HOME/ubercube-releases/20260913-190003/server.sh" stage 20260913-190003; then exit 1; fi
  [[ ! -e $SHELL_TEST_HOME/ubercube-releases/20260913-190003/staged/validated.sha256 ]]
  printf corrupt >> "$SHELL_TEST_HOME/ubercube-releases/20260913-190004/server.tar.gz"
  if bash "$SHELL_TEST_HOME/ubercube-releases/20260913-190004/server.sh" stage 20260913-190004; then exit 1; fi
  [[ ! -d $SHELL_TEST_HOME/ubercube-releases/20260913-190004/staged ]]
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
  id=20260913-190001
  bash "$SHELL_TEST_HOME/ubercube-releases/$id/server.sh" activate "$id" "$SHELL_TEST_HOME/ubercube-releases/$id"
  grep -q 'new source' "$testroot/live/src/server/index.ts"
  if FAIL_PREVIOUS=1 bash "$testroot/live/releases/$id/server.sh" rollback "$id"; then exit 1; fi
  grep -q 'new source' "$testroot/live/src/server/index.ts"
  bash "$testroot/live/releases/$id/server.sh" rollback "$id"
  grep -q 'previous source' "$testroot/live/src/server/index.ts"
  id=20260913-190002
  if FAIL_NEW=1 bash "$SHELL_TEST_HOME/ubercube-releases/$id/server.sh" activate "$id" "$SHELL_TEST_HOME/ubercube-releases/$id"; then exit 1; fi
  grep -q 'previous source' "$testroot/live/src/server/index.ts"
  [[ $(cat "$testroot/service-state") == active ]]
} >> "$testroot/results.log" 2>&1
echo 'PASS: staging; failed tests; corrupt archive; activation; rollback; recovery after failed activation and rollback.'
