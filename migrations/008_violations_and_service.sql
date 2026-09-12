-- 008 · Нарушения, уведомления, доступ, аудит

-- Пропуск не равен нарушению: между reported и confirmed всегда стоит
-- решение человека. Счётчик растёт только на confirmed.
CREATE TABLE violations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id          uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  duty_id             uuid NOT NULL UNIQUE REFERENCES duties(id) ON DELETE RESTRICT,

  state               violation_state NOT NULL DEFAULT 'reported',
  sequence_no         smallint,          -- какой по счёту подтверждённый в окне подсчёта
  reason              text,
  explanation_text    text,
  explanation_file_id uuid,

  reported_by         uuid,
  reported_at         timestamptz NOT NULL DEFAULT now(),
  resolved_by         uuid,
  resolved_at         timestamptz,

  CONSTRAINT violation_sequence_positive CHECK (sequence_no IS NULL OR sequence_no > 0)
);

CREATE INDEX violations_student_state_idx ON violations (student_id, state);

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    uuid REFERENCES students(id)   ON DELETE CASCADE,
  admin_user_id uuid,
  duty_id       uuid REFERENCES duties(id)     ON DELETE CASCADE,
  violation_id  uuid REFERENCES violations(id) ON DELETE CASCADE,

  type          varchar(40) NOT NULL,
  payload       jsonb       NOT NULL,
  scheduled_at  timestamptz NOT NULL,
  sent_at       timestamptz,
  state         varchar(16) NOT NULL DEFAULT 'pending',
  attempts      smallint    NOT NULL DEFAULT 0,
  error         text,

  CONSTRAINT notification_state_sane CHECK (state IN ('pending', 'sent', 'failed', 'skipped'))
);

-- Защита от дублей при рестарте воркера: одно уведомление данного типа
-- на пару (студент, дежурство/нарушение).
-- На PostgreSQL 15+ это записывалось бы как UNIQUE NULLS NOT DISTINCT;
-- здесь целевая версия 14, поэтому NULL сводится к нулевому UUID.
CREATE UNIQUE INDEX notification_idempotent ON notifications (
  COALESCE(student_id,   '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(duty_id,      '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(violation_id, '00000000-0000-0000-0000-000000000000'::uuid),
  type
);

CREATE INDEX notifications_due_idx ON notifications (scheduled_at) WHERE state = 'pending';

CREATE TABLE admin_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         varchar(255) NOT NULL UNIQUE,
  password_hash text         NOT NULL,
  full_name     varchar(200),
  role          admin_role   NOT NULL,
  dormitory_id  uuid REFERENCES dormitories(id) ON DELETE RESTRICT,
  telegram_id   bigint UNIQUE,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

-- Область видимости floor_admin — список этажей, а не номера в коде.
CREATE TABLE admin_floor_scopes (
  admin_user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  floor_id      uuid NOT NULL REFERENCES floors(id)      ON DELETE CASCADE,
  PRIMARY KEY (admin_user_id, floor_id)
);

-- Изменения атрибутов студента (ФИО, факультет, курс, группа, смена,
-- telegram_id) состав не меняют и новой roster-версии не создают —
-- они попадают сюда.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_type  varchar(16) NOT NULL,   -- admin | student | system
  actor_id    uuid,
  action      varchar(64) NOT NULL,
  entity      varchar(64) NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_actor_sane CHECK (actor_type IN ('admin', 'student', 'system'))
);

CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id, at DESC);

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
