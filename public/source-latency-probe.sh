#!/usr/bin/env bash
# CF Server Monitor: measure this source host to every server registered in CFSM.
# Configuration is read from CONFIG_FILE (default: ~/.config/cf-source-latency/config.conf).

set -uo pipefail
export LC_ALL=C

CONFIG_FILE="${CONFIG_FILE:-${HOME}/.config/cf-source-latency/config.conf}"
if [[ ! -r "$CONFIG_FILE" ]]; then
  echo "[source-latency] config not readable: $CONFIG_FILE" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$CONFIG_FILE"

: "${SOURCE_ID:?SOURCE_ID is required}"
: "${SECRET:?SECRET is required}"
: "${WORKER_URL:?WORKER_URL is required}"

INTERVAL_SECONDS="${INTERVAL_SECONDS:-60}"
PING_COUNT="${PING_COUNT:-4}"
PING_TIMEOUT="${PING_TIMEOUT:-2}"
WORKER_URL="${WORKER_URL%/}"
# The regular CFSM shell probe stores its report endpoint as .../update.
# Accept that value too, so both probes can safely share the same base setting.
WORKER_URL="${WORKER_URL%/update}"

for command in curl jq ping nc; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[source-latency] missing command: $command" >&2
    exit 1
  fi
done

runtime_root="${XDG_RUNTIME_DIR:-/tmp}/cf-source-latency-${UID}"
mkdir -p "$runtime_root"
chmod 700 "$runtime_root"

exec 9>"$runtime_root/agent.lock"
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
  echo "[source-latency] another instance is already running" >&2
  exit 0
fi

auth_headers="$runtime_root/auth.headers"
printf 'X-CFSM-Source-ID: %s\nX-CFSM-Secret: %s\n' "$SOURCE_ID" "$SECRET" > "$auth_headers"
chmod 600 "$auth_headers"

cleanup() {
  rm -f "$auth_headers"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

measure_target() {
  local target_id="$1" family="$2" address="$3"
  local ping_flag='-4'
  [[ "$family" == 'ipv6' ]] && ping_flag='-6'

  local output loss latency method error start_ns end_ns
  output="$(ping "$ping_flag" -n -c "$PING_COUNT" -W "$PING_TIMEOUT" "$address" 2>&1 || true)"
  loss="$(printf '%s\n' "$output" | sed -nE 's/.* ([0-9]+([.][0-9]+)?)% packet loss.*/\1/p' | tail -n1)"
  latency="$(printf '%s\n' "$output" | awk -F' = ' '/^(rtt|round-trip) / { split($2,a,"/"); print a[2] }' | tail -n1)"

  if [[ "$latency" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    method='icmp'
    [[ "$loss" =~ ^[0-9]+([.][0-9]+)?$ ]] || loss='0'
    error=''
  else
    # Use full nanoseconds and convert the elapsed value ourselves.  Some
    # `date` implementations (notably uutils) ignore the width in `%3N`,
    # which made a millisecond timer look millions of times too large.
    start_ns="$(date +%s%N)"
    if nc "$ping_flag" -z -w "$PING_TIMEOUT" "$address" 22 >/dev/null 2>&1; then
      end_ns="$(date +%s%N)"
      latency="$(awk -v start="$start_ns" -v end="$end_ns" 'BEGIN { printf "%.1f", (end - start) / 1000000 }')"
      loss='0'
      method='tcp/22'
      error=''
    else
      latency='null'
      [[ "$loss" =~ ^[0-9]+([.][0-9]+)?$ ]] || loss='100'
      method='unreachable'
      error='ICMP and TCP/22 did not respond'
    fi
  fi

  jq -cn \
    --arg target_id "$target_id" \
    --arg family "$family" \
    --arg method "$method" \
    --arg error "$error" \
    --argjson latency_ms "$latency" \
    --argjson loss_percent "$loss" \
    '{target_id:$target_id,family:$family,latency_ms:$latency_ms,loss_percent:$loss_percent,method:$method,error:$error}'
}

run_cycle() {
  local run_dir targets payload response index target_id family address
  run_dir="$(mktemp -d "$runtime_root/run.XXXXXX")"

  if ! targets="$(curl --fail --silent --show-error \
    --connect-timeout 8 --max-time 20 --retry 2 \
    -H "@$auth_headers" \
    "$WORKER_URL/source-latency/targets")"; then
    echo "[source-latency] failed to fetch target list" >&2
    rm -rf "$run_dir"
    return 1
  fi

  index=0
  while IFS=$'\t' read -r target_id family address; do
    [[ -n "$target_id" && -n "$address" ]] || continue
    index=$((index + 1))
    measure_target "$target_id" "$family" "$address" > "$run_dir/sample-$(printf '%04d' "$index").json" &
  done < <(jq -r '
    .targets[]
    | .id as $id
    | .addresses
    | to_entries[]
    | select(.value != null and .value != "")
    | [$id, .key, .value]
    | @tsv
  ' <<< "$targets")
  wait

  local files=("$run_dir"/sample-*.json)
  if [[ -e "${files[0]}" ]]; then
    payload="$(jq -sc --arg source_id "$SOURCE_ID" '{source_id:$source_id,samples:.}' "${files[@]}")"
  else
    payload="$(jq -cn --arg source_id "$SOURCE_ID" '{source_id:$source_id,samples:[]}')"
  fi

  if ! response="$(curl --fail --silent --show-error \
    --connect-timeout 8 --max-time 20 --retry 2 \
    -H "@$auth_headers" -H 'Content-Type: application/json' \
    --data-binary "$payload" \
    "$WORKER_URL/source-latency/update")"; then
    echo "[source-latency] failed to upload measurements" >&2
    rm -rf "$run_dir"
    return 1
  fi

  echo "[source-latency] uploaded $(jq -r '.accepted // 0' <<< "$response") measurements"
  rm -rf "$run_dir"
}

if [[ "${1:-}" == '--once' ]]; then
  run_cycle
  exit $?
fi

while true; do
  cycle_started="$(date +%s)"
  run_cycle || true
  elapsed="$(( $(date +%s) - cycle_started ))"
  sleep_for="$(( INTERVAL_SECONDS - elapsed ))"
  (( sleep_for < 1 )) && sleep_for=1
  sleep "$sleep_for"
done
