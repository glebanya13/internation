#!/usr/bin/env bash
# Восстановление PostgreSQL из резервной копии pg_dump.
#
# ВНИМАНИЕ: перезаписывает текущую базу!
#
# Использование:
#   ./scripts/restore.sh backups/dorm_duty_20260101_120000.sql.gz

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Использование: $0 <файл.sql.gz>" >&2
  exit 1
fi

BACKUP_FILE="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "Файл не найден: ${BACKUP_FILE}" >&2
  exit 1
fi

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.env"
  set +a
fi

POSTGRES_DB="${POSTGRES_DB:-dorm_duty}"
POSTGRES_USER="${POSTGRES_USER:-dorm}"
COMPOSE_FILE="${COMPOSE_FILE:-${PROJECT_DIR}/docker-compose.yml}"

echo "[restore] Остановка api, bot, worker…"
docker compose -f "${COMPOSE_FILE}" stop api bot worker

echo "[restore] Восстановление ${POSTGRES_DB} из ${BACKUP_FILE}…"

gunzip -c "${BACKUP_FILE}" | docker compose -f "${COMPOSE_FILE}" exec -T db \
  psql -U "${POSTGRES_USER}" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${POSTGRES_DB}' AND pid <> pg_backend_pid();" \
  -c "DROP DATABASE IF EXISTS ${POSTGRES_DB};" \
  -c "CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};"

gunzip -c "${BACKUP_FILE}" | docker compose -f "${COMPOSE_FILE}" exec -T db \
  psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1

echo "[restore] Запуск сервисов…"
docker compose -f "${COMPOSE_FILE}" up -d api bot worker nginx

echo "[restore] Готово. Проверьте: curl -s http://localhost/health"
