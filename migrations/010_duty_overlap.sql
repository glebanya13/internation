-- 010 · Настоящее hard-ограничение по времени вместо «одно дежурство в день»
--
-- В M1 стоял уникальный индекс duty_one_per_student_per_day. Он зашивал
-- в схему настройку max_duties_per_day = 1, хотя она конфигурируется,
-- а «два дежурства в один день» — SOFT-ограничение: генератор избегает
-- этого, но обязан иметь право нарушить, когда иначе слот не закрыть
-- (например, утренние смены доступны лишь части студентов).
--
-- Настоящее hard-ограничение другое: у одного студента не может быть двух
-- ПЕРЕСЕКАЮЩИХСЯ ПО ВРЕМЕНИ дежурств. Именно оно и выражается ниже.

DROP INDEX IF EXISTS duty_one_per_student_per_day;

-- Период дежурства как диапазон. Вычисляется базой, рассинхронизироваться
-- с duty_date/time_from/time_to не может.
ALTER TABLE duties
  ADD COLUMN duty_period tsrange
  GENERATED ALWAYS AS (
    tsrange(
      (duty_date + time_from)::timestamp,
      (duty_date + time_to)::timestamp,
      '[)'
    )
  ) STORED;

ALTER TABLE duties
  ADD CONSTRAINT duty_no_time_overlap
  EXCLUDE USING gist (
    schedule_id WITH =,
    student_id  WITH =,
    duty_period WITH &&
  )
  WHERE (student_id IS NOT NULL);

COMMENT ON CONSTRAINT duty_no_time_overlap ON duties IS
  'HARD: у одного студента не может быть двух пересекающихся по времени '
  'дежурств. Несколько непересекающихся в один день допустимы — это SOFT, '
  'регулируется max_duties_per_day';
