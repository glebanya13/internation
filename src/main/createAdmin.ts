import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { createAdmin } from '../services/auth/authService.js';

/**
 * Создание учётной записи администратора.
 * Запуск: npx tsx src/main/createAdmin.ts почта пароль [роль]
 */
const [email, password, role = 'dorm_admin'] = process.argv.slice(2);
if (!email || !password) {
  console.error('Использование: createAdmin.ts <почта> <пароль> [superadmin|dorm_admin|floor_admin]');
  process.exit(1);
}

const db = createPool(config.databaseUrl);
try {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM dormitories ORDER BY number LIMIT 1',
  );
  const id = await createAdmin(db, {
    email,
    password,
    role: role as 'superadmin' | 'dorm_admin' | 'floor_admin',
    dormitoryId: rows[0]?.id ?? null,
  });
  console.log(`Администратор создан: ${email} (${role})`);
  console.log(`id: ${id}`);
} finally {
  await db.end();
}
