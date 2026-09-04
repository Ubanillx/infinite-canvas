declare module "bun:sqlite" {
    export class Database {
        constructor(filename: string);
        run(sql: string): unknown;
        query(sql: string): {
            all(...params: unknown[]): unknown[];
            get(...params: unknown[]): unknown;
            run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
        };
        transaction<T extends (...args: any[]) => any>(callback: T): T;
    }
}
