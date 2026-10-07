#!/usr/bin/env bash
set -euo pipefail

# 脚本目录与配置文件读取
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${BACKUP_ENV_FILE:-${SCRIPT_DIR}/backup.env}"
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] env file not found: ${ENV_FILE}" >&2
  exit 1
fi

: "${CLOUD1:?CLOUD1 not set}"
: "${CLOUD2:?CLOUD2 not set}"
: "${LOCAL_DIR:?LOCAL_DIR not set}"
: "${MAX_LOCAL_MB:?MAX_LOCAL_MB not set}"

# 日志与锁配置
BASE_DATA_DIR="$(dirname "${LOCAL_DIR}")"
LOG_FILE="${BASE_DATA_DIR}/backup.log"
LOCK_FILE="${BASE_DATA_DIR}/.nai-backup.lock"

exec 200>"${LOCK_FILE}"
if ! flock -n 200; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] Another backup instance is running. Exiting." | tee -a "${LOG_FILE}"
  exit 0
fi

log() {
  local level="$1"
  shift
  local msg
  msg="[$(date '+%Y-%m-%d %H:%M:%S')] [${level}] $*"
  echo "${msg}" | tee -a "${LOG_FILE}"
}

log "INFO" "==================== Starting Image Backup ===================="
log "INFO" "Configuration:"
log "INFO" "  LOCAL_DIR:    ${LOCAL_DIR}"
log "INFO" "  CLOUD1:       ${CLOUD1}"
log "INFO" "  CLOUD2:       ${CLOUD2}"
log "INFO" "  MAX_LOCAL_MB: ${MAX_LOCAL_MB} MB"

if [[ ! -d "${LOCAL_DIR}" ]]; then
  log "ERROR" "LOCAL_DIR does not exist: ${LOCAL_DIR}"
  exit 1
fi

RCLONE_COMMON_FLAGS=(
  --transfers 4
  --checkers 8
  --low-level-retries 10
  --contimeout 30s
  --timeout 300s
)

# 1. 同步到两端云存储（使用 copy 保证云端增量只增不减）
if [[ "${SKIP_COPY:-0}" != "1" ]]; then
  log "INFO" "Step 1: Copying local images to CLOUD1 (${CLOUD1})..."
  if ! rclone copy "${LOCAL_DIR}" "${CLOUD1}" "${RCLONE_COMMON_FLAGS[@]}"; then
    log "ERROR" "Failed to copy images to CLOUD1: ${CLOUD1}"
    exit 1
  fi
  log "INFO" "Copy to CLOUD1 completed successfully."

  log "INFO" "Step 1: Copying local images to CLOUD2 (${CLOUD2})..."
  if ! rclone copy "${LOCAL_DIR}" "${CLOUD2}" "${RCLONE_COMMON_FLAGS[@]}"; then
    log "ERROR" "Failed to copy images to CLOUD2: ${CLOUD2}"
    exit 1
  fi
  log "INFO" "Copy to CLOUD2 completed successfully."
else
  log "INFO" "Step 1: SKIP_COPY=1 set, skipping rclone copy step for testing."
fi
TOTAL_LOCAL_BYTES=$(find "${LOCAL_DIR}" -mindepth 1 -maxdepth 1 -type f -printf "%s\n" 2>/dev/null | awk '{s+=$1} END {printf "%.0f\n", s+0}')
TOTAL_LOCAL_COUNT=$(find "${LOCAL_DIR}" -mindepth 1 -maxdepth 1 -type f 2>/dev/null | wc -l)
MAX_LOCAL_BYTES=$(( MAX_LOCAL_MB * 1024 * 1024 ))

log "INFO" "Current local usage: $(( TOTAL_LOCAL_BYTES / 1024 / 1024 )) MB (${TOTAL_LOCAL_BYTES} bytes, ${TOTAL_LOCAL_COUNT} files). Max limit: ${MAX_LOCAL_MB} MB (${MAX_LOCAL_BYTES} bytes)."

# 2. 检查容量是否超标。若本来 <= MAX_LOCAL_MB，则不删任何文件
if (( TOTAL_LOCAL_BYTES <= MAX_LOCAL_BYTES )); then
  log "INFO" "Local size is within threshold (${MAX_LOCAL_MB} MB). No deletion needed."
  log "INFO" "==================== Backup Summary ===================="
  log "INFO" "Total Local Files:    ${TOTAL_LOCAL_COUNT}"
  log "INFO" "Target To Delete:     0"
  log "INFO" "Verified Count:       0"
  log "INFO" "Deleted Count:        0"
  log "INFO" "Retained Count:       ${TOTAL_LOCAL_COUNT}"
  log "INFO" "Missing/Mismatch:     0"
  log "INFO" "Final Local Usage:    $(( TOTAL_LOCAL_BYTES / 1024 / 1024 )) MB"
  log "INFO" "========================================================"
  exit 0
