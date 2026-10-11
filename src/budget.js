import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CAP = 200_000_000;
export const HOLD = 34_000_000;
// USD per million tokens, conservatively using the highest Global Standard
// input/cache-write and output rates, plus a 25% safety margin.
export function upperCost(usage) {
  const input = usage?.prompt_tokens;
  const output = usage?.completion_tokens;
  if (!Number.isSafeInteger(input) || input < 0 || input > 1_050_000 ||
      !Number.isSafeInteger(output) || output < 0 || output > 4096) return null;
  return Math.ceil((input * 25 + output * 75) * 1.25);
}
export class Budget {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL CHECK(used>=0 AND used<=200000000));
      INSERT OR IGNORE INTO account VALUES (1,0);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, reserved INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);`);
    // Explicitly authorized cap increase. Preserve every charge and reservation.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='account'").get().sql;
      if (/used\s*<=\s*100000000/.test(schema)) {
        this.db.exec(`CREATE TABLE account_v200 (id INTEGER PRIMARY KEY CHECK(id=1), used INTEGER NOT NULL CHECK(used>=0 AND used<=200000000));
          INSERT INTO account_v200 SELECT id,used FROM account;
          DROP TABLE account;
          ALTER TABLE account_v200 RENAME TO account;`);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reserve(runId, now = new Date()) {
    if (now > new Date('2026-10-12T00:00:00Z')) throw new Error('API stopped: hackathon cutoff reached.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare('UPDATE account SET used=used+? WHERE id=1 AND used+?<=?').run(HOLD,HOLD,CAP).changes;
      if (!changed) throw new Error('API budget stopped: insufficient unreserved funds.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO requests (id,run_id,reserved,created) VALUES (?,?,?,?)').run(id,runId,HOLD,now.toISOString());
      this.db.exec('COMMIT');
      return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settle(id, usage) {
    const cost = upperCost(usage);
    // An ambiguous result, missing usage, or timeout never releases a reservation.
    if (cost === null || cost > HOLD) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
      if (!row || row.settled) throw new Error('Unknown or already settled reservation.');
      this.db.prepare('UPDATE account SET used=used-? WHERE id=1').run(row.reserved-cost);
      this.db.prepare('UPDATE requests SET reserved=?, settled=1 WHERE id=?').run(cost,id);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  status() { const rows=this.db.prepare('SELECT settled, COALESCE(SUM(reserved),0) AS amount FROM requests GROUP BY settled').all(); return { capUsd:CAP/1e6, chargedAndReservedUsd:this.db.prepare('SELECT used FROM account WHERE id=1').get().used/1e6, conservativeChargedUsd:(rows.find(x=>x.settled===1)?.amount||0)/1e6, unresolvedReservedUsd:(rows.find(x=>x.settled===0)?.amount||0)/1e6, reservationPerRequestUsd:HOLD/1e6 }; }
  close() { this.db.close(); }
}
