import { execFileSync } from "node:child_process";

/**
 * E2E 隔离：每次运行使用独立的 PostgreSQL database 和 RustFS bucket，
 * 复用本地中间件容器，不依赖已存在的测试数据，也不污染开发数据。
 * 用法：node scripts/e2e-middleware.mjs up|down <runId>
 */
const container = process.env.E2E_MIDDLEWARE_CONTAINER || "infinite-canvas-middleware-postgres-1";
const databaseUrl = process.env.E2E_DATABASE_URL || "postgres://infinite:infinite_canvas_dev@127.0.0.1:5433/infinite_canvas";
// AWS CLI 跑在容器里，必须走中间件网络的服务名，不能请求宿主机回环地址。
const s3ContainerEndpoint = process.env.E2E_S3_CONTAINER_ENDPOINT || "http://rustfs:9000";
const middlewareNetwork = process.env.E2E_MIDDLEWARE_NETWORK || "infinite-canvas-middleware";
const accessKey = process.env.E2E_S3_ACCESS_KEY || "infinite";
const secretKey = process.env.E2E_S3_SECRET_KEY || "infinite_canvas_dev";
const awsCliImage = "amazon/aws-cli:latest";

function docker(args) {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function safeName(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
}

function aws(args) {
    return docker([
        "run", "--rm", "--network", middlewareNetwork,
        "-e", `AWS_ACCESS_KEY_ID=${accessKey}`,
        "-e", `AWS_SECRET_ACCESS_KEY=${secretKey}`,
        "-e", "AWS_DEFAULT_REGION=us-east-1",
        awsCliImage,
        ...args,
        "--endpoint-url", s3ContainerEndpoint,
    ]);
}

const [command, rawRunId] = process.argv.slice(2);
const runId = safeName(rawRunId || "");
if (!["up", "down", "prune"].includes(command) || (command !== "prune" && !runId)) {
    console.error("Usage: node scripts/e2e-middleware.mjs up|down <runId> | prune");
    process.exit(2);
}
// 中断的运行（例如 Ctrl+C 或超时）可能留下 database/bucket，prune 用于一次性清理。
if (command === "prune") {
    const rows = docker(["exec", container, "psql", "-U", "infinite", "-d", "postgres", "-t", "-A", "-c",
        "SELECT datname FROM pg_database WHERE datname LIKE 'infinite_canvas_e2e%'"]).split(/\r?\n/).filter(Boolean);
    for (const name of rows) docker(["exec", container, "psql", "-U", "infinite", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
    const buckets = aws(["s3api", "list-buckets"]).match(/infinite-canvas-e2e-[a-z0-9-]+/g) || [];
    for (const name of new Set(buckets)) {
        try {
            const listed = aws(["s3", "ls", `s3://${name}`, "--recursive"]);
            for (const line of listed.split(/\r?\n/).filter(Boolean)) {
                const key = line.trim().split(/\s+/).slice(3).join(" ");
                if (key) aws(["s3", "rm", `s3://${name}/${key}`]);
            }
            aws(["s3api", "delete-bucket", "--bucket", name]);
        } catch {
            // 忽略已清理或不可访问的桶。
        }
    }
    console.log(JSON.stringify({ pruned: { databases: rows, buckets: [...new Set(buckets)] } }));
    process.exit(0);
}
const database = `infinite_canvas_e2e_${runId}`;
const bucket = `infinite-canvas-e2e-${runId.replace(/_/g, "-")}`;

if (command === "up") {
    docker(["exec", container, "psql", "-U", "infinite", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`]);
    docker(["exec", container, "psql", "-U", "infinite", "-d", "postgres", "-c", `CREATE DATABASE "${database}"`]);
    try {
        aws(["s3api", "head-bucket", "--bucket", bucket]);
    } catch {
        aws(["s3api", "create-bucket", "--bucket", bucket]);
    }
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    console.log(JSON.stringify({ database, bucket, databaseUrl: url.toString() }));
} else {
    docker(["exec", container, "psql", "-U", "infinite", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`]);
    // 删桶前清空对象；桶内为空才允许删除。
    try {
        const listed = aws(["s3", "ls", `s3://${bucket}`, "--recursive"]);
        for (const line of listed.split(/\r?\n/).filter(Boolean)) {
            const key = line.trim().split(/\s+/).slice(3).join(" ");
            if (key) aws(["s3", "rm", `s3://${bucket}/${key}`]);
        }
        aws(["s3api", "delete-bucket", "--bucket", bucket]);
    } catch {
        // 桶不存在或已被清理，忽略。
    }
    console.log(JSON.stringify({ cleaned: { database, bucket } }));
}
