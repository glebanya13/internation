#!/usr/bin/env bash
# Резервная копия PostgreSQL через pg_dump.
# Запускать на хосте VPS (не внутри контейнера приложения).
#
# Использование:
#   ./scripts/backup.sh
#   BACKUP_DIR=/var/backups/dorm-duty RETENTION_DAYS=14 ./scripts/backup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.env"
  set +a
fi

POSTGRES_DB="${POSTGRES_DB:-dorm_duty}"
POSTGRES_USER="${POSTGRES_USER:-dorm}"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/docker-compose.yml}"

mkdir -p "${BACKUP_DIR}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUTPUT="${BACKUP_DIR}/${POSTGRES_DB}_${TIMESTAMP}.sql.gz"

echo "[backup] Создание резервной копии ${POSTGRES_DB} → ${OUTPUT}"

docker compose -f "${COMPOSE_FILE}" exec -T db \
  pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --no-owner --no-acl \
  | gzip -9 > "${OUTPUT}"

if [[ ! -s "${OUTPUT}" ]]; then
  echo "[backup] ОШИБКА: файл пустой" >&2
  exit 1
fi

echo "[backup] Размер: $(du -h "${OUTPUT}" | cut -f1)"

# Проверка целостности gzip
if ! gzip -t "${OUTPUT}"; then
  echo "[backup] ОШИБКА: архив повреждён" >&2
  exit 1
fi

echo "[backup] Архив проверен (gzip -t OK)"

# Удаление старых копий
find "${BACKUP_DIR}" -name "${POSTGRES_DB}_*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" -delete

echo "[backup] Готово. Хранятся копии за последние ${RETENTION_DAYS} дней."
