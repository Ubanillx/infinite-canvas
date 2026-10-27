# Jenkins / SSH / Docker Compose 部署

## 设计与范围

固定 `deploy` 分支 → GitHub Push Webhook → Jenkins 检出并校验远端提交 → 测试 → 构建镜像 → 隔离容器冒烟检查 → SSH/SCP 传输镜像包 → 部署主机 Docker Compose 更新 → 健康检查 → 成功切换 current；失败恢复上一版镜像和运行配置。

不需要镜像仓库，也不会在部署主机拉取 Git 或安装 Node/npm 依赖。部署主机与 Jenkins Docker 构建节点须使用相同 CPU 架构。这里是待真实环境验收的部署配置，不代表 Jenkins、Webhook 或目标主机已经配置成功。

流水线只接受 `deploy` / `origin/deploy`，拒绝 PR，并要求检出 HEAD 等于当前 `origin/deploy`。`dev`、`main` 或旧提交不会进入测试、构建和部署。禁止把不可信 PR 放到持有部署凭据的节点运行。请保护 deploy 分支并限制 Jenkins Job Configure 和凭据权限。

## Jenkins 前置条件

- Linux Agent 标签为 `docker-linux`，装有 Git、Bash、Docker Engine、OpenSSH client、tar、gzip、sha256sum。Docker 开启 BuildKit，构建节点可访问 npm、Docker Hub 和系统包源。
- Jenkins 插件：Pipeline、Git、GitHub、Credentials Binding。该方案不依赖 Timestamper、SSH Publisher、SSH Agent 或 Docker Pipeline 插件。
- 若旧构建提示 `Invalid option type "timestamps"`，说明当前 Jenkins 未提供 Timestamper 选项。仓库已移除该非必需选项；使用最新 deploy 分支重新构建，不要直接回放旧 Jenkinsfile。需要日志时间戳时可由管理员另行安装并配置 Timestamper。
- Docker 权限相当于主机 root 权限，使用专用可信构建节点和部署账号，不向容器挂载宿主机 Docker socket。
- 镜像基础版本在 Dockerfile 的 `NODE_IMAGE` / `BUN_IMAGE` 参数中定义；生产可改用审核后的 digest，更新需要重新验收。

### 凭据（ID 与 Jenkinsfile 保持一致）

| ID | Jenkins 类型 | 内容 |
| --- | --- | --- |
| `infinite-canvas-deploy-ssh` | SSH Username with private key | 专用部署用户名和私钥；此实现使用 BatchMode，需要无交互、无私钥口令的专用 key，私钥由 Jenkins 加密保管 |
| `infinite-canvas-known-hosts` | Secret file | 经独立渠道核验的 SSH known_hosts 文件 |

不要使用其他项目的凭据或复制其主机公钥。先在目标主机控制台读取公钥指纹，再核验扫描结果并存入 known_hosts；`ssh-keyscan` 的输出本身不能证明主机身份。非 22 端口的记录应为 `[host]:port`。每次 SSH 和 SCP 都启用 `StrictHostKeyChecking=yes`、`IdentitiesOnly=yes`；公钥变化即失败，不能改成跳过校验。不要将私钥提交到仓库。

### Job 与分支设置

推荐新建 **Pipeline → Pipeline script from SCM → Git**：

- Repository URL：`https://github.com/Ubanillx/infinite-canvas.git`。
- Branches to build：`*/deploy`，不要配置成 `*/dev` 或 `*/main`。
- 建议设置 refspec：`+refs/heads/deploy:refs/remotes/origin/deploy`。
- Script Path：`Jenkinsfile`。
- Build Triggers：启用 **GitHub hook trigger for GITScm polling**。文件中的 `triggers { githubPush() }` 也会在首次运行后保存该触发器。
- 首次通过可信管理员手动运行以注册 Jenkinsfile 参数，填写 `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_DIR`、`COMPOSE_PROJECT` 后再运行。Jenkinsfile 使用当前 params 作为下一次的参数默认值，首次有效手动运行后请确认 Job 中主机等默认值已保存，再测试 Webhook 无参数触发；首次主机默认为空，不会误部署。