fi

BYTES_TO_FREE=$(( TOTAL_LOCAL_BYTES - MAX_LOCAL_BYTES ))
log "WARN" "Local usage exceeds the limit by ${BYTES_TO_FREE} bytes."
if [[ "${ALLOW_LOCAL_PRUNE:-0}" != "1" ]]; then
  log "WARN" "Automatic local deletion is disabled. Set ALLOW_LOCAL_PRUNE=1 only after confirming both cloud copies and the retention policy."
  exit 0
fi
log "WARN" "ALLOW_LOCAL_PRUNE=1 enabled. Deletion verification checks remote presence and byte size only, not content hashes."
log "INFO" "Need to free at least $(( (BYTES_TO_FREE + 1024 * 1024 - 1) / 1024 / 1024 )) MB (${BYTES_TO_FREE} bytes) to reach <= ${MAX_LOCAL_MB} MB."

# 3. 获取本地所有文件，按文件名（时间戳前缀）从老到新排序
# 文件名格式: <timestamp>-<hash>.png
TMP_FILE_LIST=$(mktemp)
TMP_CLOUD1_LSL=$(mktemp)
TMP_CLOUD2_LSL=$(mktemp)

trap 'rm -f "${TMP_FILE_LIST}" "${TMP_CLOUD1_LSL}" "${TMP_CLOUD2_LSL}"' EXIT

# 导出格式: 文件名<TAB>大小(字节)
# 使用 -printf "%f\t%s\n"
find "${LOCAL_DIR}" -mindepth 1 -maxdepth 1 -type f -printf "%f\t%s\n" | sort -t$'\t' -k1,1n > "${TMP_FILE_LIST}"

# 批量预加载云端清单以加速验证 (rclone lsl 输出: 大小 日期 时间 文件名)
# 格式: <size> <path>
log "INFO" "Fetching remote file lists for quick verification..."
rclone lsl "${CLOUD1}" "${RCLONE_COMMON_FLAGS[@]}" | awk 'NF>=4 {size=$1; sub(/^[ \t]*[^ \t]+[ \t]+[^ \t]+[ \t]+[^ \t]+[ \t]+/, ""); print size "\t" $0}' > "${TMP_CLOUD1_LSL}" || true
rclone lsl "${CLOUD2}" "${RCLONE_COMMON_FLAGS[@]}" | awk 'NF>=4 {size=$1; sub(/^[ \t]*[^ \t]+[ \t]+[^ \t]+[ \t]+[^ \t]+[ \t]+/, ""); print size "\t" $0}' > "${TMP_CLOUD2_LSL}" || true

# 转换为 awk 快速查找或者直接逐文件比对
# 为了保证"校验通过才删"的绝对严谨，脚本结合预加载表与缺失备选查询
declare -A CLOUD1_MAP
declare -A CLOUD2_MAP

while IFS=$'\t' read -r size name; do
  [[ -n "${name}" ]] && CLOUD1_MAP["${name}"]="${size}"
done < "${TMP_CLOUD1_LSL}"

while IFS=$'\t' read -r size name; do
  [[ -n "${name}" ]] && CLOUD2_MAP["${name}"]="${size}"
done < "${TMP_CLOUD2_LSL}"

log "INFO" "CLOUD1 catalog size: ${#CLOUD1_MAP[@]}, CLOUD2 catalog size: ${#CLOUD2_MAP[@]}"

# 4. 候选删除与校验循环（从老到新）
CANDIDATE_DELETE_COUNT=0
VERIFIED_COUNT=0
DELETED_COUNT=0
FREED_BYTES=0
MISSING_LIST=()

