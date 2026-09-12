-- 011 · Состояния дежурства, настройки уведомлений, замены
--
-- Статусы дежурства сведены к минимально необходимым.
-- Было: scheduled / confirmed / completed / missed / excused.
-- Стало: scheduled / completed / missed / cancelled.
--
-- Убраны:
--   confirmed — в MVP отметку делает администратор, самоподтверждения нет;
--   excused   — уважительность живёт в violations.state и там же решает,
--               считать ли пропуск нарушением. Дублировать её в статусе
--               дежурства значит завести два источника правды.

CREATE TYPE duty_status_v2 AS ENUM ('scheduled', 'completed', 'missed', 'cancelled');

ALTER TABLE duties ALTER COLUMN status DROP DEFAULT;

ALTER TABLE duties
  ALTER COLUMN status TYPE duty_status_v2
  USING (
    CASE status::text
      WHEN 'confirmed' THEN 'scheduled'
      WHEN 'excused'   THEN 'missed'
      ELSE status::text
    END
  )::duty_status_v2;

ALTER TABLE duties ALTER COLUMN status SET DEFAULT 'scheduled';

DROP TYPE duty_status;
ALTER TYPE duty_status_v2 RENAME TO duty_status;

-- Настройки общежития: порог пропусков и время напоминания.
-- Значения по умолчанию, а не константы в коде.
ALTER TABLE dormitories
  ADD COLUMN settings jsonb NOT NULL DEFAULT jsonb_build_object(
    'violation_threshold', 3,
    'reminder_hours_before', 24,
    'academic_year_start_month', 9
  );

COMMENT ON COLUMN dormitories.settings IS
  'violation_threshold — после скольких подтверждённых пропусков требуется '
  'объяснительная; reminder_hours_before — за сколько часов напоминать; '
  'academic_year_start_month — с какого месяца считается учебный год';

-- Замены. duty_changes уже хранит кто, когда, причину и обе стороны —
-- добавляем только связь с уведомлениями обоих участников.
ALTER TABLE notifications
  ADD COLUMN duty_change_id uuid REFERENCES duty_changes(id) ON DELETE CASCADE;

-- Идемпотентность с учётом замены: одно уведомление данного типа
-- на пару (студент, дежурство/нарушение/замена).
DROP INDEX IF EXISTS notification_idempotent;
CREATE UNIQUE INDEX notification_idempotent ON notifications (
  COALESCE(student_id,     '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(duty_id,        '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(violation_id,   '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(duty_change_id, '00000000-0000-0000-0000-000000000000'::uuid),
  type
);

COMMENT ON INDEX notification_idempotent IS
  'Напоминание и уведомление отправляются ровно один раз, сколько бы раз '
  'ни просыпался планировщик';

-- Замена меняет назначение уже опубликованного графика. Триггер из 009
-- это запрещает — и правильно: молча переписывать подписанный документ
-- нельзя. Замена разрешается только вместе с записью в duty_changes,
-- которая печатается в таблице изменений бланка.
CREATE OR REPLACE FUNCTION duty_locked_after_publish() RETURNS trigger AS $$
DECLARE
  schedule_state schedule_status;
  assignment_changed boolean;
BEGIN
  SELECT status INTO schedule_state FROM duty_schedules WHERE id = OLD.schedule_id;

  assignment_changed :=
       NEW.student_id            IS DISTINCT FROM OLD.student_id
    OR NEW.student_name_snapshot IS DISTINCT FROM OLD.student_name_snapshot
    OR NEW.room_number_snapshot  IS DISTINCT FROM OLD.room_number_snapshot
    OR NEW.floor_number_snapshot IS DISTINCT FROM OLD.floor_number_snapshot
    OR NEW.duty_date             IS DISTINCT FROM OLD.duty_date
    OR NEW.slot_order            IS DISTINCT FROM OLD.slot_order
    OR NEW.time_from             IS DISTINCT FROM OLD.time_from
    OR NEW.time_to               IS DISTINCT FROM OLD.time_to;

  IF schedule_state IN ('published', 'archived') AND assignment_changed THEN
    -- Разрешено, только если замена уже зафиксирована в журнале изменений.
    IF NOT EXISTS (
      SELECT 1 FROM duty_changes
       WHERE duty_id = OLD.id
         AND changed_at > now() - interval '5 seconds'
    ) THEN
      RAISE EXCEPTION
        'Назначения опубликованного графика меняются только через замену: '
        'сначала запись в duty_changes'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
