-- 003 · Справочники
--
-- Факультеты, учебные смены, шаблоны смен дежурств и наборы правил.
-- Ни один из них не участвует в ветвлениях кода — сервисы только читают
-- значения. Поэтому все они таблицы, а не ENUM: администратор добавляет
-- новый факультет или смену без изменения кода.
--
-- Удаления нет нигде: is_active скрывает значение из форм добавления,
-- оставляя его в архивных списках и графиках.

CREATE TABLE faculties (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dormitory_id uuid REFERENCES dormitories(id) ON DELETE RESTRICT, -- NULL = общий справочник
  code         varchar(32)  NOT NULL,   -- то, что печатается в колонке «Факультет»
  name         varchar(255),
  is_active    boolean      NOT NULL DEFAULT true,
  sort_order   int          NOT NULL DEFAULT 0,
  created_at   timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT faculty_code_unique UNIQUE (dormitory_id, code)
);

-- Учебная смена. busy_from / busy_to заполняет администратор; пока они
-- NULL, ограничение по учебному времени не применяется — генератор
-- сообщает об этом явно, а не молчит.
CREATE TABLE study_shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dormitory_id  uuid REFERENCES dormitories(id) ON DELETE RESTRICT,
  code          varchar(16)  NOT NULL,   -- печатается в колонке «Смена»
  title         varchar(120),
  busy_from     time,
  busy_to       time,
  busy_weekdays smallint[]   NOT NULL DEFAULT '{1,2,3,4,5,6}', -- ISO: 1=Пн … 7=Вс
  is_active     boolean      NOT NULL DEFAULT true,
  sort_order    int          NOT NULL DEFAULT 0,
  created_at    timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT study_shift_code_unique UNIQUE (dormitory_id, code),
  CONSTRAINT study_shift_busy_pair CHECK (
    (busy_from IS NULL) = (busy_to IS NULL)
  ),
  CONSTRAINT study_shift_weekdays_valid CHECK (
    busy_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
  )
);

COMMENT ON COLUMN study_shifts.busy_from IS
  'Начало учебного времени. NULL — не задано, ограничение не применяется';

-- Шаблон сетки смен дежурства.
CREATE TABLE duty_slot_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dormitory_id uuid REFERENCES dormitories(id) ON DELETE RESTRICT,
  name         varchar(120) NOT NULL,
  is_active    boolean      NOT NULL DEFAULT true,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- Одна строка = одна смена одного дня недели.
-- Сколько смен в дне — определяется числом строк, а не константой.
CREATE TABLE duty_slot_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid     NOT NULL REFERENCES duty_slot_templates(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL,   -- ISO: 1=Пн … 7=Вс
  slot_order  smallint NOT NULL,
  time_from   time     NOT NULL,
  time_to     time     NOT NULL,
  label       varchar(40),

  CONSTRAINT slot_rule_unique   UNIQUE (template_id, weekday, slot_order),
  CONSTRAINT slot_rule_weekday  CHECK (weekday BETWEEN 1 AND 7),
  CONSTRAINT slot_rule_order    CHECK (slot_order > 0),
  CONSTRAINT slot_rule_interval CHECK (time_to > time_from)
);

-- Правила распределения. Ни одно не выведено из приложенных документов —
-- образец графика пуст. Всё это настройки со значением по умолчанию.
CREATE TABLE duty_rule_sets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       varchar(120) NOT NULL,
  settings   jsonb        NOT NULL,
  is_active  boolean      NOT NULL DEFAULT true,
  created_at timestamptz  NOT NULL DEFAULT now()
);

ALTER TABLE dormitories
  ADD CONSTRAINT dormitory_default_template_fk
  FOREIGN KEY (default_slot_template_id)
  REFERENCES duty_slot_templates(id) ON DELETE RESTRICT;