`DEPLOY_HOST` 支持 DNS 名称/IPv4，不支持 IPv6 字面量；`DEPLOY_DIR` 限制为 `/opt/` 的单层子目录（默认 `/opt/infinite-canvas`）；端口默认 22，项目名默认 `infinite-canvas`。更改 Compose 项目名会改变卷名，部署脚本会拒绝已有项目名发生变化。

若使用 Multibranch Pipeline，只发现 `deploy`，禁用 PR/fork 构建，并使用 GitHub Branch Source 对应的 Webhook/索引配置；不要仅靠 Jenkinsfile 中的检查来保护不可信分支。推荐的单分支 Job 无需 Branch Source。

### GitHub Webhook

仓库 Settings → Webhooks → Add webhook：

- Payload URL：`https://你的Jenkins地址/github-webhook/`，保留末尾 `/`；Jenkins 有前缀路径时一并包含。
- Content type：`application/json`。
- 只订阅 **Push events**，勾选 Active，开启 HTTPS 证书校验。
- Jenkins 必须可被 GitHub 访问；不直接暴露管理接口，可在网关仅放行 Webhook 路径。按所安装插件/网关的能力配置和验证 Webhook 签名，不要假设填写 Secret 就已完成验签。

GitHub 插件收到事件后让 Git 插件检查 SCM 是否变化，不是把每次任意分支 Push 都直接部署。因此 `*/deploy` 的 SCM 过滤、Job 触发器和流水线分支校验必须同时存在。测试 Recent Deliveries 的响应，并以 Jenkins 最终 `SUCCESS` 和远端健康状态为准，Webhook 返回 2xx 不等于部署成功。

修改 dev 不会触发该 Job 发布。必须先审核并将应用代码、Jenkinsfile 和 deploy 目录一并合入 deploy，再推送 deploy。远端已存在分叉的 deploy 时，应正常合并并解决冲突，禁止强制覆盖。

## 目标主机初始化（管理员执行一次）

安装 Docker Engine 与 Compose v2（需支持 `up --wait --wait-timeout`）、Bash、GNU coreutils/tar、gzip 和 util-linux（flock）。这里不自动安装或修改防火墙。

数据服务镜像需在部署前加载到主机（部署不访问镜像仓库）：

```bash
docker pull postgres:17-alpine rustfs/rustfs:latest amazon/aws-cli:latest
# 离线环境改为 docker load -i <导出的镜像 tar>
```

以已存在的专用账号 `canvas-deploy` 为例（账号、公钥和权限由管理员配置）：

```bash
sudo install -d -m 700 -o canvas-deploy -g canvas-deploy /opt/infinite-canvas
sudo install -d -m 700 -o canvas-deploy -g canvas-deploy /opt/infinite-canvas/shared
sudo install -m 600 -o canvas-deploy -g canvas-deploy deploy/production.env.example /opt/infinite-canvas/shared/production.env
```

把模板从仓库安全复制到主机后再执行最后一条，编辑其中站点域名、监听地址、端口和允许网段，并替换 `POSTGRES_PASSWORD`、`S3_ACCESS_KEY`、`S3_SECRET_KEY` 的 `CHANGE_ME` 默认值。部署用户须能无交互执行 Docker（加入 docker 组需重新登录，等效 root 权限），并可写部署目录。无需 sudo，也无需目标主机持有 GitHub 或镜像仓库凭据。

数据服务容器监听容器内端口，不经 Compose 发布到宿主机；默认只有 `app` 绑定 `127.0.0.1:3000`。PostgreSQL 与 RustFS 控制台不对公网开放，需要运维访问时使用 SSH 隧道，不要直接添加 `ports` 映射。

创建目录和 SSH 密钥并不等于完成运行配置初始化。若流水线在 SSH deploy 阶段提示 `Initialize readable .../shared/production.env first`，应先在部署主机创建该文件（权限 600、归部署用户所有），而不是重新生成密钥或关闭主机公钥校验。脚本分别报告预检、上传或激活的失败环节，不会输出配置内容。

默认绑定 `127.0.0.1:3000`，由宿主机 Nginx/Caddy 提供 TLS 入口。`INFINITE_CANVAS_ALLOWED_HOSTS` 为精确域名列表，不要设为允许所有主机。若需要局域网直连，可明确修改绑定地址并配合防火墙。默认不开放公网 API；不要为解决连接问题直接改成 `0.0.0.0/0`。

