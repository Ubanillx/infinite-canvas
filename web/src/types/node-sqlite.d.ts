declare module "node:sqlite" {
    export class DatabaseSync {
        constructor(location: string);
        exec(sql: string): unknown;
        prepare(sql: string): {
            all: (...params: unknown[]) => unknown[];
            get: (...params: unknown[]) => unknown;
            run: (...params: unknown[]) => {
                changes?: number | bigint;
                lastInsertRowid?: number | bigint;
            };
        };
    }
}
