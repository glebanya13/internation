/**
 * Заполнение 7 этажа по бланкам комнат 701–716.
 */
import { config } from '../config.js';
import { facultyForGroup } from '../domain/facultyGroup.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

interface Person {
  room: string;
  last: string;
  first: string;
  middle?: string;
  faculty: string;
  course: number | null;
  groupNo: number | null;
  phone?: string;
  /** Факультет с бланка (ФИТ, ХТИТ, ИЭФ), а не вывод из номера группы */
  explicitFaculty?: boolean;
}

const RESIDENTS: Person[] = [
  // 701
  { room: '701Б', last: 'Стадник', first: 'Алина', middle: 'Руслановна', faculty: 'ПИ', course: 3, groupNo: 1 },
  { room: '701Б', last: 'Малиновская', first: 'Диана', middle: 'Романовна', faculty: 'ПИ', course: 3, groupNo: 1 },
  // 702
  { room: '702А', last: 'Позин', first: 'Семён', middle: 'Сергеевич', faculty: 'ПИ', course: 4, groupNo: 2 },
  { room: '702А', last: 'Гутор', first: 'Алексей', middle: 'Вадимович', faculty: 'ПИ', course: 4, groupNo: 1 },
  { room: '702А', last: 'Березко', first: 'Вадим', middle: 'Сергеевич', faculty: 'ПИ', course: 4, groupNo: 1 },
  { room: '702Б', last: 'Кравченко', first: 'Сергей', middle: 'Сергеевич', faculty: 'ПИ', course: 4, groupNo: 6 },
  { room: '702Б', last: 'Куцерук', first: 'Николай', middle: 'Петрович', faculty: 'ПИ', course: 4, groupNo: 6 },
  // 703
  { room: '703А', last: 'Позняк', first: 'Александра', middle: 'Юрьевна', faculty: 'ЦД', course: 2, groupNo: 5 },
  { room: '703А', last: 'Мендык', first: 'Алина', middle: 'Дмитриевна', faculty: 'ЦД', course: 2, groupNo: 5, phone: '+375333514646' },
  { room: '703А', last: 'Каташук', first: 'Виктория', middle: 'Андреевна', faculty: 'ЦД', course: 2, groupNo: 5, phone: '+375295318314' },
  { room: '703Б', last: 'Григорян', first: 'Анна', middle: 'Артёмовна', faculty: 'ЦД', course: 2, groupNo: 5 },
  { room: '703Б', last: 'Михайловская', first: 'Валерия', middle: 'Евгеньевна', faculty: 'ПИ', course: 3, groupNo: 4 },
  // 704
  { room: '704А', last: 'Рекруткин', first: 'Никита', middle: 'Валерьевич', faculty: 'ПИ', course: 1, groupNo: 7 },
  { room: '704А', last: 'Сорока', first: 'Константин', middle: 'Игоревич', faculty: 'ПИ', course: 1, groupNo: 7 },
  { room: '704А', last: 'Волынец', first: 'Олег', middle: 'Витальевич', faculty: 'ПИ', course: 1, groupNo: 7, phone: '+375299939277' },
  { room: '704Б', last: 'Мицкевич', first: 'Кирилл', middle: 'Владимирович', faculty: 'ИСИТ', course: 2, groupNo: 3 },
  { room: '704Б', last: 'Филин', first: 'Олег', middle: 'Сергеевич', faculty: 'ПИ', course: 2, groupNo: 8, phone: '+375445138689' },
  // 705 — китайский сегмент
  { room: '705А', last: 'Ван', first: 'Ли', faculty: 'ИЭФ', course: null, groupNo: null },
  { room: '705Б', last: 'Сюй', first: 'Яни', faculty: 'ИЭФ', course: null, groupNo: null, phone: '+375256964009' },
  { room: '705Б', last: 'Чэнь', first: 'Вэйюй', faculty: 'ИЭФ', course: null, groupNo: null, phone: '+375298193283' },
  // 706
  { room: '706А', last: 'Пискунова', first: 'Вероника', middle: 'Сергеевна', faculty: 'ЦД', course: 1, groupNo: 5 },
  { room: '706А', last: 'Позина', first: 'Алиса', middle: 'Сергеевна', faculty: 'ЦД', course: 1, groupNo: 5 },
  { room: '706А', last: 'Стахейко', first: 'Александра', middle: 'Александровна', faculty: 'ЦД', course: 1, groupNo: 5 },
  { room: '706Б', last: 'Наркевич', first: 'Елена', middle: 'Сергеевна', faculty: 'ИСИТ', course: 3, groupNo: 1 },
  // 708 — китайский сегмент
  { room: '708А', last: 'Кун', first: 'Ихао', faculty: 'ИЭФ', course: null, groupNo: null, phone: '+375259803402' },
  { room: '708А', last: 'Му', first: 'Даохуэй', faculty: 'ИЭФ', course: null, groupNo: null, phone: '+375257456132' },
  { room: '708Б', last: 'Цзя', first: 'Чжицзе', faculty: 'ИЭФ', course: null, groupNo: null, phone: '+375257452645' },
  { room: '708Б', last: 'Му', first: 'Цзяньцы', faculty: 'ИЭФ', course: null, groupNo: null },
  // 709
  { room: '709А', last: 'Адарь', first: 'Владислав', middle: 'Андреевич', faculty: 'ФИТ', course: 3, groupNo: 9, explicitFaculty: true },
  { room: '709А', last: 'Бурбис', first: 'Кирилл', middle: 'Анатольевич', faculty: 'ФИТ', course: 3, groupNo: 9, explicitFaculty: true },
  { room: '709А', last: 'Манько', first: 'Егор', middle: 'Дмитриевич', faculty: 'ФИТ', course: 3, groupNo: 9, explicitFaculty: true },
  { room: '709Б', last: 'Лицов', first: 'Виталий', middle: 'Юрьевич', faculty: 'ФИТ', course: 3, groupNo: 10, explicitFaculty: true },
  { room: '709Б', last: 'Лавшук', first: 'Станислав', middle: 'Александрович', faculty: 'ФИТ', course: 3, groupNo: 7, explicitFaculty: true },
  // 710
  { room: '710А', last: 'Курбан', first: 'Александра', middle: 'Павловна', faculty: 'ФИТ', course: 1, groupNo: 5, explicitFaculty: true },
  { room: '710А', last: 'Мукошик', first: 'Маргарита', middle: 'Максимовна', faculty: 'ФИТ', course: 1, groupNo: 5, explicitFaculty: true },
  { room: '710А', last: 'Мазурец', first: 'Арина', middle: 'Сергеевна', faculty: 'ФИТ', course: 1, groupNo: 5, explicitFaculty: true },
  { room: '710Б', last: 'Кудривцева', first: 'Анастасия', middle: 'Васильевна', faculty: 'ФИТ', course: 3, groupNo: 4, explicitFaculty: true },
  { room: '710Б', last: 'Домбальская', first: 'Яна', middle: 'Сергеевна', faculty: 'ФИТ', course: 4, groupNo: 5, explicitFaculty: true },
  // 711
  { room: '711А', last: 'Домовений', first: 'Артемий', middle: 'Викторович', faculty: 'ФИТ', course: 2, groupNo: 8, explicitFaculty: true },
  { room: '711А', last: 'Браим', first: 'Никита', middle: 'Николаевич', faculty: 'ФИТ', course: 2, groupNo: 8, explicitFaculty: true, phone: '+375293830931' },
  { room: '711А', last: 'Досов', first: 'Никита', middle: 'Павлович', faculty: 'ФИТ', course: 2, groupNo: 8, explicitFaculty: true },
  { room: '711Б', last: 'Лис', first: 'Денис', middle: 'Александрович', faculty: 'ФИТ', course: 2, groupNo: 5, explicitFaculty: true, phone: '+375445866567' },
  { room: '711Б', last: 'Кулешовец', first: 'Никита', middle: 'Андреевич', faculty: 'ФИТ', course: 2, groupNo: 8, explicitFaculty: true, phone: '+375299776801' },
  // 712
  { room: '712А', last: 'Горкуша', first: 'Илья', middle: 'Владимирович', faculty: 'ФИТ', course: 3, groupNo: 8, explicitFaculty: true },
  { room: '712А', last: 'Бужевич', first: 'Руслан', middle: 'Сергеевич', faculty: 'ФИТ', course: 3, groupNo: 8, explicitFaculty: true },
  { room: '712А', last: 'Балбасов', first: 'Никита', middle: 'Андреевич', faculty: 'ФИТ', course: 3, groupNo: 3, explicitFaculty: true },
  { room: '712Б', last: 'Украинский', first: 'Матвей', middle: 'Леонидович', faculty: 'ФИТ', course: 4, groupNo: 5, explicitFaculty: true },
  // 713
  { room: '713А', last: 'Мартыненко', first: 'Анастасия', middle: 'Дмитриевна', faculty: 'ФИТ', course: 1, groupNo: 6, explicitFaculty: true },
  { room: '713А', last: 'Лукашова', first: 'Екатерина', middle: 'Дмитриевна', faculty: 'ФИТ', course: 1, groupNo: 7, explicitFaculty: true },
  { room: '713А', last: 'Дмитриева', first: 'Дарья', middle: 'Алексеевна', faculty: 'ФИТ', course: 1, groupNo: 2, explicitFaculty: true },
  { room: '713Б', last: 'Лёля', first: 'Анастасия', middle: 'Михайловна', faculty: 'ФИТ', course: 1, groupNo: 8, explicitFaculty: true },
  { room: '713Б', last: 'Смолянинова', first: 'Варвара', middle: 'Михайловна', faculty: 'ФИТ', course: 1, groupNo: 4, explicitFaculty: true },
  // 714
  { room: '714А', last: 'Дударев', first: 'Андрей', middle: 'Дмитриевич', faculty: 'ФИТ', course: 1, groupNo: 7, explicitFaculty: true },
  { room: '714А', last: 'Кохно', first: 'Дмитрий', middle: 'Вячеславович', faculty: 'ФИТ', course: 1, groupNo: 3, explicitFaculty: true },
  { room: '714Б', last: 'Орловский', first: 'Никита', middle: 'Сергеевич', faculty: 'ФИТ', course: 2, groupNo: 4, explicitFaculty: true },
  { room: '714Б', last: 'Яманов', first: 'Владислав', middle: 'Евгеньевич', faculty: 'ФИТ', course: 2, groupNo: 4, explicitFaculty: true },
  // 715
  { room: '715А', last: 'Баран', first: 'Виктория', middle: 'Александровна', faculty: 'ФИТ', course: 2, groupNo: 7, explicitFaculty: true },
  { room: '715А', last: 'Бакаева', first: 'Анастасия', middle: 'Дмитриевна', faculty: 'ФИТ', course: 2, groupNo: 7, explicitFaculty: true },
  { room: '715А', last: 'Барташевич', first: 'Анастасия', middle: 'Андреевна', faculty: 'ФИТ', course: 2, groupNo: 7, explicitFaculty: true },
  { room: '715Б', last: 'Валько', first: 'Юлиана', middle: 'Чеславовна', faculty: 'ФИТ', course: 1, groupNo: 3, explicitFaculty: true },
  { room: '715Б', last: 'Бондарь', first: 'Карина', middle: 'Дмитриевна', faculty: 'ФИТ', course: 1, groupNo: 5, explicitFaculty: true },
  // 716
  { room: '716Б', last: 'Чжэн', first: 'Юйтянь', faculty: 'ХТИТ', course: 2, groupNo: null, explicitFaculty: true, phone: '+375297664175' },
];

