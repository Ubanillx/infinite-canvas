# Jenkins / SSH / Docker Compose 部署

## 设计与范围

固定 `deploy` 分支 → GitHub Push Webhook → Jenkins 检出并校验远端提交 → 构建镜像 → SSH 上的 rsync 差量传输镜像、SCP 传输发布元数据 → 部署主机 Docker Compose 更新 → 健康检查 → 成功切换 current；失败恢复上一版镜像和运行配置。

不需要镜像仓库，也不会在部署主机拉取 Git 或安装 Node/npm 依赖。部署主机与 Jenkins Docker 构建节点须使用相同 CPU 架构。这里是待真实环境验收的部署配置，不代表 Jenkins、Webhook 或目标主机已经配置成功。

流水线只接受 `deploy` / `origin/deploy`，拒绝 PR，并要求检出 HEAD 等于当前 `origin/deploy`。`dev`、`main` 或旧提交不会进入构建和部署。禁止把不可信 PR 放到持有部署凭据的节点运行。请保护 deploy 分支并限制 Jenkins Job Configure 和凭据权限。

## Jenkins 前置条件

- Linux Agent 标签为 `docker-linux`，装有 Git、Bash、Docker Engine、Docker Buildx CLI 插件、OpenSSH client、rsync、tar、gzip、sha256sum。Docker 支持 BuildKit，执行流水线的同一用户运行 `docker buildx version` 和 `docker info` 均应成功；构建节点可访问 npm、PyPI、Docker Hub 和系统包源。
- Jenkins 插件：Pipeline、Git、GitHub、Credentials Binding。该方案不依赖 Timestamper、SSH Publisher、SSH Agent 或 Docker Pipeline 插件。
- 若旧构建提示 `Invalid option type "timestamps"`，说明当前 Jenkins 未提供 Timestamper 选项。仓库已移除该非必需选项；使用最新 deploy 分支重新构建，不要直接回放旧 Jenkinsfile。需要日志时间戳时可由管理员另行安装并配置 Timestamper。
- Docker 权限相当于主机 root 权限，使用专用可信构建节点和部署账号，不向容器挂载宿主机 Docker socket。
- 镜像基础版本在 Dockerfile 的 `NODE_IMAGE` / `BUN_IMAGE` 参数中定义；生产可改用审核后的 digest，更新需要重新验收。

### Buildx 缺失或损坏

`BuildKit is enabled but the buildx component is missing or broken` 表示运行 Docker CLI 的 **Jenkins 构建节点**没有可用的 Buildx CLI 插件，不是 Jenkins 插件，也不是应用容器里的程序。流水线先运行 `docker buildx version`，失败时保留原始错误并给出安装位置提示，停止后续构建、打包及部署；不会在发布任务里自动安装软件、替换 Docker 或关闭 BuildKit。当前 Dockerfile 的 `RUN --mount=type=cache` 依赖 BuildKit，不能用 `DOCKER_BUILDKIT=0` 绕过。

先在执行 `Build image` 的同一节点、同一用户及容器环境检查：

```bash
id -un
command -v docker
docker buildx version
docker info
```

如果构建节点是 Ubuntu/Debian，且 Docker 来自官方 APT 仓库，由管理员在该环境安装独立插件即可，不需要重装 Engine 或重启应用：

```bash
sudo apt-get update
sudo apt-get install -y docker-buildx-plugin
```

