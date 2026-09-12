-- 001 · Расширения и перечисления состояний
--
-- Здесь и только здесь заводятся ENUM. Критерий — раздел 19 спецификации:
-- новое значение требует новой логики в коде (переходы, права, печать).
-- Всё, что администратор может добавить сам (факультеты, этажи, смены,
-- шаблоны), живёт в таблицах, а не в типах.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "btree_gist"; -- EXCLUDE по (uuid, daterange)

CREATE TYPE student_status  AS ENUM ('active', 'suspended', 'moved_out');
CREATE TYPE student_role    AS ENUM ('resident', 'elder');
CREATE TYPE roster_status   AS ENUM ('draft', 'confirmed', 'superseded');
CREATE TYPE schedule_status AS ENUM ('draft', 'published', 'archived');
CREATE TYPE duty_status     AS ENUM ('scheduled', 'confirmed', 'completed', 'missed', 'excused');
CREATE TYPE violation_state AS ENUM ('reported', 'confirmed', 'excused', 'explanation_required', 'explained');
CREATE TYPE change_source   AS ENUM ('admin', 'elder', 'swap_request');
CREATE TYPE admin_role      AS ENUM ('superadmin', 'dorm_admin', 'floor_admin');

-- Источник версии состава. Причина, по которой версия появилась.
CREATE TYPE roster_source   AS ENUM ('setup', 'manual', 'import');

-- Запрещает UPDATE и DELETE. Вешается на таблицы-журналы, которые
-- по определению существуют только в режиме добавления.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Таблица % доступна только для вставки: % запрещён',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