持久化 `production.env` 只放部署运行参数，不放 AI API Key、Agent Token 或 Codex 登录凭据；服务端业务密钥由应用自身写入数据卷。Jenkins artifacts 不包含该文件。

反向代理必须支持 SSE（关闭流式响应缓冲），保持请求 Host，在外部启用 HTTPS。根据上游生成请求配置代理时限，不在本次配置中擅自改动业务请求超时。

## 容器与持久化

- 一个非 root 容器内同时监管 Web（Bun/Vite preview，3000）和 Agent（Node，回环 17371），不公开 Agent 端口。Agent 显式使用自己的 PORT，避免与 Web 端口冲突。
- Web 仍包含原有服务端认证、工作区数据、媒体、只写配置、WebDAV/AI/Agent 代理，不能换成纯 nginx 静态目录。
- 同一 Compose 项目还运行两个有状态服务：`postgres`（账号、工作区数据、媒体索引）与 `rustfs`（S3 兼容对象存储，保存媒体对象），外加一次性的 `rustfs-init` 建桶任务。应用通过 `DATABASE_URL` 与 `S3_*` 连接，浏览器不直连桶。
- Docker healthcheck 验证首页、构建 JS 资源、未登录会话的认证响应（`/api/auth/me` 返回 200、`user` 为空且 `workspaces` 为数组，同时确认 PostgreSQL 可用）和同源 Agent 健康响应；不要求真实 AI Key，不代表供应商生成或 Codex 账号已验收。
- 仅 `app` 的 healthcheck 参与容器健康判定。发布只重建 `app`，数据服务容器保持运行；`compose up --wait` 会等待依赖就绪（含必须成功退出的一次性 `rustfs-init`），但不重建未变化的服务。
- 任一主进程退出会停止另一个并退出容器，由 restart 策略重启；SIGTERM 同时转发到两个进程。仅健康状态变为 unhealthy 但进程未退出时，Docker 的 restart 策略不会自动重启，应另行监控告警。
- 数据卷：`<project>_infinite-canvas-data` → `/data`（服务端配置等）；`<project>_infinite-canvas-agent` → `/home/node/.infinite-canvas`（Agent 配置/会话/工作区）；`<project>_infinite-canvas-codex` → `/home/node/.codex`（Codex 登录/状态）；`<project>_infinite-canvas-postgres` → PostgreSQL 数据目录；`<project>_infinite-canvas-rustfs` / `...-rustfs-logs` → 对象数据与日志。
- 容器用户 UID/GID 为 1000，空命名卷按镜像目录权限初始化。首次 Codex 登录需由管理员在运行容器内执行 `docker compose ... exec app codex login --device-auth`，具体账号/API key 方式按组织规范操作，不把登录凭据打进镜像。
- 旧容器若使用 root 和 `/root/.infinite-canvas`，不能直接假定已有卷可被 UID 1000 读取。先停旧服务并完整备份，在离线副本上校验权限、配置中的绝对工作区路径和 Codex 状态，再制定迁移；本次不自动 chown 或迁移未知卷。
- 更新前备份数据：PostgreSQL 使用 `pg_dump` 逻辑备份（或停服冷备），对象存储备份 bucket；只备份其中一方会导致数据与媒体不一致。禁止 `docker compose down -v` 或 volume prune。
- 部署主机默认不访问镜像仓库（`--pull never`），因此 `postgres:17-alpine`、`rustfs/rustfs:latest` 与 `amazon/aws-cli:latest` 必须预先 `docker pull` 或离线导入；脚本在部署前逐个检查并给出明确提示。

首次部署遇到同名但不受 current 管理的已有容器会拒绝接管，防止误覆盖旧部署。Compose 项目名、数据卷身份和部署目录应长期稳定。

## 版本、验证和回滚

目录：`incoming/<SHA>-<BUILD>/` 为传输包，`releases/<SHA>-<BUILD>/` 为 Compose/镜像元数据，`current` 为最后一个健康版本的原子软链接，`shared/production.env` 为下一次部署输入。

