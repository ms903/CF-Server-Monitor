#!/bin/bash
set -euo pipefail

SERVICE_NAME="cfsm-path-bandwidth"
SCRIPT_FILE="/usr/local/bin/${SERVICE_NAME}.sh"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CFSM_CONFIG="/etc/config/cf-probe/config.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 运行此安装脚本" >&2
  exit 1
fi
if [ ! -r "$CFSM_CONFIG" ]; then
  echo "未找到 CF-Server-Monitor Shell 探针配置：$CFSM_CONFIG" >&2
  exit 1
fi

install_dependencies() {
  local missing=()
  for command in curl jq iperf3 timeout; do
    command -v "$command" >/dev/null 2>&1 || missing+=("$command")
  done
  [ "${#missing[@]}" -eq 0 ] && return

  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl jq iperf3 coreutils >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl jq iperf3 coreutils
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl jq iperf3 coreutils
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl jq iperf3 coreutils
  else
    echo "无法自动安装依赖：${missing[*]}" >&2
    exit 1
  fi
}

install_dependencies

cat > "$SCRIPT_FILE" <<'PROBE'
#!/bin/bash
set +eu

CFSM_CONFIG="/etc/config/cf-probe/config.conf"
POLL_SECONDS=15

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

post_result() {
  local base="$1" id="$2" secret="$3" payload="$4"
  curl -fsS --max-time 20 -X POST "$base/api/path-bandwidth/agent" \
    -H 'Content-Type: application/json' \
    -H "X-CFSM-Server-ID: $id" \
    -H "X-CFSM-Secret: $secret" \
    --data "$payload" >/dev/null
}

while true; do
  if [ ! -r "$CFSM_CONFIG" ]; then
    log "等待 CFSM 配置"
    sleep 30
    continue
  fi

  # shellcheck disable=SC1090
  . "$CFSM_CONFIG"
  base="${WORKER_URL%/update}"
  base="${base%/}"
  claim=$(curl -fsS --max-time 20 -X POST "$base/api/path-bandwidth/agent" \
    -H 'Content-Type: application/json' \
    -H "X-CFSM-Server-ID: $SERVER_ID" \
    -H "X-CFSM-Secret: $SECRET" \
    --data '{"action":"claim"}' 2>/dev/null) || {
      sleep "$POLL_SECONDS"
      continue
    }

  job_id=$(printf '%s' "$claim" | jq -r '.job.id // empty' 2>/dev/null)
  if [ -z "$job_id" ]; then
    sleep "$POLL_SECONDS"
    continue
  fi
  target=$(printf '%s' "$claim" | jq -r '.job.target // empty')
  port=$(printf '%s' "$claim" | jq -r '.job.port // 5201')
  bytes=$(printf '%s' "$claim" | jq -r '.job.bytes_each // 33554432')
  timeout_seconds=$(printf '%s' "$claim" | jq -r '.job.timeout_seconds // 90')
  log "开始路径带宽测试：$target:$port"

  upload_file=$(mktemp /tmp/cfsm-bw-upload.XXXXXX)
  download_file=$(mktemp /tmp/cfsm-bw-download.XXXXXX)
  error=""

  timeout "$timeout_seconds" iperf3 -c "$target" -p "$port" -n "$bytes" \
    --connect-timeout 5000 -J >"$upload_file" 2>&1 || error="VPS → Home 测试失败"
  if [ -z "$error" ]; then
    timeout "$timeout_seconds" iperf3 -c "$target" -p "$port" -n "$bytes" -R \
      --connect-timeout 5000 -J >"$download_file" 2>&1 || error="Home → VPS 测试失败"
  fi

  if [ -z "$error" ]; then
    upload_bps=$(jq -r '.end.sum_received.bits_per_second // 0' "$upload_file" 2>/dev/null)
    download_bps=$(jq -r '.end.sum_received.bits_per_second // 0' "$download_file" 2>/dev/null)
    if ! awk -v up="$upload_bps" -v down="$download_bps" 'BEGIN { exit !(up > 0 && down > 0) }'; then
      error="iperf3 未返回有效带宽"
    fi
  fi

  if [ -n "$error" ]; then
    detail=$(jq -r '.error // empty' "$upload_file" 2>/dev/null)
    [ -z "$detail" ] && detail=$(jq -r '.error // empty' "$download_file" 2>/dev/null)
    [ -n "$detail" ] && error="$error：$detail"
    payload=$(jq -nc --arg job "$job_id" --arg error "$error" \
      '{action:"result",job_id:$job,error:$error}')
    post_result "$base" "$SERVER_ID" "$SECRET" "$payload" || true
    log "$error"
  else
    upload_mbps=$(awk -v value="$upload_bps" 'BEGIN { printf "%.2f", value / 1000000 }')
    download_mbps=$(awk -v value="$download_bps" 'BEGIN { printf "%.2f", value / 1000000 }')
    payload=$(jq -nc --arg job "$job_id" --argjson up "$upload_mbps" --argjson down "$download_mbps" \
      '{action:"result",job_id:$job,vps_to_home_mbps:$up,home_to_vps_mbps:$down}')
    post_result "$base" "$SERVER_ID" "$SECRET" "$payload" || true
    log "完成：VPS → Home ${upload_mbps} Mbps；Home → VPS ${download_mbps} Mbps"
  fi

  rm -f "$upload_file" "$download_file"
  sleep "$POLL_SECONDS"
done
PROBE

chmod 0755 "$SCRIPT_FILE"

cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=CFSM path bandwidth probe
After=network-online.target cf-probe.service tailscaled.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$SCRIPT_FILE
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.service"
echo "路径带宽探针已启用：$SERVICE_NAME.service"
