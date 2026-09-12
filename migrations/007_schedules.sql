-- 007 · Графики дежурств
--
-- Опубликованный график — исторический документ, а не представление
-- текущих данных. Он должен печататься одинаково сегодня и через три года,
-- поэтому копирует в себя всё, от чего зависит печать:
-- roster-версию, сетку смен, правила, реквизиты подписантов, ФИО и комнаты.
--
-- Изменение студентов, комнат, факультетов, смен, настроек и шаблона
-- НЕ ДОЛЖНО менять опубликованный график.

CREATE TABLE duty_schedules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id               uuid            NOT NULL,
  year                   smallint        NOT NULL,
  month                  smallint        NOT NULL,
  status                 schedule_status NOT NULL DEFAULT 'draft',

  -- По какому составу построен график. NOT NULL: график без известного
  -- состава не имеет смысла.
  roster_version_id      uuid            NOT NULL,

  slot_template_snapshot jsonb NOT NULL,  -- сетка смен на момент генерации
  rule_set_snapshot      jsonb NOT NULL,  -- правила на момент генерации
  dormitory_snapshot     jsonb NOT NULL,  -- № общежития и этажа для заголовка
  approval_snapshot      jsonb,           -- ФИО подписантов на момент публикации

  generated_by           varchar(16) NOT NULL,  -- algorithm | ai | manual
  validation_warnings    jsonb,

  published_at           timestamptz,
  published_by           uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT schedule_period_unique UNIQUE (floor_id, year, month),
  CONSTRAINT schedule_year_sane   CHECK (year > 1900),
  CONSTRAINT schedule_month_sane  CHECK (month BETWEEN 1 AND 12),
  CONSTRAINT schedule_engine_sane CHECK (generated_by IN ('algorithm', 'ai', 'manual')),
  CONSTRAINT schedule_published_meta CHECK (
    status <> 'published' OR published_at IS NOT NULL
  ),

  CONSTRAINT schedule_floor_fk FOREIGN KEY (floor_id)
    REFERENCES floors(id) ON DELETE RESTRICT,

  -- Составной FK: roster-версия обязана принадлежать этажу графика.
  -- Это правило валидации V21, вынесенное на уровень БД.
  CONSTRAINT schedule_roster_same_floor
    FOREIGN KEY (roster_version_id, floor_id)
    REFERENCES roster_versions(id, floor_id) ON DELETE RESTRICT,

  CONSTRAINT schedule_floor_pair UNIQUE (id, floor_id)
);

COMMENT ON CONSTRAINT schedule_roster_same_floor ON duty_schedules IS
  'График не может быть построен по составу другого этажа';

CREATE INDEX schedules_floor_period_idx ON duty_schedules (floor_id, year DESC, month DESC);

CREATE TABLE duties (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id           uuid     NOT NULL REFERENCES duty_schedules(id) ON DELETE RESTRICT,
  duty_date             date     NOT NULL,
  slot_order            smallint NOT NULL,
  time_from             time     NOT NULL,   -- копия из шаблона, не ссылка
  time_to               time     NOT NULL,

  student_id            uuid REFERENCES students(id) ON DELETE RESTRICT,

  -- Снимки для печати. Живут независимо от текущих значений:
  -- переезд и перевод не переписывают подписанный документ.
  student_name_snapshot varchar(200),
  room_number_snapshot  varchar(16),
  floor_number_snapshot smallint,

  status                duty_status NOT NULL DEFAULT 'scheduled',
  confirmed_at          timestamptz,
  closed_at             timestamptz,
  closed_by             uuid,
  comment               text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT duty_slot_unique UNIQUE (schedule_id, duty_date, slot_order),
  CONSTRAINT duty_slot_order_positive CHECK (slot_order > 0),
  CONSTRAINT duty_interval_sane CHECK (time_to > time_from),
  -- Назначенное дежурство обязано нести данные для печати.
  CONSTRAINT duty_assigned_has_snapshot CHECK (
    student_id IS NULL OR (
      student_name_snapshot IS NOT NULL AND
      room_number_snapshot  IS NOT NULL AND
      floor_number_snapshot IS NOT NULL
    )
  )
);

-- Один студент не дежурит дважды в один день.
-- Индекс снимается миграцией, если правило max_duties_per_day выключено.
CREATE UNIQUE INDEX duty_one_per_student_per_day
  ON duties (schedule_id, duty_date, student_id)
  WHERE student_id IS NOT NULL;

CREATE INDEX duties_schedule_date_idx ON duties (schedule_id, duty_date, slot_order);
CREATE INDEX duties_student_date_idx  ON duties (student_id, duty_date) WHERE student_id IS NOT NULL;

-- Журнал замен. Печатается в таблицу «Изменения в графике дежурств».
-- Только вставка: журнал, который можно переписать, бесполезен.
CREATE TABLE duty_changes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_id               uuid NOT NULL REFERENCES duties(id) ON DELETE RESTRICT,
  change_date           date NOT NULL,

  from_student_id       uuid REFERENCES students(id) ON DELETE RESTRICT,
  from_name_snapshot    varchar(200),
  from_room_snapshot    varchar(16),
  to_student_id         uuid REFERENCES students(id) ON DELETE RESTRICT,
  to_name_snapshot      varchar(200),
  to_room_snapshot      varchar(16),

  time_from             time,
  time_to               time,
  reason                text,
  source                change_source NOT NULL,

  changed_by_admin_id   uuid,
  changed_by_student_id uuid,
  changed_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX duty_changes_duty_idx ON duty_changes (duty_id, changed_at);

CREATE TRIGGER duty_changes_append_only
  BEFORE UPDATE OR DELETE ON duty_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
