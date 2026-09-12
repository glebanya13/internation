-- 006 · Roster: подтверждённый состав этажа
--
-- ИСТОЧНИК ИСТИНЫ ДЛЯ ГЕНЕРАЦИИ ГРАФИКА.
--
-- Структура (004) говорит, какие помещения существуют. Roster говорит,
-- кто фактически проживает. Генератор графика работает ТОЛЬКО с текущей
-- confirmed-версией и никогда не обходит комнаты: пустая комната, пустой
-- блок и пустой этаж просто не дают кандидатов.
--
-- Версии неизменяемы. Изменение состава создаёт новую версию, предыдущая
-- переходит в superseded и больше не редактируется никогда — иначе
-- сентябрьский график перестал бы соответствовать сентябрьскому составу.

CREATE TABLE roster_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id        uuid          NOT NULL REFERENCES floors(id) ON DELETE RESTRICT,
  version_no      int           NOT NULL,
  status          roster_status NOT NULL DEFAULT 'draft',
  source          roster_source NOT NULL,
  effective_from  date          NOT NULL DEFAULT current_date,
  note            text,

  -- Что именно изменилось относительно предыдущей версии.
  -- Заполняется сервисом, нужно для экрана истории.
  change_summary  jsonb,

  confirmed_by    uuid,
  confirmed_at    timestamptz,
  created_at      timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT roster_version_unique UNIQUE (floor_id, version_no),
  CONSTRAINT roster_version_no_positive CHECK (version_no > 0),
  CONSTRAINT roster_confirmed_has_meta CHECK (
    status <> 'confirmed' OR confirmed_at IS NOT NULL
  ),

  -- Опора для составных FK: версия навсегда принадлежит своему этажу.
  CONSTRAINT roster_version_floor_pair UNIQUE (id, floor_id)
);

-- На этаже не может быть двух актуальных версий состава.
CREATE UNIQUE INDEX roster_one_confirmed_per_floor
  ON roster_versions (floor_id)
  WHERE status = 'confirmed';

COMMENT ON TABLE roster_versions IS
  'Версии состава этажа. Текущая — единственная со статусом confirmed';

-- Строка состава. Снимок всех данных студента на момент версии, чтобы
-- состав читался без JOIN к текущим значениям.
CREATE TABLE roster_entries (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  roster_version_id         uuid NOT NULL,
  floor_id                  uuid NOT NULL,   -- дублируется ради составных FK
  student_id                uuid NOT NULL,

  full_name_snapshot        varchar(200) NOT NULL,
  room_id                   uuid         NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  room_number_snapshot      varchar(16)  NOT NULL,
  block_code_snapshot       varchar(16),
  faculty_code_snapshot     varchar(32),
  study_shift_code_snapshot varchar(16),
  course_snapshot           smallint,
  group_code_snapshot       varchar(16),
  student_status_snapshot   student_status NOT NULL,
  sort_order                int NOT NULL DEFAULT 0,

  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT roster_entry_unique UNIQUE (roster_version_id, student_id),

  -- Строка принадлежит версии своего этажа. Составной FK: floor_id версии
  -- не меняется никогда, поэтому здесь связь безопасна.
  --
  -- RESTRICT, а не CASCADE: версия с составом не удаляется вообще. CASCADE
  -- здесь был бы мёртвым — строки защищены append-only триггером, и удаление
  -- всё равно упало бы, только с менее внятной ошибкой.
  CONSTRAINT roster_entry_version_floor
    FOREIGN KEY (roster_version_id, floor_id)
    REFERENCES roster_versions(id, floor_id) ON DELETE RESTRICT,

  CONSTRAINT roster_entry_student_fk
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT
);

-- Принадлежность студента этажу проверяется ПРИ ВСТАВКЕ, а не составным
-- FK на students(id, floor_id). Причина: roster_entries — снимок. Когда
-- студент переводится с 6 этажа на 7, students.floor_id меняется, и
-- составной ключ разорвал бы все сентябрьские строки состава 6 этажа —
-- ровно ту историю, ради которой таблица существует.
-- Строки неизменяемы (триггер ниже), поэтому проверки на вставке достаточно.
CREATE OR REPLACE FUNCTION roster_entry_floor_guard() RETURNS trigger AS $$
DECLARE
  student_floor uuid;
BEGIN
  SELECT floor_id INTO student_floor FROM students WHERE id = NEW.student_id;

  IF student_floor IS DISTINCT FROM NEW.floor_id THEN
    RAISE EXCEPTION
      'Студент % относится к другому этажу и не может войти в состав этажа %',
      NEW.student_id, NEW.floor_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roster_entry_floor_check
  BEFORE INSERT ON roster_entries
  FOR EACH ROW EXECUTE FUNCTION roster_entry_floor_guard();

COMMENT ON FUNCTION roster_entry_floor_guard() IS
  'Студент может попасть только в roster своего этажа. Проверка на вставке: '
  'строки состава неизменяемы и должны переживать перевод на другой этаж';

CREATE INDEX roster_entries_version_idx ON roster_entries (roster_version_id, student_status_snapshot);
CREATE INDEX roster_entries_student_idx ON roster_entries (student_id);

-- Строки состава неизменяемы: правка идёт через новую версию.
CREATE TRIGGER roster_entries_append_only
  BEFORE UPDATE OR DELETE ON roster_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Импорт списка. Import → Preview → Apply.
-- Пока state <> 'applied', в students не записано НИЧЕГО.
CREATE TABLE roster_imports (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id                  uuid        NOT NULL REFERENCES floors(id) ON DELETE RESTRICT,
  file_name                 varchar(255) NOT NULL,
  file_id                   uuid,

  parsed_rows               jsonb NOT NULL,   -- как распознали файл
  diff                      jsonb NOT NULL,   -- added | removed | changed | unchanged | unmatched
  decisions                 jsonb,            -- решение администратора по каждой строке

  state                     varchar(16) NOT NULL DEFAULT 'pending',
  created_roster_version_id uuid REFERENCES roster_versions(id) ON DELETE SET NULL,

  uploaded_by               uuid,
  uploaded_at               timestamptz NOT NULL DEFAULT now(),
  applied_by                uuid,
  applied_at                timestamptz,

  CONSTRAINT roster_import_state CHECK (state IN ('pending', 'applied', 'rejected')),
  -- Применённый импорт обязан иметь отметку о применении. Версия при этом
  -- может отсутствовать: импорт, поправивший только атрибуты, состав
  -- не меняет и новую версию не создаёт.
  CONSTRAINT roster_import_applied_meta CHECK (
    state <> 'applied' OR applied_at IS NOT NULL
  )
);

CREATE INDEX roster_imports_floor_idx ON roster_imports (floor_id, uploaded_at DESC);