- 提示找不到包时，先用 `apt-cache policy docker-ce-cli docker.io docker-buildx-plugin docker-buildx` 确认现有来源及候选版本，按原 Docker 安装渠道选择匹配的 Buildx 包。不要为了安装插件直接卸载 Docker、切换软件源或整套升级 Engine；官方包的仓库配置见下方链接。
- 如果 Jenkins Agent 本身运行在容器里，插件需要安装在 **执行 Docker CLI 的 Agent 容器镜像**内。只在 Docker daemon 所在宿主机或部署主机安装无效，挂载 Docker socket 也不会提供 CLI 插件；应由管理员更新自定义 Agent 镜像，不修改本项目的应用 Dockerfile。容器内没有 sudo 时由管理员以 root 安装，临时安装只用于验证，重建容器会丢失。
- 若插件装在某个管理员的 `~/.docker/cli-plugins`，Jenkins 用户未必能看到；自定义 `DOCKER_CONFIG` 也可能改变用户插件搜索目录。包已安装仍失败时，查看 `docker info` 中的插件警告，检查用户目录是否有优先加载的损坏插件、可执行权限以及二进制 CPU 架构。不要在脚本中自动删除或覆盖这些文件；优先使用发行渠道的软件包与系统级插件目录，而不是临时下载未审核的二进制。

安装后，必须再次以实际 Jenkins 用户、在实际构建环境运行 `docker buildx version`，确认输出版本后再重跑最新 `deploy` 的流水线。管理员用户下成功不能代替该验证。该处理不更改 Docker 登录配置、SSH 凭据、应用鉴权、数据卷或回滚流程。

