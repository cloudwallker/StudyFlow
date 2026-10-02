import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function backupDatabase(db: DatabaseSync, path: string, backup: boolean, version: number): void {
  if (backup && path !== ':memory:') {
    const destination = `${path}.${randomUUID()}.v${version}.sqlite`;
    // SQLite creates a consistent image including committed WAL contents.
    db.prepare('VACUUM INTO ?').run(destination);
    const handle = openSync(destination, 'r+');
    try { fsyncSync(handle); } finally { closeSync(handle); }
    const digest = createHash('sha256').update(readFileSync(destination)).digest('hex');
    writeFileSync(destination + '.sha256', digest + '\n', { flag: 'wx', flush: true });
    if (createHash('sha256').update(readFileSync(destination)).digest('hex') !== readFileSync(destination + '.sha256', 'utf8').trim()) throw new Error('升级备份校验失败');
    const check = new DatabaseSync(destination, { readOnly: true });
    try {
      if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || check.prepare('PRAGMA user_version').get()?.user_version !== version) throw new Error('升级备份无效');
    } finally { check.close(); }
  }
}

export function migrateV2(db: DatabaseSync, path: string, backup: boolean): void {
  backupDatabase(db, path, backup, 1);
  transaction(db, () => db.exec(`
    ALTER TABLE settings ADD COLUMN recordAppActivity INTEGER NOT NULL DEFAULT 0 CHECK(recordAppActivity IN (0,1));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, taskId TEXT REFERENCES tasks(id), mode TEXT NOT NULL,
      status TEXT NOT NULL, startedAt REAL NOT NULL, confirmedAt REAL NOT NULL,
      revision INTEGER NOT NULL, digest TEXT NOT NULL, creditedMs INTEGER NOT NULL CHECK(creditedMs>=0), state TEXT NOT NULL);
    CREATE TABLE timer_slices (sessionId TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, date TEXT NOT NULL,
      startedAt REAL NOT NULL, endedAt REAL, durationMs REAL NOT NULL CHECK(durationMs>0), effectiveMs REAL NOT NULL,
      afkMs REAL NOT NULL, unknownMs REAL NOT NULL, data TEXT NOT NULL, PRIMARY KEY(sessionId,id,date));
    CREATE INDEX slices_date ON timer_slices(date);
    CREATE TABLE activity_intervals (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), date TEXT NOT NULL,
      startedAt REAL NOT NULL, endedAt REAL NOT NULL, state TEXT NOT NULL, app TEXT);
    CREATE INDEX activity_date ON activity_intervals(date);
    CREATE TABLE daily_reviews (date TEXT PRIMARY KEY, notes TEXT NOT NULL);
    PRAGMA user_version=2;
  `));
}

export function migrateV3(db: DatabaseSync, path: string, backup: boolean): void {
  backupDatabase(db, path, backup, 2);
  transaction(db, () => db.exec(`
    UPDATE timer_slices AS earlier SET data=json_set(data,'$.reason','tick')
      WHERE json_extract(data,'$.reason')='phase-end' AND EXISTS
      (SELECT 1 FROM timer_slices AS later WHERE later.sessionId=earlier.sessionId AND later.id=earlier.id AND later.startedAt>earlier.startedAt);
    CREATE TABLE daily_plans(date TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE app_categories(app TEXT PRIMARY KEY, category TEXT NOT NULL); PRAGMA user_version=3;`));
}

export function migrateV4(db: DatabaseSync, path: string, backup: boolean): void {
  backupDatabase(db, path, backup, 3);
  transaction(db, () => db.exec(`
    ALTER TABLE settings ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE activity_intervals ADD COLUMN monotonicStart REAL;
    CREATE INDEX slices_monotonic ON timer_slices(sessionId,json_extract(data,'$.monotonicStartMs'));
    CREATE INDEX activity_monotonic ON activity_intervals(sessionId,monotonicStart);
    CREATE TABLE ambient_activity(runId TEXT NOT NULL, startMono REAL NOT NULL, endMono REAL NOT NULL,
      date TEXT NOT NULL, startedAt REAL NOT NULL, endedAt REAL NOT NULL, state TEXT NOT NULL, app TEXT,
      PRIMARY KEY(runId,startMono,date));
    CREATE INDEX ambient_date ON ambient_activity(date);
    PRAGMA user_version=4;
  `));
}

export function migrateV5(db: DatabaseSync, path: string, backup: boolean): void {
  backupDatabase(db, path, backup, 4);
  transaction(db, () => db.exec(`
    CREATE TABLE import_batches(digest TEXT PRIMARY KEY, importedAt INTEGER NOT NULL);
    CREATE TABLE imported_tasks(taskKey TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
      digest TEXT NOT NULL REFERENCES import_batches(digest));
    PRAGMA user_version=5;
  `));
}

export function migrateV6(db: DatabaseSync, path: string, backup: boolean): void {
  backupDatabase(db, path, backup, 5);
  transaction(db, () => db.exec(`
    CREATE TABLE task_details(taskId TEXT PRIMARY KEY REFERENCES tasks(id), tags TEXT NOT NULL DEFAULT '[]',
      dependencies TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)));
    INSERT INTO task_details(taskId,position) SELECT id,-rowid FROM tasks;
    CREATE TABLE project_order(projectId TEXT PRIMARY KEY REFERENCES projects(id), position INTEGER NOT NULL);
    INSERT INTO project_order SELECT id,rowid FROM projects;
    CREATE TABLE daily_checkins(date TEXT NOT NULL, taskId TEXT NOT NULL REFERENCES tasks(id), checkedAt INTEGER,
      PRIMARY KEY(date,taskId));
    INSERT INTO daily_checkins(date,taskId,checkedAt)
      SELECT p.date,json_extract(e.value,'$.taskId'),NULL FROM daily_plans p,json_each(p.data,'$.entries') e
      JOIN tasks t ON t.id=json_extract(e.value,'$.taskId') WHERE t.done=1;
    PRAGMA user_version=6;
  `));
}

export function migrateV7(db: DatabaseSync, path: string, backup: boolean): void {
  backupDatabase(db, path, backup, 6);
  transaction(db, () => db.exec(`
    CREATE TABLE daily_plan_reminders(date TEXT PRIMARY KEY, token TEXT UNIQUE,
      state TEXT NOT NULL CHECK(state IN('notified','snoozed','dismissed','deferred')),
      attemptedAt INTEGER NOT NULL, nextAt INTEGER,
      CHECK((state IN('snoozed','deferred') AND nextAt IS NOT NULL) OR (state NOT IN('snoozed','deferred') AND nextAt IS NULL)));
    PRAGMA user_version=7;
  `));
}
