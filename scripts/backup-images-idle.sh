#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${BACKUP_ENV_FILE:-${SCRIPT_DIR}/backup.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] env file not found: ${ENV_FILE}" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "${ENV_FILE}"

: "${CLOUD1:?CLOUD1 not set}"
: "${CLOUD2:?CLOUD2 not set}"
: "${LOCAL_DIR:?LOCAL_DIR not set}"
: "${MAX_LOCAL_MB:?MAX_LOCAL_MB not set}"
IDLE_MINUTES="${IDLE_MINUTES:-120}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if [[ ! -d "${LOCAL_DIR}" ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] LOCAL_DIR does not exist: ${LOCAL_DIR}" >&2
  exit 1
fi

BASE_DATA_DIR="$(cd "$(dirname "${LOCAL_DIR}")" && pwd)"
LOCK_FILE="${BASE_DATA_DIR}/.nai-backup.lock"
STATE_FILE="${BASE_DATA_DIR}/.idle-backup-state"
STAGE_DIR=""
SYNC_COUNT=0

exec 200>"${LOCK_FILE}"
if ! flock -n 200; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] Another backup task is running. Exiting."
  exit 0
fi

log() {
  local level="$1"
  shift
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${level}] $*"
}

prune_local_over_cap() {
  local max_bytes total freed fsize path
  max_bytes=$(( MAX_LOCAL_MB * 1024 * 1024 ))
  total=$(find "${LOCAL_DIR}" -mindepth 1 -maxdepth 1 -type f -name '*.png' -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {printf "%.0f\n", s+0}')
  if (( total <= max_bytes )); then
    return 0
  fi
  log "INFO" "Local images $(( total / 1024 / 1024 )) MB exceed ${MAX_LOCAL_MB} MB; deleting oldest files."
  freed=0
  while IFS= read -r path; do
    if (( total - freed <= max_bytes )); then
      break
    fi
    [[ -f "${path}" ]] || continue
    fsize=$(stat -c %s "${path}")
    if rm -f -- "${path}"; then
      freed=$(( freed + fsize ))
    else
      log "WARN" "Failed to remove ${path}"
    fi
  done < <(find "${LOCAL_DIR}" -mindepth 1 -maxdepth 1 -type f -name '*.png' -printf '%T@ %p\n' | sort -n | awk '{print $2}')
  log "INFO" "Pruned $(( freed / 1024 / 1024 )) MB (${freed} bytes); local now $(( (total - freed) / 1024 / 1024 )) MB."
}

cleanup_stage() {
  if [[ -n "${STAGE_DIR}" && -d "${STAGE_DIR}" && "${STAGE_DIR}" == "${BASE_DATA_DIR}"/.nai-backup-stage.* ]]; then
    rm -r -- "${STAGE_DIR}"
  fi
}
trap cleanup_stage EXIT

LATEST_IMAGE_TS=$(find "${LOCAL_DIR}" -mindepth 1 -maxdepth 1 -type f -name "*.png" -printf "%T@\n" 2>/dev/null | sort -nr | head -n 1 | cut -d'.' -f1 || true)
if [[ -z "${LATEST_IMAGE_TS}" ]]; then
  log "INFO" "No images found in ${LOCAL_DIR}. Nothing to backup."
  exit 0
fi

NOW_TS=$(date +%s)
IDLE_SECS=$(( NOW_TS - LATEST_IMAGE_TS ))
IDLE_THRESHOLD_SECS=$(( IDLE_MINUTES * 60 ))
LAST_BACKUP_TS=0
if [[ -f "${STATE_FILE}" ]]; then
  read -r LAST_BACKUP_TS < "${STATE_FILE}" || LAST_BACKUP_TS=0
  [[ "${LAST_BACKUP_TS}" =~ ^[0-9]+$ ]] || LAST_BACKUP_TS=0
fi

if (( LATEST_IMAGE_TS <= LAST_BACKUP_TS )); then
  prune_local_over_cap
  exit 0
fi
if (( IDLE_SECS < IDLE_THRESHOLD_SECS )); then
  log "INFO" "System is active (latest image $(( IDLE_SECS / 60 )) minutes ago; threshold ${IDLE_MINUTES})."
  prune_local_over_cap
  exit 0
fi

log "INFO" "==================== Starting Idle Incremental Backup ===================="
STAGE_DIR=$(mktemp -d "${BASE_DATA_DIR}/.nai-backup-stage.XXXXXX")
chmod 700 "${STAGE_DIR}"

while IFS= read -r -d '' img_path; do
  mtime=$(stat -c %Y "${img_path}")
  if (( mtime <= LAST_BACKUP_TS )); then
    continue
  fi

  DEST_SUBDIR=$("${PYTHON_BIN}" "${SCRIPT_DIR}/classifier.py" "${img_path}" 2>/dev/null || true)
  if [[ ! "${DEST_SUBDIR}" =~ ^[^/]+/[^/]+$ || "${DEST_SUBDIR}" == *".."* ]]; then
    log "WARN" "Classifier returned an unsafe path; using fallback for $(basename "${img_path}")."
    DEST_SUBDIR="Other_Generations/General"
  fi

  TARGET_FOLDER=$(realpath -m "${STAGE_DIR}/${DEST_SUBDIR}")
  case "${TARGET_FOLDER}/" in
    "${STAGE_DIR}/"*) ;;
    *)
      log "ERROR" "Refusing staging path outside private directory: ${TARGET_FOLDER}"
      exit 1
      ;;
  esac
  mkdir -p "${TARGET_FOLDER}"
  target="${TARGET_FOLDER}/$(basename "${img_path}")"
  if ! ln "${img_path}" "${target}" 2>/dev/null; then
    cp -- "${img_path}" "${target}"
  fi
  SYNC_COUNT=$(( SYNC_COUNT + 1 ))
done < <(find "${LOCAL_DIR}" -mindepth 1 -maxdepth 1 -type f -name "*.png" -print0)

log "INFO" "Classification complete: ${SYNC_COUNT} new images staged."
if (( SYNC_COUNT == 0 )); then
  printf '%s\n' "${LATEST_IMAGE_TS}" > "${STATE_FILE}"
  prune_local_over_cap
  exit 0
fi

RCLONE_FLAGS=(
  --transfers 4
  --checkers 8
  --low-level-retries 5
  --retries 3
  --timeout 120s
  --contimeout 30s
)

log "INFO" "Syncing classified images to CLOUD1: ${CLOUD1}..."
rclone copy "${STAGE_DIR}" "${CLOUD1}" "${RCLONE_FLAGS[@]}"
log "INFO" "Syncing classified images to CLOUD2: ${CLOUD2}..."
rclone copy "${STAGE_DIR}" "${CLOUD2}" "${RCLONE_FLAGS[@]}"
printf '%s\n' "${LATEST_IMAGE_TS}" > "${STATE_FILE}"
log "INFO" "Backup to both clouds completed successfully."

prune_local_over_cap
log "INFO" "==================== Idle Backup Finished ===================="