参考：[Buildx 官方安装说明](https://github.com/docker/buildx#installing)、[Docker Ubuntu APT 安装说明](https://docs.docker.com/engine/install/ubuntu/)、[Docker BuildKit / Buildx 缺失报错说明](https://docs.docker.com/engine/deprecated/#legacy-builder-for-linux-images)。

### 构建缓存

Jenkins 显式启用 BuildKit，复用同一 Docker 构建节点上的层缓存和下载缓存，不需要新增镜像仓库或部署凭据：

- 前端与 Agent 各有独立的依赖层和编译层，依赖安装仅依赖各自的 `package.json` / `package-lock.json`。修改源码不重装依赖；只修改一端不会因共用构建链而重编译另一端。前端使用根目录的 `VERSION` / `CHANGELOG.md`，这些文件变化仍会正常触发前端编译。
- npm 通过 BuildKit 挂载缓存下载包，继续执行 `npm ci` 并校验锁文件，不共享或复用宿主机的 `node_modules`。Python 依赖按固定版本清单安装，pip 下载缓存不再被禁用；清单变化时可复用未变化的包。
- 系统软件包与索引使用带锁的 APT 缓存，关闭镜像内自动删除下载包的配置。Office、OCR、Python 等运行环境独立于应用源码，未变化时直接复用完整安装层；APT/npm/pip 下载缓存不打进最终运行镜像。
- `.local` 调试产物与本地数据不再进入构建上下文。Jenkins 分别显示 `Build image`、`Package release` 和 `SSH deploy`，构建日志中的 `CACHED` 表示层缓存命中。构建缓存与下节的传输缓存相互独立，不省略本地镜像导出或远端加载。

首次使用新结构仍需完整下载和安装。后续构建须复用同一 Docker builder 及其数据目录；清理 Jenkins 工作区不会清理该缓存，但切换构建主机、使用临时 Docker daemon、手动 prune 或 Docker 自动回收均可能使缓存失效，届时正常重新下载。若 `docker-linux` 标签对应多台主机，各自维护本地缓存，本方案不跨节点同步缓存，也不调整缓存保留期限或磁盘限额。不要在每次发布后执行 `docker builder prune` / `docker system prune`。

验收时对比首次构建、无源码变化的再次构建、单端源码修改、单端锁文件修改和 Python 清单修改的日志；预期只重跑受影响的步骤，不应恢复已取消的测试或冒烟阶段。镜像复制清单、非 root 运行用户、SSH 校验、回滚和数据卷保持不变。

参考：[Docker 构建缓存优化](https://docs.docker.com/build/cache/optimize/)。

### 镜像打包与差量传输

Jenkins 保留未压缩的 `.ci/image.tar`，不再先 gzip 完整镜像、再把它放入第二层压缩包。`.ci/release.tar.gz` 只包含 Compose、部署脚本、镜像标识、版本和 SHA256SUMS；校验清单仍包含独立传输的完整 `image.tar`。

应用镜像通过 rsync 的数据块匹配复用部署主机 `shared/image-transfer/image.tar`，只压缩和发送缺失的数据块；不是自制 Docker 层协议，也不需要 rsync daemon、镜像仓库、新端口或额外凭据。rsync 复用同一脚本内的 SSH 参数，继续校验私钥、known_hosts、主机公钥和端口。双方均需安装带安全更新的 rsync，Ubuntu/Debian 可由管理员执行 `sudo apt-get update && sudo apt-get install -y rsync`；缺少时预检明确失败，不在发布中自动安装或降低鉴权。

- 首次发布、传输基线缺失或镜像整体变化时，可能仍传完整镜像；后续未变化的系统、依赖和应用内容可按块复用。日志 `Literal data` 是新传数据量，`Matched data` 是复用数据量，并非保证某个固定提速比例。
- rsync 用 `--copy-dest` 只读比对旧基线，在本次 `incoming/<SHA>-<BUILD>/` 内生成新归档，不使用 `--inplace`、硬链接或删除同步。启用内容校验，接收后仍执行原 SHA256、image ID、revision 和容器健康校验；传输失败不会进入发布激活，不自动重试或自动降级成其他传输方式。
- 只有健康发布完成后，才将新归档先移入缓存临时文件，再在缓存目录内原子替换基线。失败发布保留原基线和 current；缓存替换失败仅告警，不回滚已健康的新版本。旧 Docker 镜像与发布配置继续保留，回滚不依赖传输缓存。
- 代价是 Jenkins 打包时需要保存完整未压缩归档，部署主机稳态额外保留一份未压缩归档，更新期间还需容纳新归档。缓存为私有目录、归档权限 600，不属于业务数据卷，不自动调整磁盘限额或回收策略；更新失败遗留文件由管理员确认后处理。删除传输缓存不会删除聊天/画布，但会使下一次传输变为全量。

基础服务镜像仍仅在远端缺失时按原方式导出、压缩和传输。本地 `docker save` 与远端 `docker load` 仍处理完整归档，主要优化重复压缩和网络传输；真实耗时与传输量应在连续 Jenkins 发布中确认。

参考：[rsync 官方手册](https://github.com/rsyncproject/rsync/blob/master/rsync.1.md)。

### 凭据（ID 与 Jenkinsfile 保持一致）

| ID | Jenkins 类型 | 内容 |
| --- | --- | --- |
| `infinite-canvas-deploy-ssh` | SSH Username with private key | 专用部署用户名和私钥；此实现使用 BatchMode，需要无交互、无私钥口令的专用 key，私钥由 Jenkins 加密保管 |
| `infinite-canvas-known-hosts` | Secret file | 经独立渠道核验的 SSH known_hosts 文件 |

不要使用其他项目的凭据或复制其主机公钥。先在目标主机控制台读取公钥指纹，再核验扫描结果并存入 known_hosts；`ssh-keyscan` 的输出本身不能证明主机身份。非 22 端口的记录应为 `[host]:port`。每次 SSH、SCP 和 rsync 的 SSH 连接都启用 `StrictHostKeyChecking=yes`、`IdentitiesOnly=yes`；公钥变化即失败，不能改成跳过校验。不要将私钥提交到仓库。

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

安装 Docker Engine 与 Compose v2（需支持 `up --wait --wait-timeout`）、Bash、rsync、GNU coreutils/tar、gzip 和 util-linux（flock）。这里不自动安装或修改防火墙。

数据服务镜像由发布流水线在部署主机缺失时从 Jenkins 构建节点导出并通过 SSH 传输加载（部署主机不访问镜像仓库）；也可提前预加载以缩短首次发布：

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

反向代理必须支持 SSE（关闭流式响应缓冲），保持请求 Host，在外部启用 HTTPS，并将请求体上限设为 500MB（`client_max_body_size 500m;`），否则带图片或大文件的 Agent 请求会在代理层被 413 拒绝。根据上游生成请求配置代理时限，不在本次配置中擅自改动业务请求超时。

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
- 部署主机默认不访问镜像仓库（`--pull never`）。`ssh-deploy.sh` 会在远程预检时检查 `postgres:17-alpine`、`rustfs/rustfs:latest` 与 `amazon/aws-cli:latest`，缺失的镜像从 Jenkins 构建节点 `docker save` 后经 SSH 传到主机 `docker load`；也可按上一节提前 `docker pull` 或离线导入以减少首次发布传输。

首次部署遇到同名但不受 current 管理的已有容器会拒绝接管，防止误覆盖旧部署。Compose 项目名、数据卷身份和部署目录应长期稳定。

### 导入宿主机 Codex 配置

网页助手使用镜像内安装的 Codex，不使用宿主机的全局 CLI。将仓库中的 `deploy/import-codex-config.sh` 单独复制到部署机，以已经配置好 Codex 且可执行 Docker 的用户运行：

```bash
# 默认读取当前用户的 CODEX_HOME 或 ~/.codex，查找 infinite-canvas 项目的 app 容器。
bash import-codex-config.sh

# 源目录或容器不同时显式指定；--restart 会重启整个应用，中断当前对话和请求。
bash import-codex-config.sh --source /home/你的用户/.codex --container 应用容器名 --restart
```

- 复制 `config.toml`、存在的 `auth.json`，以及顶层 `model_catalog_json` 引用的模型目录 JSON；保留宿主机原文件，不导入或覆盖历史会话、Skill、缓存和 Agent 数据。多个匹配容器时拒绝猜测；自定义项目名可用 `--project` 指定。
- 模型目录文件复制为容器 `CODEX_HOME` 下的 `imported-model-catalog.json`，配置中的对应路径同步改写，保留供应商和其他配置值。相对路径按宿主机配置目录解析；源文件缺失或不可读时停止，不删除该字段绕过问题。路径定点改写需使用普通单行顶层 `model_catalog_json = "..."` 写法，不能安全改写时拒绝覆盖。
- 脚本使用容器运行用户写入其 `CODEX_HOME`，默认即专用数据卷内的 `/home/node/.codex`；先在私有临时目录解析配置，再调用容器内 `codex app-server --print-startup-config` 验证暂存配置和模型目录兼容性，成功后才备份并替换，模型目录先于配置安装。备份目录以 `config-backup-` 开头，目录权限 700、文件权限 600；写入失败时尝试恢复，备份路径会输出但凭证内容不会输出。校验过程不发送对话请求，临时状态随暂存目录清理。
- 默认不重启；导入后按脚本提示，在无进行中任务时重启应用并新建 Codex 对话。`--restart` 只代表执行重启，不代表第三方服务认证或应用健康验收通过。
- 主机环境变量、系统钥匙串、项目级配置和模型目录之外的外部文件不会自动迁移。配置使用 `env_key` / `env_http_headers` 且容器缺少对应变量时会警告；变量密钥仍须通过受控的容器密钥注入方式提供，不要写入仓库、Jenkins artifacts 或 `production.env`。显式使用 `keyring` 凭证存储的配置会拒绝导入，应先在宿主机配置文件式认证。
- 普通导入除顶层模型目录路径外，不自动改写供应商地址、模型、权限、MCP 命令和本机绝对路径；`localhost` 在容器里指容器自身，宿主机本地代理、其他外部路径和 profile 私有模型目录需另行调整。只在交互 CLI 中临时选择的 profile 或通过命令行覆盖的配置也不会自动变成网页默认配置。
- 不要用 `sudo` 后的新 `$HOME` 误读 root 配置；需要 sudo 执行 Docker 时显式传 `--source /home/实际用户/.codex`。备份同样包含敏感凭证，只保存在专用 Codex 卷内，不要上传或提交。

#### 宿主机 Magpie 网关

宿主机 Codex 通过 `http://127.0.0.1:3425` 使用 Magpie 时，单独复制配置不能让容器访问代理。可显式启用网关配置：

```bash
# 以运行 Magpie 的非 root 用户执行；--restart 额外重启应用并中断当前请求。
bash import-codex-config.sh --container 应用容器名 --magpie-gateway --restart
```

- 前提为 Linux、宿主机 Python 3 / `flock` / `magpie` 可用，以及当前用户已有运行中的 `magpie.service`。手动启动的 `serve` / `web` / TUI 不会被脚本终止或接管；先自行退出对应进程，再运行 `magpie daemon install`。不要用 sudo 运行此模式。
- 当前仅支持单个 Docker bridge 网络的 IPv4 应用容器、宿主机顶层默认供应商 `magpie`、HTTP 回环地址端口 3425；有默认 profile、TLS、`EnvironmentFile` 或冲突的服务覆盖时拒绝自动调整，不降级 TLS，不猜测多个网络的出口。
- 通过 Magpie 官方 `gateway-key` CLI 创建独立命名 Key，重复执行复用脚本已有且仍启用的 Key；已撤销、禁用、改名或不匹配的 Key 不会被静默重建。服务只新增脚本专用的 `magpie.service.d/zz-infinite-canvas-gateway.conf`，保留原 unit、代理环境和提供商凭证。
- 先绑定 Docker 网关地址，并暂不放行容器，验证带 Key 的请求返回 403；再只放行容器的 `/32` 地址，验证无 Key 返回 401、有效 Key 返回 200。通过后才改为 `0.0.0.0:3425` 并复核认证，保留宿主机原 `127.0.0.1` 访问。过程中 Magpie 会重启三次，本机 CLI 暂时不可用；应用仅在 `--restart` 时重启。使用 Magpie 自带就绪等待，不添加新的超时或重试策略。
- 白名单为 Magpie 应用层的 `MAGPIE_ALLOW_IPS`，不是主机防火墙规则；不发布额外 Docker 端口、不修改防火墙或启用 host 网络。除选定应用容器外，其他远程 IP 不放行；宿主机自身地址仍按 Magpie 官方规则允许。容器重建导致 IP 改变后必须重新运行脚本更新白名单；不要把整个网段加入名单绕过问题。
- 容器新增独立的 `infinite_canvas_magpie` 供应商，地址为 `http://Docker网关:3425/v1`，关闭 WebSocket，并在 600 权限的 `config.toml` 中保存网关 Bearer Token；不复制宿主机 `auth.json`，保留容器已有认证文件、模型选择、已迁移的模型目录和其他供应商配置。宿主机 Codex 配置与上游供应商密钥不改动。此模式不依赖临时 `docker exec -e` 注入，应用重启后配置仍保留。
- 主机 Key 状态和私有事务备份位于 `${XDG_STATE_HOME:-~/.local/state}/infinite-canvas/`，目录 700、文件 600；备份中的 `transaction.json` 包含旧服务覆盖和旧 Key 状态，容器文件另按普通导入规则备份。所有 Key 创建输出、CLI 校验输出均不打印；这些状态、配置和备份包含凭证，不得上传、提交或贴到聊天中。
- 网关拒绝策略、认证检查、容器 CLI 校验或文件安装失败时，尝试恢复本次服务覆盖、旧 Key 状态及容器文件，仅撤销本次新建的 Key，不恢复整个 Magpie Key 仓库覆盖其他客户端。恢复失败会保留私有备份并明确提示人工处理。应用配置成功提交后，若最后的应用重启失败，保留已提交配置与 Key，待手动重启，不撤销正在使用的凭证。
- 检查仅使用读取模型列表的请求，不发送生成请求；脚本成功不代表真实模型对话已验收。完成后刷新网页并新建 Codex 对话，历史会话可能仍保留原供应商。

参考：[Magpie 网关与远程客户端](https://github.com/yetone/magpie/blob/main/docs/reference.md#connecting-anything-else)、[Codex 供应商配置](https://developers.openai.com/codex/config-reference/)。

## 版本、验证和回滚

目录：`incoming/<SHA>-<BUILD>/` 为本次镜像归档与元数据包，`releases/<SHA>-<BUILD>/` 为 Compose/镜像元数据，`current` 为最后一个健康版本的原子软链接，`shared/production.env` 为下一次部署输入，`shared/image-transfer/image.tar` 为可丢弃的传输比对基线。

镜像标签为 `infinite-canvas:<完整Git SHA>-<BUILD_NUMBER>`，不使用 latest。传输在严格校验的 SSH 通道内完成，远端还核对 SHA256SUMS、加载后的 Docker image ID、OCI revision 标签与实际运行容器 image ID。每个版本复制自己的 runtime.env，回滚恢复原版本运行参数；当前 shared 文件留给后续更新。

默认部署与回滚各使用 `--wait-timeout 120`（已确认）；构建后的隔离容器冒烟检查也最多等待 120 秒。不做无条件重试。容器健康探针不另设自定义阈值，沿用 Docker 默认的 30 秒检查间隔、30 秒检查超时和 3 次失败阈值；只影响容器健康状态，不改变 AI 业务超时。

更新前不执行 down。成功后才更新 current，将已校验镜像归档提升为传输基线并移除本次元数据包；保留历史 Compose、运行配置和 Docker 镜像供回滚，脚本不自动清理旧镜像/卷。管理员应按备份和回滚策略维护磁盘，不要全局 prune。

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

CI 流水线已取消测试和容器冒烟阶段，推送 `deploy` 后直接构建镜像并部署；部署健康检查仍由 `remote-deploy.sh` 执行。Dockerfile 保留 `test` 目标，需要时可手动运行 `docker build --target test .`。

### 容器办公与图片处理工具

运行时镜像内置 Python/Pillow、Word/Excel/PowerPoint/PDF 处理库，以及无界面 LibreOffice、Pandoc、Poppler、OCR（英文/简体中文）、FFmpeg、常用命令行程序和中日韩字体。Python 库固定版本，装在 `/opt/office` 虚拟环境，应用用户可直接运行 `python` / `python3`，无需 root 或临时安装。LibreOffice 用于后台格式转换，不提供桌面、远程桌面或额外网络端口；这些依赖会增加镜像体积和构建时间。

Agent 可通过 `canvas_export_image` 把当前画布原图复制到同工作区文件中心，再运行 `canvas-image-info <图片路径>` 检查真实透明像素或用 Pillow 处理。导出复用网页登录和工作区鉴权，不向模型提供 Cookie 或服务端密钥，不修改原图、聊天记录或画布节点。完整工具说明位于镜像内 `/usr/local/lib/infinite-canvas/office-tools.md`。

新增依赖只有在重建并部署镜像后才生效，不会由配置导入脚本安装。Agent 通信协议已升级为 9；部署完成后刷新网页并恢复原会话即可，不需要删除聊天记录或画布。请等待现有任务结束后再部署，因为更换容器会中断运行中的任务；不要使用删除数据卷的方式更新。

可手动执行 `docker build --target runtime-test .`，在实际运行时复制清单、Node/Bun 版本及非 root 用户下检查办公依赖、图片透明度和 Office 转 PDF；该目标不会改变当前 CI 的直接构建部署流程。本次未执行镜像构建或此容器验收。

本地不执行应用构建/类型检查（遵循仓库约定），构建留给流水线。真实镜像构建、Jenkins 语法/插件兼容性、Webhook 投递、SSH 登录、卷初始化、Codex 实际登录以及生产回滚仍需真实环境验收。

参考：[Jenkins credentials binding](https://www.jenkins.io/doc/pipeline/steps/credentials-binding/)、[GitHub plugin](https://plugins.jenkins.io/github/)、[Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)。
