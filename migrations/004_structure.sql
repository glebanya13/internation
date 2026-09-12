-- 004 · Структура: этажи, блоки, комнаты
--
-- ЭТО СТРУКТУРА, А НЕ ЗАСЕЛЕНИЕ.
-- Таблицы этого файла отвечают на вопрос «какие помещения существуют».
-- На вопрос «кто в них живёт» отвечает roster (006). Ни у одной таблицы
-- здесь нет и не появится поля вместимости: сколько человек живёт в
-- комнате — это COUNT(*) по students, и ноль является валидным значением.
--
-- Изоляция этажей держится на СОСТАВНЫХ ВНЕШНИХ КЛЮЧАХ, а не на триггерах
-- и не на дисциплине сервисного слоя. Каждая таблица несёт floor_id, и FK
-- проверяет пару (id, floor_id) — поэтому «комната 7 этажа в блоке 6 этажа»
-- невыразима на уровне БД.

CREATE TABLE floors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dormitory_id     uuid     NOT NULL REFERENCES dormitories(id) ON DELETE RESTRICT,
  number           smallint NOT NULL,      -- для сортировки и подстановки в заголовок
  code             varchar(16),            -- отображение, если этаж не просто число
  title            varchar(120),

  slot_template_id uuid     NOT NULL REFERENCES duty_slot_templates(id) ON DELETE RESTRICT,
  rule_set_id      uuid     NOT NULL REFERENCES duty_rule_sets(id)      ON DELETE RESTRICT,
  elder_student_id uuid,                   -- FK добавляется в 005

  -- Параметры ПЕЧАТНОЙ ФОРМЫ. К заселению отношения не имеют.
  -- Читает единственный потребитель — ExportService.
  print_min_rows    smallint,              -- добивка пустыми строками; NULL = по факту
  print_empty_rooms boolean  NOT NULL DEFAULT true,

  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT floor_number_unique UNIQUE (dormitory_id, number),
  CONSTRAINT floor_print_min_rows_sane CHECK (print_min_rows IS NULL OR print_min_rows >= 0),

  -- Опора для составных FK ниже.
  CONSTRAINT floor_id_self UNIQUE (id, dormitory_id)
);

COMMENT ON COLUMN floors.print_min_rows IS
  'presentation-only: минимум строк на комнату в бланке. НЕ вместимость. '
  'Не используется в генерации, валидации и feasibility';
COMMENT ON COLUMN floors.print_empty_rooms IS
  'presentation-only: показывать ли комнаты без жильцов в печатной форме';

-- В таблице floors НЕТ и не должно появиться ссылки на faculties.
-- Этаж и факультет — независимые характеристики студента.

CREATE TABLE blocks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id   uuid        NOT NULL REFERENCES floors(id) ON DELETE RESTRICT,
  code       varchar(16) NOT NULL,
  sort_order int         NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT block_code_unique UNIQUE (floor_id, code),
  -- Опора для составного FK из rooms.
  CONSTRAINT block_floor_pair UNIQUE (id, floor_id)
);

CREATE TABLE rooms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id       uuid        NOT NULL REFERENCES floors(id) ON DELETE RESTRICT,
  block_id       uuid,       -- NULL = плоская нумерация, блоков на этаже нет
  number         varchar(16) NOT NULL,   -- «601», «605А» — буква часть идентификатора
  print_min_rows smallint,               -- переопределяет floors.print_min_rows
  sort_order     int         NOT NULL DEFAULT 0,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT room_number_unique UNIQUE (floor_id, number),
  CONSTRAINT room_print_min_rows_sane CHECK (print_min_rows IS NULL OR print_min_rows >= 0),

  -- Блок, если указан, обязан быть на том же этаже.
  -- MATCH SIMPLE: при block_id IS NULL ограничение считается выполненным,
  -- то есть комната без блока полностью легальна.
  CONSTRAINT room_block_same_floor
    FOREIGN KEY (block_id, floor_id) REFERENCES blocks(id, floor_id) ON DELETE SET NULL,

  -- Опора для составного FK из students.
  CONSTRAINT room_floor_pair UNIQUE (id, floor_id)
);

COMMENT ON TABLE rooms IS
  'Физическая структура. Вместимости нет: число проживающих определяется '
  'записями students и может быть нулевым';
COMMENT ON COLUMN rooms.print_min_rows IS
  'presentation-only: минимум строк в бланке для этой комнаты. НЕ вместимость';

CREATE INDEX rooms_floor_sort_idx ON rooms (floor_id, sort_order, number);
CREATE INDEX blocks_floor_sort_idx ON blocks (floor_id, sort_order, code);
