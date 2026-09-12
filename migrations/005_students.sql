-- 005 · Студенты и история проживания
--
-- students — рабочее состояние: кто живёт на этаже сейчас.
-- Подтверждённый состав фиксируется отдельно, в roster (006).
--
-- Ключевой инвариант: этаж студента совпадает с этажом его комнаты.
-- Он обеспечен составным FK (room_id, floor_id) → rooms(id, floor_id),
-- то есть проверяется базой при каждой записи, а не сервисом.

CREATE TABLE students (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id          uuid NOT NULL,
  room_id           uuid NOT NULL,

  last_name         varchar(80) NOT NULL,
  first_name        varchar(80) NOT NULL,
  middle_name       varchar(80),            -- в списке не печатается, нужно для «Ф.И.О»

  -- Принадлежность. Никак не связана с этажом: на одном этаже могут жить
  -- студенты любых факультетов.
  faculty_id        uuid REFERENCES faculties(id)    ON DELETE RESTRICT,
  study_shift_id    uuid REFERENCES study_shifts(id) ON DELETE RESTRICT,
  course            smallint,
  group_code        varchar(16),

  telegram_id       bigint UNIQUE,
  telegram_username varchar(64),
  link_code         varchar(32) UNIQUE,     -- одноразовый код привязки

  role              student_role   NOT NULL DEFAULT 'resident',
  status            student_status NOT NULL DEFAULT 'active',

  exempt_from       date,
  exempt_to         date,
  allow_busy_slots  boolean NOT NULL DEFAULT false, -- согласие дежурить в учебное время

  sort_order        int  NOT NULL DEFAULT 0,        -- порядок внутри комнаты при печати
  joined_at         date NOT NULL DEFAULT current_date,
  left_at           date,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT student_course_positive CHECK (course IS NULL OR course > 0),
  CONSTRAINT student_exempt_pair CHECK (
    exempt_from IS NULL OR exempt_to IS NULL OR exempt_to >= exempt_from
  ),

  -- Изоляция этажей на уровне БД: комната обязана принадлежать
  -- тому же этажу, что и студент.
  CONSTRAINT student_room_same_floor
    FOREIGN KEY (room_id, floor_id) REFERENCES rooms(id, floor_id) ON DELETE RESTRICT
);

COMMENT ON CONSTRAINT student_room_same_floor ON students IS
  'Студент 6 этажа не может быть привязан к комнате 7 этажа. '
  'Гарантия базы, а не сервисного слоя';

CREATE INDEX students_floor_status_idx ON students (floor_id, status);
CREATE INDEX students_room_idx         ON students (room_id);
CREATE INDEX students_faculty_idx      ON students (faculty_id) WHERE faculty_id IS NOT NULL;
CREATE INDEX students_shift_idx        ON students (study_shift_id) WHERE study_shift_id IS NOT NULL;

ALTER TABLE floors
  ADD CONSTRAINT floor_elder_fk
  FOREIGN KEY (elder_student_id) REFERENCES students(id) ON DELETE SET NULL;

-- История проживания. Периоды одного студента не пересекаются —
-- это гарантирует EXCLUDE, а не проверка в коде.
CREATE TABLE student_placements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id            uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  floor_id              uuid NOT NULL REFERENCES floors(id)   ON DELETE RESTRICT,
  block_id              uuid REFERENCES blocks(id)            ON DELETE SET NULL,
  room_id               uuid NOT NULL REFERENCES rooms(id)    ON DELETE RESTRICT,

  -- Снимки: переименование комнаты не переписывает историю.
  room_number_snapshot  varchar(16) NOT NULL,
  block_code_snapshot   varchar(16),
  floor_number_snapshot smallint    NOT NULL,

  valid_from            date NOT NULL,
  valid_to              date,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT placement_period_sane CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT placement_no_overlap EXCLUDE USING gist (
    student_id WITH =,
    daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[)') WITH &&
  )
);

CREATE INDEX placements_student_idx ON student_placements (student_id, valid_from DESC);