while IFS=$'\t' read -r filename filesize; do
  # 如果当前剩余总量已经 <= MAX_LOCAL_BYTES，停止删除
  CURRENT_SIZE=$(( TOTAL_LOCAL_BYTES - FREED_BYTES ))
  if (( CURRENT_SIZE <= MAX_LOCAL_BYTES )); then
    log "INFO" "Target threshold reached (current: $(( CURRENT_SIZE / 1024 / 1024 )) MB <= ${MAX_LOCAL_MB} MB). Stopping deletion."
    break
  fi

  CANDIDATE_DELETE_COUNT=$(( CANDIDATE_DELETE_COUNT + 1 ))

  # 校验 CLOUD1 与 CLOUD2
  # 优先从 MAP 查找，如果 map 没命中，再单文件 rclone size 兜底确认
  C1_SIZE="${CLOUD1_MAP["${filename}"]:-}"
  C2_SIZE="${CLOUD2_MAP["${filename}"]:-}"

  if [[ -z "${C1_SIZE}" ]]; then
    # 单文件二次确认
    C1_CHECK=$(rclone size "${CLOUD1}/${filename}" --json 2>/dev/null || true)
    if [[ -n "${C1_CHECK}" ]]; then
      C1_SIZE=$(echo "${C1_CHECK}" | grep -o '"bytes":[0-9]*' | cut -d':' -f2 || true)
    fi
  fi

  if [[ -z "${C2_SIZE}" ]]; then
    # 单文件二次确认
    C2_CHECK=$(rclone size "${CLOUD2}/${filename}" --json 2>/dev/null || true)
    if [[ -n "${C2_CHECK}" ]]; then
      C2_SIZE=$(echo "${C2_CHECK}" | grep -o '"bytes":[0-9]*' | cut -d':' -f2 || true)
    fi
  fi

  # 校验规则: 两个云端都必须存在且大小与本地一致
  IS_VALID=1
  REASON=""

  if [[ -z "${C1_SIZE}" ]]; then
    IS_VALID=0
    REASON="Missing in CLOUD1"
  elif [[ "${C1_SIZE}" != "${filesize}" ]]; then
    IS_VALID=0
    REASON="Size mismatch in CLOUD1 (local=${filesize}, remote=${C1_SIZE})"
  fi

  if [[ "${IS_VALID}" -eq 1 ]]; then
    if [[ -z "${C2_SIZE}" ]]; then
      IS_VALID=0
      REASON="Missing in CLOUD2"
    elif [[ "${C2_SIZE}" != "${filesize}" ]]; then
      IS_VALID=0
      REASON="Size mismatch in CLOUD2 (local=${filesize}, remote=${C2_SIZE})"
    fi
  fi

  if [[ "${IS_VALID}" -eq 1 ]]; then
    VERIFIED_COUNT=$(( VERIFIED_COUNT + 1 ))
    # 允许删除
    local_path="${LOCAL_DIR}/${filename}"
    if rm -f "${local_path}"; then
      DELETED_COUNT=$(( DELETED_COUNT + 1 ))
      FREED_BYTES=$(( FREED_BYTES + filesize ))
    else
      log "WARN" "Failed to remove local file: ${local_path}"
    fi
  else
    log "WARN" "Verification failed for ${filename}: ${REASON}. Skipping deletion."
    MISSING_LIST+=("${filename} (${REASON})")
  fi
done < "${TMP_FILE_LIST}"

FINAL_LOCAL_BYTES=$(( TOTAL_LOCAL_BYTES - FREED_BYTES ))
RETAINED_COUNT=$(( TOTAL_LOCAL_COUNT - DELETED_COUNT ))

log "INFO" "==================== Backup Summary ===================="
log "INFO" "Total Local Files (before): ${TOTAL_LOCAL_COUNT}"
log "INFO" "Candidate Delete Targets:   ${CANDIDATE_DELETE_COUNT}"
log "INFO" "Verification Passed:        ${VERIFIED_COUNT}"
log "INFO" "Deleted Count:              ${DELETED_COUNT}"
log "INFO" "Retained Count:             ${RETAINED_COUNT}"
log "INFO" "Freed Space:                $(( FREED_BYTES / 1024 / 1024 )) MB (${FREED_BYTES} bytes)"
log "INFO" "Final Local Usage:          $(( FINAL_LOCAL_BYTES / 1024 / 1024 )) MB (${FINAL_LOCAL_BYTES} bytes)"
log "INFO" "Missing/Mismatch Files:     ${#MISSING_LIST[@]}"

if [[ "${#MISSING_LIST[@]}" -gt 0 ]]; then
  log "WARN" "--- Missing or Mismatch Files List ---"
  for item in "${MISSING_LIST[@]}"; do
    log "WARN" "  * ${item}"
  done
fi
log "INFO" "==================== Backup Finished ===================="
