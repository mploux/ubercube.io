#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
umask 022
action=${1:-}
if [[ $action == check ]]; then
  [[ $# -eq 1 && $EUID -eq 0 ]] || { echo 'Run the installed release helper with sudo -n and check only' >&2; exit 1; }
  systemctl is-active --quiet ubercube || { echo 'The ubercube service is not active' >&2; exit 1; }
  service_user=$(systemctl show ubercube --property=User --value)
  [[ -n $service_user ]] || { echo 'The ubercube service must configure a non-root User' >&2; exit 1; }
  service_uid=$(id -u "$service_user")
  [[ $service_uid =~ ^[0-9]+$ && $service_uid -ne 0 ]] || { echo 'The ubercube service must run as a non-root user' >&2; exit 1; }
  helper_hash=$(sha256sum "$0")
  printf '{"ready":true,"service":"ubercube","serviceUid":%s,"helperSha256":"%s"}\n' "$service_uid" "${helper_hash%% *}"
  exit 0
fi
id=${2:-}
[[ $id =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo 'Release id must be YYYYMMDD-HHMMSS' >&2; exit 1; }
base=/opt/ubercube
release=$base/releases/$id
source_path='src/(server|shared)/([A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.ts'
asset_path='public/(maps/(catalog\.json|[0-9a-f]{64}\.ucmap)|map-credits/(index\.html|licenses/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.txt|sources/([A-Za-z0-9_-]+\.(vxl|json)|converter/(README\.txt|scripts/import-vxl\.ts|src/shared/imported-map\.ts))))'
server_path="($source_path|$asset_path)"
health() {
  for attempt in {1..20}; do
    if systemctl is-active --quiet ubercube && curl --max-time 2 -fsS http://127.0.0.1:3000/health; then return 0; fi
    sleep 1
  done
  return 1
}
verify_tree() {
  local directory=$1 checksums=$2
  local roots=(src/server src/shared) asset
  [[ -s $checksums && ! -L $checksums ]]
  if grep -Ev "^[0-9a-f]{64}  $server_path$" "$checksums"; then echo 'Unsupported server manifest path' >&2; return 1; fi
  [[ -d $directory/src && ! -L $directory/src ]]
  [[ ! -L $directory/public ]]
  for asset in maps map-credits; do
    if [[ -e $directory/public/$asset || -L $directory/public/$asset ]]; then
      [[ -d $directory/public/$asset && ! -L $directory/public/$asset ]]
      roots+=("public/$asset")
    fi
  done
  for asset in "${roots[@]}"; do
    [[ -d $directory/$asset && ! -L $directory/$asset ]]
    [[ -z $(find "$directory/$asset" ! -type d ! -type f -print -quit) ]]
  done
  # Compare names as well as hashes: duplicated manifest rows cannot hide extra files.
  diff -u <(cut -c67- "$checksums" | sort) <(cd "$directory" && find "${roots[@]}" -type f | sort)
  (cd "$directory" && sha256sum --strict -c "$checksums")
}
copy_assets() {
  local source=$1 target=$2 asset
  mkdir -p "$target/public"
  for asset in maps map-credits; do
    if [[ -d $source/public/$asset ]]; then cp -a "$source/public/$asset" "$target/public/"; fi
  done
}
verify_previous() {
  [[ ! -L $release/previous-src && ! -L $release/previous-public ]]
  [[ -z $(find "$release/previous-src" "$release/previous-public" ! -type d ! -type f -print -quit) ]]
  diff -u <(cut -c67- "$release/previous.sha256" | sort) \
    <(cd "$release" && find previous-src previous-public -type f | sed -e 's|^previous-src/|src/|' -e 's|^previous-public/|public/|' | sort)
  (cd "$release" && sed -e 's|  src/|  previous-src/|' -e 's|  public/|  previous-public/|' previous.sha256 | sha256sum --strict -c -)
}
case "$action" in
  stage)
    [[ $# -eq 2 && $EUID -ne 0 ]] || { echo 'Run stage as the SSH user, without sudo' >&2; exit 1; }
    upload=$HOME/ubercube-releases/$id
    [[ $(realpath "$(dirname "$0")") == "$upload" && ! -L $upload && ! -e $upload/staged ]]
    cd "$upload"
    [[ $(wc -l < archives.sha256) -eq 2 ]]
    grep -Eq '^[0-9a-f]{64}  server\.tar\.gz$' archives.sha256
    grep -Eq '^[0-9a-f]{64}  validation\.tar\.gz$' archives.sha256
    sha256sum --strict -c archives.sha256
    for archive in server validation; do
      [[ -f $archive.tar.gz && ! -L $archive.tar.gz ]]
      # Archives contain only named regular files, never links, directories or extraction paths.
      tar -tzf "$archive.tar.gz" > "$archive.entries"
      tar -tvzf "$archive.tar.gz" > "$archive.types"
      [[ -s $archive.entries ]]
      if grep -qv '^-' "$archive.types"; then echo 'Archives must contain only regular files' >&2; exit 1; fi
      if [[ $archive == server ]]; then
        if grep -Ev "^($server_path|server\.sha256)$" "$archive.entries"; then echo 'Unsupported server archive path' >&2; exit 1; fi
      else
        if grep -Ev '^(tests/[A-Za-z0-9_-]+\.test\.ts|src/client/(terrain\.worker|input-button|map-loader)\.ts|scripts/import-vxl\.ts)$' "$archive.entries"; then echo 'Unsupported validation archive path' >&2; exit 1; fi
      fi
      [[ $(sort -u "$archive.entries" | wc -l) -eq $(wc -l < "$archive.entries") ]]
    done
    mkdir staged
    tar --no-same-owner --no-same-permissions -xzf server.tar.gz -C staged
    tar --no-same-owner --no-same-permissions -xzf validation.tar.gz -C staged
    [[ -f staged/public/maps/catalog.json && -f staged/public/map-credits/index.html ]]
    verify_tree "$upload/staged" "$upload/staged/server.sha256"
    (cd staged && bun test tests 2>&1) | tee linux-tests.log
    sha256sum server.tar.gz validation.tar.gz > staged/validated.sha256
    (cd staged && find src tests scripts public/maps public/map-credits -type f -print0 | sort -z | xargs -0 sha256sum) > staged/tested.sha256
    echo "Staged and tested $id; production has not changed."
    ;;
  activate)
    [[ $# -eq 3 && $EUID -eq 0 ]] || { echo 'Usage: sudo -n /usr/local/libexec/ubercube-release activate ID /home/USER/ubercube-releases/ID' >&2; exit 1; }
    upload=$3
    [[ $upload =~ ^/home/[A-Za-z0-9_-]+/ubercube-releases/$id$ && $(realpath "$upload") == "$upload" ]]
    [[ ! -e $release && -d $base/src && ! -L $base/src && ! -L $base/public ]]
    [[ ! -e $base/public || -d $base/public ]]
    [[ -f $upload/staged/validated.sha256 && -f $upload/linux-tests.log ]]
    (cd "$upload" && sha256sum --strict -c staged/validated.sha256)
    (cd "$upload/staged" && sha256sum --strict -c tested.sha256)
    mkdir -p "$base/releases"
    [[ ! -L $base && ! -L $base/releases ]]
    mkdir "$release"
    mkdir "$release/src"
    cp -a "$upload/staged/src/server" "$upload/staged/src/shared" "$release/src/"
    copy_assets "$upload/staged" "$release"
    cp "$upload/staged/server.sha256" "$release/server.sha256"
    cp "$0" "$release/server.sh"
    cp "$upload/linux-tests.log" "$release/linux-tests.log"
    chown -R root:root "$release"
    chmod -R go-w "$release"
    verify_tree "$release" "$release/server.sha256"
    cp -a "$base/src" "$release/previous-src"
    mkdir "$release/previous-public"
    previous_roots=(src)
    for asset in maps map-credits; do
      if [[ -e $base/public/$asset || -L $base/public/$asset ]]; then
        [[ -d $base/public/$asset && ! -L $base/public/$asset ]]
        cp -a "$base/public/$asset" "$release/previous-public/"
        previous_roots+=("public/$asset")
      fi
    done
    (cd "$base" && find "${previous_roots[@]}" -type f -print0 | sort -z | xargs -0 sha256sum) > "$release/previous.sha256"
    verify_previous
    chown -R root:root "$release/previous-src" "$release/previous-public"
    chmod -R go-w "$release/previous-src" "$release/previous-public"
    restore() {
      trap - ERR
      echo 'Activation failed; restoring previous sources and map assets.' >&2
      systemctl stop ubercube || true
      rm -rf -- "$base/src" "$base/public/maps" "$base/public/map-credits"
      cp -a "$release/previous-src" "$base/src"
      for asset in maps map-credits; do
        if [[ -d $release/previous-public/$asset ]]; then mkdir -p "$base/public"; cp -a "$release/previous-public/$asset" "$base/public/"; fi
      done
      systemctl start ubercube
      (cd "$base" && sha256sum --strict -c "$release/previous.sha256")
      health
      exit 1
    }
    trap restore ERR
    systemctl stop ubercube
    rm -rf -- "$base/src" "$base/public/maps" "$base/public/map-credits"
    cp -a "$release/src" "$base/src"
    copy_assets "$release" "$base"
    systemctl start ubercube
    verify_tree "$base" "$release/server.sha256"
    health
    date -u +%FT%TZ > "$release/activated-at.txt"
    trap - ERR
    echo "Activated $id. Previous sources and map assets preserved in $release/previous-src and previous-public."
    ;;
  rollback)
    [[ $# -eq 2 && $EUID -eq 0 && -f $release/activated-at.txt && -d $release/previous-src && ! -L $release ]]
    # Do not undo another release that was activated after this one.
    verify_tree "$base" "$release/server.sha256"
    verify_previous
    restore_current() {
      trap - ERR
      echo 'Rollback failed; restoring the current release.' >&2
      systemctl stop ubercube || true
      rm -rf -- "$base/src" "$base/public/maps" "$base/public/map-credits"
      cp -a "$release/src" "$base/src"
      copy_assets "$release" "$base"
      systemctl start ubercube
      verify_tree "$base" "$release/server.sha256"
      if ! health; then echo 'Current sources restored, but service health still fails; inspect systemctl and journalctl.' >&2; fi
      exit 1
    }
    trap restore_current ERR
    systemctl stop ubercube
    rm -rf -- "$base/src" "$base/public/maps" "$base/public/map-credits"
    cp -a "$release/previous-src" "$base/src"
    for asset in maps map-credits; do
      if [[ -d $release/previous-public/$asset ]]; then mkdir -p "$base/public"; cp -a "$release/previous-public/$asset" "$base/public/"; fi
    done
    systemctl start ubercube
    (cd "$base" && sha256sum --strict -c "$release/previous.sha256")
    health
    date -u +%FT%TZ > "$release/rolled-back-at.txt"
    trap - ERR
    ;;
  *) echo 'Usage: server.sh check | stage|activate|rollback ID [upload-directory]' >&2; exit 1 ;;
esac
