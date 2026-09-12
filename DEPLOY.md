# Развёртывание на VPS

Пошаговая инструкция для production-развёртывания системы учёта дежурств на VPS с **1 vCPU / 2 GiB RAM / 20 GiB NVMe**.

Стек: PostgreSQL, Node.js API, Telegram Bot, Worker, Nginx. Redis, Kubernetes и Firebase **не используются**.

---

## 1. Подготовка VPS

### 1.1. Ubuntu и обновление

```bash
sudo apt update && sudo apt upgrade -y
```

### 1.2. Установка Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Перелогиньтесь, чтобы группа `docker` применилась.

```bash
docker --version
docker compose version
```

### 1.3. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Открыты только **22** (SSH), **80** (HTTP), **443** (HTTPS). PostgreSQL наружу **не** открывается.

### 1.4. Swap (2–4 GiB)

На VPS с 2 GiB RAM swap снижает риск OOM при пиковых нагрузках (PDF, миграции).

**Проверить RAM и swap:**

```bash
free -h
swapon --show
```

**Создать 2 GiB swap** (рекомендуется минимум 2 GiB, можно 4 GiB):

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

Сделать постоянным:

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Проверить работу:**

```bash
free -h
swapon --show
```

Swap создаётся **на хосте**, не внутри Docker.

---

## 2. Клонирование и настройка

```bash
git clone <URL-репозитория> dorm-duty
cd dorm-duty
cp .env.example .env
```

### 2.1. Заполните `.env`

Обязательные переменные для production:

```bash
NODE_ENV=production

POSTGRES_DB=dorm_duty
POSTGRES_USER=dorm
POSTGRES_PASSWORD=<сильный-пароль>    # openssl rand -base64 32

SESSION_SECRET=<секрет-≥32-символов>  # openssl rand -base64 48
PUBLIC_BASE_URL=https://duty.example.org   # сначала http://IP, потом домен

# Telegram — можно добавить позже
TELEGRAM_BOT_TOKEN=

PG_POOL_MAX=3
SCHEDULER_INTERVAL_MINUTES=5
```

`DATABASE_URL` в `.env` для Docker **не нужен** — compose собирает его из `POSTGRES_*`.

**Не коммитьте `.env` в git.** Не храните пароли и токены в коде.

---

## 3. Первый запуск

```bash
docker compose build
docker compose up -d
```

Поднимаются сервисы:

| Сервис | Назначение |
|--------|------------|
| `db` | PostgreSQL (только внутри сети Docker) |
| `migrate` | Применяет миграции и завершается |
| `api` | Админка и API |
| `bot` | Telegram-бот (без токена — завершается штатно) |
| `worker` | Планировщик уведомлений |
| `nginx` | Reverse proxy |

### 3.1. Проверка health

```bash
curl -s http://localhost/health
curl -s http://localhost/health/db
```

Ожидается: `{"status":"ok"}`

```bash
docker compose ps
docker compose logs api --tail 50
```

---

## 4. Создание администратора

Первый администратор создаётся **отдельной командой** (пароль не хранится в коде):

```bash
docker compose exec api npx tsx src/main/createAdmin.ts \
  admin@example.org "ваш-надёжный-пароль" dorm_admin
```

Роли: `superadmin`, `dorm_admin`, `floor_admin`.

Для `floor_admin` этажи назначаются через `admin_floor_scopes` в базе или через существующие механизмы админки после входа `dorm_admin`.

Откройте админку: `http://<IP-VPS>/` → войдите с созданными учётными данными.

---

## 5. Демо-данные и реальные данные

Система поставляется с демо-данными (6 и 7 этажи). Для production:

1. Войдите в админку.
2. Замените этажи, комнаты, блоки, студентов через UI.
3. Импортируйте реальные списки через **Импорт XLSX**.

Код менять **не нужно** при смене этажей, факультетов, комнат и Telegram ID.

Комната **не имеет** фиксированной вместимости — 0, 1, 2 или 3 жильца валидны.

---

## 6. DNS и HTTPS

### 6.1. Направить домен на VPS

В панели регистратора создайте **A-запись**:

```
duty.example.org  →  <IP-VPS>
```

### 6.2. Проверить DNS

```bash
dig +short duty.example.org
# или
nslookup duty.example.org
```

### 6.3. Получить сертификат Let's Encrypt (certbot на хосте)

Сначала убедитесь, что HTTP работает:

```bash
curl -I http://duty.example.org/health
```

Установите certbot:

```bash
sudo apt install -y certbot
```

Временно остановите nginx, чтобы certbot занял порт 80:

```bash
docker compose stop nginx
sudo certbot certonly --standalone -d duty.example.org
docker compose start nginx
```

Сертификаты: `/etc/letsencrypt/live/duty.example.org/`

### 6.4. Включить HTTPS в Nginx

