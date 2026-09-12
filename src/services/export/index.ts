import type pg from 'pg';
import type { FloorRoster } from '../../domain/floorRoster.js';
import { FloorRosterQueryService } from '../query/FloorRosterQueryService.js';
import { RosterSnapshotQueryService } from '../query/RosterSnapshotQueryService.js';
import { renderRosterHtml } from './htmlRenderer.js';
import { renderRosterPdf } from './pdfRenderer.js';
import { renderRosterXlsx } from './xlsxRenderer.js';
import { renderRosterContactsXlsx } from './contactsXlsx.js';
import { type RosterDocumentOptions, buildRosterDocument } from './rosterDocument.js';

export { buildRosterDocument, type RosterDocument } from './rosterDocument.js';
export { renderRosterHtml, formatRuDate } from './htmlRenderer.js';
export { renderRosterXlsx } from './xlsxRenderer.js';
export { renderRosterContactsXlsx } from './contactsXlsx.js';
export { renderRosterPdf, findBrowser, PdfUnavailableError } from './pdfRenderer.js';

/**
 * Единая точка выдачи списка этажа во всех форматах.
 *
 *   FloorRosterQueryService / RosterSnapshotQueryService
 *              ↓  FloorRoster (DTO)
 *        buildRosterDocument
 *              ↓  RosterDocument
 *      ├── HTML (веб и печать)
 *      ├── PDF
 *      └── XLSX
 *
 * Три формата берут данные из одного объекта. Отдельных SQL-запросов
 * «для PDF» и «для веба» не существует.
 */
export class RosterExportService {
  private readonly current: FloorRosterQueryService;
  private readonly snapshot: RosterSnapshotQueryService;

  constructor(db: pg.Pool | pg.PoolClient) {
    this.current = new FloorRosterQueryService(db);
    this.snapshot = new RosterSnapshotQueryService(db);
  }

  /** Текущий состав этажа. Живые атрибуты, одно согласованное состояние. */
  loadCurrent(floorId: string): Promise<FloorRoster> {
    return this.current.getCurrent(floorId);
  }

  /** Исторический состав. Только снимки, без обращения к текущим данным. */
  loadSnapshot(rosterVersionId: string): Promise<FloorRoster> {
    return this.snapshot.getVersion(rosterVersionId);
  }

  async html(roster: FloorRoster, options?: RosterDocumentOptions): Promise<string> {
    return renderRosterHtml(buildRosterDocument(roster, options));
  }

  async xlsx(roster: FloorRoster, options?: RosterDocumentOptions): Promise<Buffer> {
    return renderRosterXlsx(buildRosterDocument(roster, options));
  }

  /** Таблица с телефоном и Telegram ID — одна строка на студента. */
  async xlsxContacts(roster: FloorRoster): Promise<Buffer> {
    return renderRosterContactsXlsx(roster);
  }

  async pdf(roster: FloorRoster, options?: RosterDocumentOptions): Promise<Buffer> {
    return renderRosterPdf(buildRosterDocument(roster, options));
  }

  /** Все три формата из одного документа — используется тестами и выгрузкой. */
  async all(
    roster: FloorRoster,
    options?: RosterDocumentOptions,
  ): Promise<{ html: string; xlsx: Buffer; pdf: Buffer | null; fileBaseName: string }> {
    const doc = buildRosterDocument(roster, options);
    let pdf: Buffer | null = null;
    if (await findBrowserSafe()) {
      try {
        pdf = await renderRosterPdf(doc);
      } catch {
        // PDF не обязателен при пакетной выгрузке.
      }
    }
    return {
      html: renderRosterHtml(doc),
      xlsx: await renderRosterXlsx(doc),
      pdf,
      fileBaseName: doc.fileBaseName,
    };
  }
}

async function findBrowserSafe(): Promise<boolean> {
  const { findBrowser } = await import('./pdfRenderer.js');
  return (await findBrowser()) !== null;
}
