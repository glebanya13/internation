-- 012 · Сессии администратора и заготовка под роль старосты
--
-- Роли уже объявлены в 008: superadmin / dorm_admin / floor_admin.
-- Область видимости floor_admin задаётся списком этажей в
-- admin_floor_scopes — номера этажей в коде не встречаются нигде.

CREATE TABLE admin_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Хранится только хэш токена: утечка таблицы не даёт войти.
  token_hash text        NOT NULL UNIQUE,
  admin_id   uuid        NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  user_agent varchar(255)
);

CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions (expires_at);

-- Староста — студент с ролью elder (см. students.role). Отдельной учётной
-- записи администратора ему не заводится: в MVP интерфейс старосты
-- не реализуется, но связь этажа со старостой уже есть (floors.elder_student_id).
COMMENT ON TABLE admin_sessions IS
  'Сессии веб-админки. Бот администратором не управляет — его интерфейс '
  'предназначен только студенту';