1. Скопируйте пример и отредактируйте домен:

```bash
cp deploy/nginx-https.conf.example deploy/nginx.conf
# замените duty.example.org на ваш домен
```

2. Добавьте volume для сертификатов в `docker-compose.yml` (секция `nginx`):

```yaml
    volumes:
      - ./deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
```

3. Обновите `.env`:

```bash
PUBLIC_BASE_URL=https://duty.example.org
SECURE_COOKIES=true
```

4. Перезапустите:

```bash
docker compose up -d nginx api
```

Cookie сессии получит флаги **HttpOnly**, **Secure**, **SameSite=Lax** (через `X-Forwarded-Proto: https` или `SECURE_COOKIES=true`).

### 6.5. Автообновление сертификата

```bash
sudo crontab -e
```

```
0 3 * * * certbot renew --quiet --deploy-hook "cd /path/to/dorm-duty && docker compose restart nginx"
```

---

## 7. Telegram-бот

1. Создайте бота через [@BotFather](https://t.me/BotFather).
2. Добавьте токен в `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...
```

3. Перезапустите bot и worker:

```bash
docker compose up -d bot worker
```

4. Проверьте логи:

```bash
docker compose logs bot --tail 20
```

5. Отправьте `/start` боту от имени студента с привязанным Telegram ID.

**Без токена:** API и админка работают; bot завершается штатно; worker ставит уведомления в очередь, но не отправляет их.

---

## 8. Резервное копирование PostgreSQL

### 8.1. Ручной backup

```bash
./scripts/backup.sh
```

Файлы сохраняются в `./backups/` (или `BACKUP_DIR`):

```
backups/dorm_duty_20260828_120000.sql.gz
```

Скрипт проверяет размер и целостность (`gzip -t`).

**Не храните единственную копию в том же Docker volume**, что и база. Копируйте backup на другой диск или в облако:

```bash
scp backups/dorm_duty_*.sql.gz user@backup-server:/backups/
```

### 8.2. Ежедневный cron

```bash
crontab -e
```

```
0 2 * * * cd /path/to/dorm-duty && RETENTION_DAYS=14 ./scripts/backup.sh >> /var/log/dorm-backup.log 2>&1
```

Хранятся последние **14 дней** (настраивается через `RETENTION_DAYS`).

### 8.3. Восстановление

```bash
./scripts/restore.sh backups/dorm_duty_20260828_120000.sql.gz
```

**Внимание:** перезаписывает текущую базу. Перед восстановлением сделайте свежий backup.

### 8.4. Проверка backup

```bash
gzip -t backups/dorm_duty_*.sql.gz
zcat backups/dorm_duty_*.sql.gz | head -20
```

---

## 9. Обновление приложения

```bash
cd /path/to/dorm-duty
git pull
docker compose build
docker compose up -d
```

Миграции применяются автоматически сервисом `migrate` при каждом `up`.

Проверка:

```bash
docker compose logs migrate
curl -s http://localhost/health/db
npm test   # на машине разработки перед деплоем
```

### 9.1. Откат при проблеме

```bash
git checkout <предыдущий-коммит>
docker compose build
docker compose up -d
```

Если миграция уже применена и ломает схему — восстановите базу из backup (раздел 8.3).

---

## 10. Локальная разработка

```bash
npm install
cp .env.example .env
createdb dorm_duty && createdb dorm_duty_test
npm run migrate && npm run seed
npm run api          # http://localhost:3000
npm test
```

Telegram (опционально):

```bash
TELEGRAM_BOT_TOKEN=... npm run bot
TELEGRAM_BOT_TOKEN=... npm run worker
```

Создание администратора локально:

```bash
npm run admin:create -- admin@example.org "пароль" dorm_admin
```

---

## 11. Диагностика

```bash
# Состояние контейнеров
docker compose ps

# Логи
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f bot

# RAM на хосте
free -h

# Использование диска
df -h
docker system df
```

Chromium запускается **только** при экспорте PDF и завершается после генерации. Постоянно он не работает.

---

## 12. Безопасность (чеклист)

- [ ] `POSTGRES_PASSWORD` и `SESSION_SECRET` — случайные, ≥ 32 символов
- [ ] `.env` не в git
- [ ] PostgreSQL не открыт наружу
- [ ] HTTPS включён, cookie с `Secure`
- [ ] Первый admin создан через `createAdmin.ts`
- [ ] Ежедневный backup настроен и проверен
- [ ] `TELEGRAM_BOT_TOKEN` только в `.env`
- [ ] Firewall: 22, 80, 443

Пароли, токены и `DATABASE_URL` **не попадают в логи** приложения.

---

## Архитектура

```
Internet → Nginx → API → PostgreSQL
                  ↓
            Telegram Bot (long polling)
            Worker (scheduler)
            Chromium (только при PDF export)
```