function normalizePhone(raw?: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('375') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('80') && digits.length === 11) return `+375${digits.slice(2)}`;
  if (digits.length === 9) return `+375${digits}`;
  return raw.startsWith('+') ? raw : `+${digits}`;
}

const db = createPool(config.databaseUrl);

await withTransaction(db, async (client) => {
  const floor = (
    await client.query<{ id: string; dormitory_id: string }>(
      'SELECT id, dormitory_id FROM floors WHERE number = 7',
    )
  ).rows[0];
  if (!floor) throw new Error('7 этаж не найден');

  const maxSort = (
    await client.query<{ n: number }>(
      'SELECT COALESCE(MAX(sort_order), 0)::int AS n FROM faculties WHERE dormitory_id = $1',
      [floor.dormitory_id],
    )
  ).rows[0]!.n;

  for (const [code, name] of [
    ['ИЭФ', 'Инженерно-экономический факультет'],
    ['ФИТ', 'Факультет информационных технологий'],
    ['ХТИТ', 'Химическая технология и техника'],
  ] as const) {
    await client.query(
      `INSERT INTO faculties (dormitory_id, code, name, sort_order)
       VALUES ($1, $2, $3, $4) ON CONFLICT (dormitory_id, code) DO NOTHING`,
      [floor.dormitory_id, code, name, maxSort + 1],
    );
  }

  const faculties = new Map(
    (await client.query<{ id: string; code: string }>('SELECT id, code FROM faculties')).rows.map(
      (r) => [r.code, r.id],
    ),
  );
  const shift = (await client.query<{ id: string }>('SELECT id FROM study_shifts LIMIT 1')).rows[0]!;

  const roomId = async (number: string): Promise<string> => {
    const row = (
      await client.query<{ id: string }>(
        'SELECT id FROM rooms WHERE floor_id = $1 AND number = $2',
        [floor.id, number],
      )
    ).rows[0];
    if (!row) throw new Error(`Комната ${number} не найдена на 7 этаже`);
    return row.id;
  };

  for (const person of RESIDENTS) {
    const exists = (
      await client.query<{ id: string }>(
        `SELECT id FROM students
          WHERE floor_id = $1 AND last_name = $2 AND first_name = $3 AND status = 'active'`,
        [floor.id, person.last, person.first],
      )
    ).rows[0];
    if (exists) {
      console.log(`= уже есть ${person.last} ${person.first}`);
      continue;
    }

    const rId = await roomId(person.room);
    const facultyId =
      person.explicitFaculty || person.groupNo === null
        ? faculties.get(person.faculty)!
        : faculties.get(facultyForGroup(person.groupNo))!;
    const groupCode = person.groupNo !== null ? String(person.groupNo) : '—';
    const phone = normalizePhone(person.phone);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO students
         (floor_id, room_id, last_name, first_name, middle_name,
          faculty_id, study_shift_id, course, group_code, phone, role, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'resident',0)
       RETURNING id`,
      [
        floor.id,
        rId,
        person.last,
        person.first,
        person.middle ?? null,
        facultyId,
        shift.id,
        person.course,
        groupCode,
        phone,
      ],
    );

    await client.query(
      `INSERT INTO student_placements
         (student_id, floor_id, block_id, room_id,
          room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
       SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, current_date
         FROM rooms r
         JOIN floors fl ON fl.id = r.floor_id
         LEFT JOIN blocks b ON b.id = r.block_id
        WHERE r.id = $2`,
      [rows[0]!.id, rId],
    );
    console.log(`+ ${person.room} ${person.last} ${person.first}`);
  }

  await materializeVersion(client, floor.id, {
    source: 'manual',
    note: 'Бланки комнат 701–716 (7 этаж)',
    force: true,
  });
});

await db.end();
