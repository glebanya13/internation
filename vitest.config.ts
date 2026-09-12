import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    // Тесты инвариантов работают с общей БД и меняют состав этажей.
    // Параллельный прогон дал бы ложные срабатывания на уникальном
    // индексе «одна confirmed версия на этаж».
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
