-- 013 · Телефон студента (с бланка комнаты)
-- Атрибут: не меняет состав этажа.

ALTER TABLE students
  ADD COLUMN phone varchar(32);

COMMENT ON COLUMN students.phone IS
  'Мобильный с бланка комнаты, например +375291234567';
