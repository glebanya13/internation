-- 009 · История генераций. Удаление следов AI.
--
-- AI из системы исключён полностью: ни таблиц, ни вариантов generated_by.
-- За этим следит tests/invariants/no-ai.test.ts.

ALTER TABLE duty_schedules DROP CONSTRAINT IF EXISTS schedule_engine_sane;
ALTER TABLE duty_schedules
  ADD CONSTRAINT schedule_engine_sane
  CHECK (generated_by IN ('algorithm', 'manual'));

-- Каждый прогон генератора. Перегенерация не уничтожает предыдущий
-- черновик молча: он остаётся здесь целиком, вместе с назначениями.
CREATE TABLE duty_generations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        uuid     NOT NULL REFERENCES duty_schedules(id) ON DELETE CASCADE,
  attempt_no         int      NOT NULL,

  -- Воспроизводимость: те же вход и настройки дают тот же результат.
  algorithm          varchar(40) NOT NULL,
  seed               varchar(120) NOT NULL,
  rule_set_snapshot  jsonb    NOT NULL,
  roster_version_id  uuid     NOT NULL REFERENCES roster_versions(id) ON DELETE RESTRICT,

  -- Полный набор назначений этого прогона.
  assignments        jsonb    NOT NULL,
  stats              jsonb    NOT NULL,
  warnings           jsonb    NOT NULL DEFAULT '[]',
  relaxations        jsonb    NOT NULL DEFAULT '[]',

  /* Актуален ли этот прогон. Ровно один на график. */
  is_current         boolean  NOT NULL DEFAULT true,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT generation_attempt_unique UNIQUE (schedule_id, attempt_no),
  CONSTRAINT generation_attempt_positive CHECK (attempt_no > 0)
);

CREATE UNIQUE INDEX generation_one_current
  ON duty_generations (schedule_id)
  WHERE is_current;

CREATE INDEX generations_schedule_idx ON duty_generations (schedule_id, attempt_no DESC);

COMMENT ON TABLE duty_generations IS
  'История прогонов генератора. Перегенерация добавляет строку, '
  'предыдущие остаются доступными для разбора';

-- Прогон неизменяем: перегенерация создаёт новый, а не правит старый.
-- Исключение — снятие флага is_current, это делает сервис.
CREATE OR REPLACE FUNCTION generation_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'История генераций не удаляется'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.assignments IS DISTINCT FROM OLD.assignments
     OR NEW.stats      IS DISTINCT FROM OLD.stats
     OR NEW.seed       IS DISTINCT FROM OLD.seed
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no THEN
    RAISE EXCEPTION 'Прогон генерации нельзя переписать: создайте новый'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER duty_generations_immutable
  BEFORE UPDATE OR DELETE ON duty_generations
  FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- Публикация запирает назначения: после неё состав дежурных не меняется
-- вместе с текущим roster.
CREATE OR REPLACE FUNCTION duty_locked_after_publish() RETURNS trigger AS $$
DECLARE
  schedule_state schedule_status;
BEGIN
  SELECT status INTO schedule_state FROM duty_schedules WHERE id = OLD.schedule_id;

  IF schedule_state IN ('published', 'archived')
     AND (NEW.student_id            IS DISTINCT FROM OLD.student_id
       OR NEW.student_name_snapshot IS DISTINCT FROM OLD.student_name_snapshot
       OR NEW.room_number_snapshot  IS DISTINCT FROM OLD.room_number_snapshot
       OR NEW.floor_number_snapshot IS DISTINCT FROM OLD.floor_number_snapshot
       OR NEW.duty_date             IS DISTINCT FROM OLD.duty_date
       OR NEW.slot_order            IS DISTINCT FROM OLD.slot_order
       OR NEW.time_from             IS DISTINCT FROM OLD.time_from
       OR NEW.time_to               IS DISTINCT FROM OLD.time_to) THEN
    RAISE EXCEPTION
      'Назначения опубликованного графика неизменяемы. Замена оформляется через duty_changes'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER duties_locked_after_publish
  BEFORE UPDATE ON duties
  FOR EACH ROW EXECUTE FUNCTION duty_locked_after_publish();

COMMENT ON FUNCTION duty_locked_after_publish() IS
  'После публикации меняются только статус выполнения и отметки, '
  'но не сам состав дежурных';