镜像标签为 `infinite-canvas:<完整Git SHA>-<BUILD_NUMBER>`，不使用 latest。传输在严格校验的 SSH 通道内完成，远端还核对 SHA256SUMS、加载后的 Docker image ID、OCI revision 标签与实际运行容器 image ID。每个版本复制自己的 runtime.env，回滚恢复原版本运行参数；当前 shared 文件留给后续更新。

默认部署与回滚各使用 `--wait-timeout 120`（已确认）；构建后的隔离容器冒烟检查也最多等待 120 秒。不做无条件重试。容器健康探针不另设自定义阈值，沿用 Docker 默认的 30 秒检查间隔、30 秒检查超时和 3 次失败阈值；只影响容器健康状态，不改变 AI 业务超时。

更新前不执行 down。成功后才更新 current，并移除已加载的传输镜像包；保留历史 Compose、运行配置和 Docker 镜像供回滚，脚本不自动清理旧镜像/卷。管理员应按备份和回滚策略维护磁盘，不要全局 prune。

失败时自动用旧版本 `up`，即使恢复成功 Jenkins 仍判本次发布失败；回滚也失败时明确报告 `ROLLBACK FAILED`。首次部署失败没有旧版可恢复，保留容器与传输文件供调查。镜像/配置回滚只回滚 `app`，不回滚 PostgreSQL、对象存储、业务密钥、媒体或 Agent/Codex 数据；数据库结构与对象存储内容不会随版本回退，出现不兼容数据变更时必须先备份并准备人工恢复，不能只依赖镜像回滚。

人工回滚（先确认目标版本和无其他部署进行；后续 Jenkins 部署仍须遵循同一发布流程）：

```bash
(
set -Eeuo pipefail
cd /opt/infinite-canvas
exec 9>.deploy.lock
flock -n 9
# 替换为 releases 中一个已经验证过的 SHA-BUILD 版本 ID
release_id=替换成目标版本ID
[[ "$release_id" =~ ^[a-f0-9]{40}-[0-9]+$ ]]
release_dir="/opt/infinite-canvas/releases/$release_id"
APP_IMAGE="$(cat "$release_dir/image-ref")" docker compose -p infinite-canvas --env-file "$release_dir/runtime.env" --env-file "$release_dir/image.env" -f "$release_dir/compose.yml" up -d --no-build --pull never --wait --wait-timeout 120
container="$(APP_IMAGE="$(cat "$release_dir/image-ref")" docker compose -p infinite-canvas --env-file "$release_dir/runtime.env" --env-file "$release_dir/image.env" -f "$release_dir/compose.yml" ps -q app)"
test "$(docker inspect --format '{{.Image}}' "$container")" = "$(cat "$release_dir/image-id")"
ln -s "releases/$release_id" ".manual-$release_id"
mv -Tf ".manual-$release_id" current
)
```

手工恢复后的 current 必须与实际部署一致，否则下次自动回滚的目标可能错误；不要在发布过程中并发操作。部署脚本使用远端 flock，Jenkins 同一 Job 也禁用并发。

## 针对性测试与待验收

CI 的 test 阶段运行部署脚本模拟测试、健康探针测试、Web 回归测试和 Agent 测试。模拟测试不挂载 Docker socket，覆盖传输包校验、首次失败、更新回滚、回滚失败、镜像不匹配、并发锁、项目名限制、SSH 严格校验、参数注入拒绝、子进程退出和 SIGTERM。

冒烟阶段使用 `docker-compose.smoke.yml` 启动一套与生产项目同构的隔离栈（`app` + `postgres` + `rustfs` + `rustfs-init`，项目名 `infinite-canvas-smoke`），等待健康后由 `post` 无条件 `down -v` 清理，不发布端口、不影响宿主机已有中间件。

本地不执行应用构建/类型检查（遵循仓库约定），构建留给流水线。真实镜像构建、Jenkins 语法/插件兼容性、Webhook 投递、SSH 登录、卷初始化、Codex 实际登录以及生产回滚仍需真实环境验收。

参考：[Jenkins credentials binding](https://www.jenkins.io/doc/pipeline/steps/credentials-binding/)、[GitHub plugin](https://plugins.jenkins.io/github/)、[Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)。
