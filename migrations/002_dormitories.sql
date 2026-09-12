-- 002 · Общежития
--
-- Реквизиты подписантов хранятся здесь и копируются в approval_snapshot
-- графика при публикации: смена заведующего не должна переписывать
-- уже подписанные документы.

CREATE TABLE dormitories (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                   varchar(16)  NOT NULL,
  name                     varchar(255),
  timezone                 varchar(64)  NOT NULL DEFAULT 'Europe/Minsk',

  -- Только для печатной формы графика (блок «Утверждаю / Согласовано»).
  warden_name              varchar(120),  -- заведующий общежитием
  curator_name             varchar(120),  -- куратор общежития
  council_head_name        varchar(120),  -- председатель студсовета

  default_slot_template_id uuid,          -- FK добавляется в 003
  is_active                boolean      NOT NULL DEFAULT true,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT dormitory_number_unique UNIQUE (number)
);

COMMENT ON COLUMN dormitories.warden_name IS
  'presentation-only: печатается в блоке подписей графика';
COMMENT ON COLUMN dormitories.curator_name IS
  'presentation-only: печатается в блоке подписей графика';
COMMENT ON COLUMN dormitories.council_head_name IS
  'presentation-only: печатается в блоке подписей графика';
