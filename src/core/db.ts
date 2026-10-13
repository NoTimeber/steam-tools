// SQLite(Node 内置 node:sqlite,无原生依赖)。WAL 模式;迁移按版本号顺序执行一次。

import {DatabaseSync} from 'node:sqlite';
import type {SQLInputValue} from 'node:sqlite';
import {chmodSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export type Db = DatabaseSync;
export type SqlParam = SQLInputValue;

export interface Migration {
	version: number;
	name: string;
	sql: string;
}

export function openDatabase(file: string): Db {
	if (file !== ':memory:') {
		mkdirSync(dirname(file), {recursive: true});
	}
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = 5000;
	`);
	if (file !== ':memory:') {
		try {
			chmodSync(file, 0o600);
		} catch {
			// Windows 忽略
		}
	}
	return db;
}

// 支持嵌套:最外层用 BEGIN IMMEDIATE,内层用 SAVEPOINT。
const depthByDb = new WeakMap<Db, number>();

export function transaction<T>(db: Db, fn: () => T): T {
	const depth = depthByDb.get(db) ?? 0;
	const savepoint = `sp_${depth}`;
	db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
	depthByDb.set(db, depth + 1);
	try {
		const result = fn();
		db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
		return result;
	} catch (err) {
		db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
		throw err;
	} finally {
		depthByDb.set(db, depth);
	}
}

export function migrate(db: Db, migrations: readonly Migration[]): number[] {
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		applied_at TEXT NOT NULL
	)`);
	const applied = new Set(
		db.prepare('SELECT version FROM schema_migrations').all().map(row => Number(row.version))
	);
	const newlyApplied: number[] = [];
	for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
		if (applied.has(migration.version)) {
			continue;
		}
		transaction(db, () => {
			db.exec(migration.sql);
			db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
				.run(migration.version, migration.name, new Date().toISOString());
		});
		newlyApplied.push(migration.version);
	}
	return newlyApplied;
}

// node:sqlite 的行是 Record<string, SQLOutputValue>;这几个小工具把取值收窄成需要的类型。
export type Row = Record<string, unknown>;

export function str(row: Row, column: string): string {
	const value = row[column];
	return value == null ? '' : String(value);
}

export function strOrNull(row: Row, column: string): string | null {
	const value = row[column];
	return value == null ? null : String(value);
}

export function num(row: Row, column: string): number | null {
	const value = row[column];
	if (value == null) {
		return null;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

export function bool(row: Row, column: string): boolean {
	return Number(row[column]) === 1;
}

export function nowIso(): string {
	return new Date().toISOString();
}
