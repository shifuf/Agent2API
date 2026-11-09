# 安装与部署

本页是三种交付形态的**完整安装与运维说明**：桌面端（Windows / macOS / Linux）、服务端（Windows / Linux，无界面）、Docker。不确定该选哪个，先看下面的对照表。

各形态装完之后**都在浏览器面板里管理**（加账号、建网关 Key、看报表）—— 面板与网关同端口，桌面端则额外有应用窗口。

**简体中文** | [English](./install.en.md) | [繁體中文](./install.zh-Hant.md) | [日本語](./install.ja.md) | [한국어](./install.ko.md) | [Português (BR)](./install.pt-BR.md)

## 渠道与模型配置（本分支）

本分支使用「模型管理」维护上游模型目录，可按提供商查看、获取、选择和测试模型。对外模型 ID、关联上游和选路策略统一由「路由组」管理，支持对话与图片生成/编辑，也支持只有一个成员的路由组。获取或启用上游模型不会自动创建对外 ID。

账号页和提供商分组仍可获取上游模型；自定义渠道通过 Key 分组选择允许使用的模型。编辑账号 → 凭证设置（内置账号为「凭证与套餐」）→ 查看密钥详情，可读取、复制和隐藏已保存的凭证；不会填入替换密钥的输入框。手机端账号详情也提供此入口。查看需要管理员会话或环境变量管理 Key，普通网关 Key 无权读取；隐藏、切换页面或关闭窗口后清除显示内容。

1. 在账号页点击「添加自定义渠道」（也可从「添加账号 → API 模板」进入），选择 API 提供商或模板，填写 API 地址并添加命名 Key 分组。每组可填写多把 Key，Key 与「支持的模型」分区管理；可以先保存尚未选择模型的渠道，稍后再配置。按分组获取模型或点击「获取全部分组模型」后，需选择并确认模型；获取清单不会自动选中，未选择模型或已停用的分组不转发。
2. 在「路由 → 创建路由组」填写名称和对外模型 ID，选择对话或图片类型，再按提供商选择已有账号获取的上游模型和参与账号。单个模型添加一个成员即可，多渠道可添加多个成员并设置策略。对外 ID 可以与上游 ID 相同；只有其他已保存的路由组会占用这个名称。对话与图片成员不能混用，嵌套组也必须同类型。
3. 在「网关 Key」分别创建、编辑或查看 Key，通过列表中的「可用范围」独立选择允许的渠道和对外模型；选择面板支持搜索、已选预览和确认。两项同时设置按交集生效；未选择渠道表示全部渠道，未选择模型表示全部已发布模型。删除渠道会保留 Key 的原有限制。
4. 在「代理」页管理订阅并安装或导入内核。订阅节点可用于账号和代理池；停止内核或停用节点后，绑定的请求不会自动改成直连。

添加和编辑渠道使用居中表单，Key 编辑与模型选择在旁侧面板中进行。候选只显示已启用、具有凭据并允许使用该模型的账号。客户端与网关 Key 的模型列表仅显示启用且有可用上游的路由组；旧 Key 中失效的限制继续保留，不会自动扩大权限。

### 升级时的路由迁移

升级前请停止容器并完整备份数据目录，包括数据库和账号加密密钥。首次启动会将原模型管理记录及模型独立路由原子迁入路由组，保留对外 ID（含大小写）、启停状态、账号范围和策略；没有对应已发布模型的旧独立路由转为停用草稿。原模型与路由配置保存在数据库配置项 `routingGroupsMigrationV1` 中，账号和网关 Key 不变；重复启动不会重复迁移。若旧配置损坏或存在重名冲突，迁移停止并明确报错，原配置不会被覆盖。回退旧程序时使用升级前的完整数据备份。

「路由」页按厂商识别模型，提供同模型跨渠道分组建议。建议默认不发布；显式开启自动组，或保存并启用自定义组后才对外可用。可以隐藏、恢复、复制、排序、导入和导出组；复制与导入的组默认停用。导出不含账号 ID 或本机目录规则，导入后请检查渠道与账号范围再启用。

组支持顺序、轮询、智能、最少用量、消耗节奏、免费、速度、权重、手动及提供商优先策略；成员可限定账号或动态纳入该渠道账号，并可使用嵌套组和模型匹配模式。条件规则支持 token 数、图片、推理等级、客户端、意图、压缩请求、时区和目录。意图与自动推理等级需要配置分类器，会产生一次上游模型调用；超时或无效结果回退普通选路。

预演可填写请求条件，查看命中规则、首选和跳过原因，不发送请求或推进轮询。首内容超时只会在尚未输出内容时切换上游；严格绑定不会换账号。新的组可配置暂态错误等待预算，旧组保留原有等待行为。手机端从「更多 → 路由」管理路由组。已停用或无可用账号的组不会显示在客户端及 Key 模型候选中；Key 的模型和渠道限制始终生效。

顺序优先会先尝试队首，遇到可回退的失败才继续下一家，不会把每次请求依次分摊给所有成员。如果上游已返回 HTTP 200 却迟迟没有有效内容，需要设置「首内容超时」（例如 20 秒）；0 表示关闭，因此可能一直等到客户端断开。短暂失败等待 0 表示失败后的 60 秒重试预算，并非每个成员的首内容期限。需要每次从队首开始时关闭会话粘滞；需要不同请求轮换成员时使用轮询策略。内容已开始输出后不会中途换家。

## 目录

- [选哪种形态](#选哪种形态)
- [桌面端（Windows / macOS / Linux）](#桌面端windows--macos--linux)
- [服务端（Windows / Linux，无界面）](#服务端windows--linux无界面)
- [Docker](#docker)
- [验证与客户端接入](#验证与客户端接入)
- [局域网访问](#局域网访问)
- [手机端](#手机端)

## 选哪种形态

| 形态 | 产物 | 界面 | 说明 |
| --- | --- | --- | --- |
| **Windows 桌面端** | `Agent2API_<版本>_x64-setup.exe` | 应用窗口 | NSIS 安装包，默认装到 `C:\Program Files\Agent2API`，安装时需要管理员授权 |
| **macOS 桌面端** | `Agent2API_<版本>_universal.dmg` | 应用窗口 | 通用二进制（Apple Silicon 与 Intel 各编一遍再合并），最低 macOS 10.15 |
| **Linux 桌面端** | `Agent2API_<版本>_amd64.deb` 或 `Agent2API_<版本>_amd64.AppImage` | 应用窗口 | deb 装进系统（依赖 webkit2gtk-4.1 / gtk3）；AppImage 免安装单文件，任意发行版可用 |
| **Windows 服务端**（无 GUI） | `agent2api-server-windows-amd64.zip` | **浏览器面板** | 命令行安装、注册成 Windows 服务，见 [服务端](#服务端windows--linux无界面) |
| **Linux 服务端**（无 GUI） | `agent2api-server-linux-<arch>.tar.gz` | **浏览器面板** | 命令行安装、systemd 托管，同一个包也是容器内更新载荷 |
| **Docker** | `ghcr.io/shifuf/agent2api:latest` | **浏览器面板** | amd64 / arm64 双架构，见 [Docker](#docker) |

> 选哪个：**自己有桌面**（要托盘、开机自启、本机登录态导入）→ 桌面端；
> **服务器上没有图形界面**（Windows Server / Linux 服务器）→ 服务端包；
> **已经跑 Docker** → 镜像。
>
> 桌面端需要图形界面，**装不到无 GUI 的服务器上**。服务端包不链接任何
> WebView / GTK 依赖，一个可执行文件加一个 `ui/` 目录就能跑。

## 桌面端（Windows / macOS / Linux）

**桌面端**（Windows / macOS / Linux）安装后启动即可，**无需安装 Node 或任何其它运行时**；网关跑在应用进程内，托盘常驻。

1. 首次启动即在应用进程内启动本机网关（端口 3065）并打开主窗口；若检测到旧版本的数据目录或数据文件，会弹窗提示迁移，按指引操作即可。
2. 点「账号」页的「添加账号」，选提供商后按弹窗提示完成登录或填写凭证即可（方式以弹窗为准：网页登录 / 手机验证码 / 粘贴凭证 / 导入本机登录态）。
3. 把 OpenAI 客户端的 `base_url` 填成 `http://127.0.0.1:3065/v1`，`api_key` 随便填（例如 `sk-local`，未启用鉴权时服务端不校验）。

关闭窗口默认最小化到托盘，网关继续在后台转发；彻底退出请在托盘图标右键选「退出」。

> **macOS 首次打开**：dmg 里的应用未做 Apple 代码签名与公证（签名需要付费的 Apple Developer 账号，见 `.github/workflows/build.yml` 的说明），Gatekeeper 会拦下首次启动 —— 到「系统设置 → 隐私与安全性」里手动放行一次即可。
>
> **Linux 桌面端**：托盘依赖 `libayatana-appindicator3`（多数桌面环境已自带）；若桌面环境下托盘图标不显示，装 `libayatana-appindicator3-1` 后重开即可。AppImage 首次运行前需要可执行位（`chmod +x`，程序在「打开安装包」时会自动补）。更新方式：deb 走系统安装器（装的时候会问一次密码），AppImage 是换文件即升级。
>
> **桌面端的差异**：AutoClaw 与智谱清言的「导入本机登录态」只在 Windows 可用（读的是 Windows 的 DPAPI 密文，macOS / Linux 上整段收起）；其余家（小浣熊 / CatPaw / Cline）读的是 `HOME` 下的明文文件，三个平台都可用。托盘、开机自启、局域网访问与网页面板托管在 macOS / Linux 上同样支持。

## 服务端（Windows / Linux，无界面）

给**没有图形界面的服务器**用（Windows Server、Linux 服务器、云主机）。产物是同一份
`agent2api-server` 二进制：无窗口、无托盘、不链接 WebView / GTK，运行时不依赖
Node 或任何其它运行时。命令只负责**安装**，装完之后的管理（加账号、建 Key、
看报表）都在浏览器面板里做。

服务以系统服务方式常驻：开机自启、崩溃自动拉起、无控制台后台运行。

### Windows Server

下载 `agent2api-server-windows-amd64.zip`，解压后**以管理员身份**打开 PowerShell：

```powershell
Expand-Archive agent2api-server-windows-amd64.zip -DestinationPath C:\agent2api-pkg
cd C:\agent2api-pkg
.\install-service.ps1
```

脚本会：装程序到 `C:\Agent2API`、数据落到 `C:\ProgramData\Agent2API`、注册名为
`Agent2API` 的 Windows 服务（`LocalSystem`，开机自启）、加防火墙入站规则，然后启动。

```powershell
# 自定义位置与端口
.\install-service.ps1 -InstallDir D:\apps\agent2api -DataDir D:\data\agent2api -Port 8080

# 日常管理
Get-Service Agent2API
Restart-Service Agent2API
Stop-Service Agent2API

# 卸载（保留数据）；加 -Purge 连程序与数据一起删
.\install-service.ps1 -Uninstall
```

**一键更新**：标准 Windows 服务安装可在「设置 → 更新」点击「一键更新」。确认后自动下载 Windows x64 服务端包，独立校验官方摘要，由临时升级进程停止服务、等待文件占用释放、备份替换并重新启动。确认新版服务运行后页面自动刷新；账号、配置和数据不删除。

**旧安装接入 / 手动升级**：把新版服务端包解压到新的目录，以管理员身份运行一次 `install-service.ps1`。脚本默认保留已登记的安装目录、数据目录、端口、环境配置和服务账号；只有显式传入的端口等选项才覆盖原值，目录迁移需单独进行。此次接入完成后可使用面板一键更新。

程序目录仅系统和管理员可写，升级工作目录为 `<安装目录>\.service-update`，不新增常驻服务。`AGENT2API_WINDOWS_UPDATE=0` 可在服务环境变量中关闭入口。自定义服务账号、目录链接、网络路径及受外部进程组托管的部署保留手动升级，不自动提权。替换失败会恢复旧文件；新版启动未确认时保留升级日志与备份，不自动回退数据库。

> **两个 Windows 特有的坑，脚本已经处理好了**：
> 服务进程的工作目录是 `C:\Windows\system32` 而不是 exe 所在目录 —— 界面目录靠
> exe 路径定位，不受影响；数据目录则由脚本显式写入服务注册表的
> `AGENT2API_PROXY_HOME`（不设的话会落到 LocalSystem 的
> `C:\Windows\system32\config\systemprofile` 下，几乎不可能找到）。
> 服务没有控制台，所以日志同时落文件 `C:\ProgramData\Agent2API\logs\server.log`。

### Linux（systemd）

```bash
tar -xzf agent2api-server-linux-amd64.tar.gz
cd agent2api-server-linux-amd64      # 或解包后的目录名
sudo bash install.sh
```

脚本会：建 `agent2api` 系统账号（不允许登录）、装程序到 `/opt/agent2api`、数据落
`/var/lib/agent2api`、配置写到 `/etc/agent2api/agent2api.env`、装 systemd 单元并
`enable + start`。

```bash
# 升级（保留数据与配置，旧二进制备份为 .bak）
sudo bash install.sh --upgrade

# 卸载（保留数据）；加 --purge 连数据与配置一起删
sudo bash install.sh --uninstall

# 日常管理
systemctl status agent2api
systemctl restart agent2api
journalctl -u agent2api -f
```

开机自启、崩溃自动拉起（`Restart=always`）、SIGTERM 优雅停机（等在途请求跑完
再退出，SSE 长连接不会被打断）都已配好。配置改 `/etc/agent2api/agent2api.env`
后 `systemctl restart agent2api` 生效。

> **systemd 一键更新**：标准安装已包含受限升级程序，面板点击「一键更新」并确认后，会下载、独立核验官方校验值、备份替换、重启并确认新版服务。账号与配置保留，网关继续以普通账号运行，程序目录仍由 root 保护。
>
> 旧安装先下载包含本功能的新版服务端包，在新包目录执行一次 `sudo bash install.sh --upgrade`，补装升级组件后即可使用。自定义服务账号或安装路径不会被脚本强行改写，继续使用原部署方式升级。`AGENT2API_SYSTEMD_UPDATE=0` 可关闭面板入口；停用 `agent2api-updater.socket` 可停用升级组件。`AGENT2API_SELF_UPDATE` 仍为 Docker 专用，不要在裸机开启。
>
> 更新组件通过本机 socket 工作，不开放网络端口。默认从官方索引核验发布仓库；需固定仓库或为独立校验配置代理时，管理员可在 `/etc/agent2api/updater.env` 设置 `AGENT2API_UPDATER_REPO=owner/repo` 或 `HTTPS_PROXY`。替换失败会还原；新版启动未确认成功时保留 `/opt/agent2api/.before-update-*` 恢复文件并报告失败，不自动回退数据库。

### 装完之后

两个平台都一样 —— 打开浏览器：

```
http://<服务器IP>:3065/
```

1. 首次进入会引导**注册管理员账号**（也可以用环境变量预置，见下）
2. 登录后在「网关 Key」页创建一把 API Key
3. 客户端 `base_url` 填 `http://<服务器IP>:3065/v1`，`api_key` 填刚建的那把

> ⚠️ **建 Key 之前 `/v1/*` 会拒绝服务**（fail-closed）。这是刻意的：服务端形态
> 绑 `0.0.0.0`，没配 Key 就把上游额度对全网开放是不可接受的。

### 无人值守部署

管理员和网关 Key 都能用环境变量预置，跳过浏览器里的手动步骤：

| 变量 | 说明 |
| --- | --- |
| `AGENT2API_ADMIN_USER` + `AGENT2API_ADMIN_PASSWORD` | 预置管理员（密码明文填，启动时自动转 bcrypt）；也可用 `AGENT2API_ADMIN_PASSWORD_HASH` 直接给哈希 |
| `AGENT2API_PROXY_API_KEY` | 预置一把网关 Key，跳过「面板里建第一把」 |
| `AGENT2API_PROXY_HOME` | 数据目录 |
| `AGENT2API_HOST` / `AGENT2API_PROXY_PORT` | 监听地址（默认 `0.0.0.0`）/ 端口（默认 `3065`） |
| `AGENT2API_PANEL_PORT` | 面板分端口：管理面单独监听该端口，主端口只留 `/v1/*` |
| `AGENT2API_ALLOW_NO_KEY` | 置 `1` 关闭 fail-closed（仅纯内网） |
| `AGENT2API_LOG_FILE` | 日志文件路径，默认 `{数据目录}/logs/server.log` |
| `AGENT2API_VERBOSE` | 置 `1` 打开 debug 日志 |

Linux 写在 `/etc/agent2api/agent2api.env`；Windows 改服务注册表的
`HKLM\SYSTEM\CurrentControlSet\Services\Agent2API\Environment`（`install-service.ps1`
已经写好基础项，重跑时保留已有配置，只按显式参数修改对应项）。

> **账号无法预置**：账号需要扫码 / 验证码 / 粘贴凭证，这一步由上游协议决定，
> 绕不过去。批量部署可以把已经配好的**数据目录整个拷过去**（SQLite 库 +
> `account.key` 在同一个目录里），账号随之迁移。

## Docker

本 fork 的镜像发布到 `ghcr.io/shifuf/agent2api`。推送到 `main` 后更新 `latest`，推送到 `beta` 后更新 `beta`；每次构建还发布 `sha-<完整提交 SHA>`，可用来固定版本。Actions 页的 **Docker package** 可手动构建：选择 main/beta 更新对应标签，其他分支只更新 `dev`。镜像包含 amd64 / arm64 两种架构，构建时重新生成桌面、登录页、手机端和多语言资源。

工作流使用当前仓库的 `GITHUB_TOKEN` 发布到 GHCR，无需 Docker Hub 或上游构建仓库的密钥。fork 到其他账号后，镜像路径自动变为 `ghcr.io/<账号>/<仓库名>`（全小写）。首次启用仓库的 Actions 并推送代码后，在 **Actions → Docker package** 查看结果；如需匿名拉取，在包的设置里将可见性改为 Public。此工作流只发布容器包，不创建 tag 或 GitHub Release，也不修改版本号。

本仓库的 Compose 文件支持 `AGENT2API_IMAGE`（默认 `ghcr.io/shifuf/agent2api`）与 `AGENT2API_VERSION`（默认 `latest`）；两项只用于选择镜像，不传入应用。拉取并部署：

```bash
docker compose up -d --pull always --no-build
AGENT2API_VERSION=beta docker compose up -d --pull always --no-build
```

```bash
docker run -d --name agent2api --restart unless-stopped \
  -p 3065:3065 -v ./data:/data \
  ghcr.io/shifuf/agent2api:latest
```

浏览器打开 `http://<主机>:3065`，首次进入会引导**注册管理员账号**；登录后在「网关 Key」页建一把 API Key 给客户端用 —— `http://<主机>:3065/v1` 即 OpenAI 兼容端点（未建 Key 前拒绝转发）。状态（SQLite 库 / 配置 / 日志）都在 `./data` 一个卷里。

compose 用户（amd64 / arm64 都有镜像）：

```yaml
services:
  agent2api:
    image: ghcr.io/shifuf/agent2api:latest
    container_name: agent2api
    restart: unless-stopped
    ports:
      - "3065:3065"
    volumes:
      - ./data:/data
```

环境变量（都可选）：

| 变量 | 说明 |
| --- | --- |
| `AGENT2API_ADMIN_USER` + `AGENT2API_ADMIN_PASSWORD` | 预置管理员账号密码（密码明文填，启动时自动转哈希）；不填走面板注册 |
| `AGENT2API_PANEL_PORT` | 面板分端口：设后面板（界面 + `/api/*`）单独监听该端口，公网只映射主端口即可把管理面留在内网（面板端口绑回环，写 `127.0.0.1:3066:3066`） |
| `AGENT2API_HOST` / `AGENT2API_PROXY_PORT` | 监听地址（默认 `0.0.0.0`）/ 端口（默认 `3065`） |
| `AGENT2API_ALLOW_NO_KEY` | 置 `1` 关闭 fail-closed（未配 Key 也放行 `/v1`，仅限纯内网） |
| `AGENT2API_CAPTCHA_ENABLED` | 登录页人机验证：默认 `1` 开启，`0` 关闭 |
| `AGENT2API_SELF_UPDATE` | 容器内的更新入口：本 fork 默认 `0` 关闭，使用 Compose 拉取自己的镜像升级；显式设为 `1` 前应将更新源配置为自己的 Release |
| `AGENT2API_IMAGE_CACHE_MB` | 生成图片的内存下载缓存上限（MiB，默认 `128`，范围 8~4096）。写坏 / 越界回落默认值 |
| `AGENT2API_IMAGE_COMPRESS_CACHE_MB` | 会话图片压缩结果的内存缓存上限（MiB，默认 `128`，范围 8~4096，口径同上） |
| `WORKBUDDY_UPDATE_REPO` + `WORKBUDDY_UPDATE_API_BASE` | 进阶：把「检查更新 / 下载更新」换成自建源。前者换仓库（默认跟上游 `aimod-cc/Agent2API`，fork 后可改），后者换 API 根（默认 `https://api.github.com`，需返回与 GitHub 同形的 release JSON）。配了自建源后，下载白名单只额外放行**该源自己的域名**（按源的 scheme：配 `http://` 就允许明文下载，仅建议本地演练/内网镜像用）|

从源码构建：克隆本仓库后运行 `docker compose up -d --build --pull never`。Dockerfile 使用 lock 文件安装依赖并重建前端，最终镜像只包含网关和面板，不含 Node / Rust 工具链。

### 从上游容器迁移到本 fork

先等本 fork 的 **Docker package** 构建成功，并确认目标 `sha-<完整 40 位提交 SHA>` 镜像可以拉取。仓库里有工作流文件不代表镜像已经发布。下面以 Linux 上由 `docker run` 创建的 `agent2api`、端口 `3065:3065`、`AGENT2API_PROXY_HOME=/data`，以及实际 bind mount `/www/server/panel/data:/data` 为例；路径只是假设，先核对自己的挂载，不能根据当前目录猜原来的 `./data`：

```bash
docker inspect --format '{{.Config.Image}}{{println}}{{range .Mounts}}{{println .Type .Source "->" .Destination}}{{end}}' agent2api
```

保留整个数据目录，包括 `agent2api.db`、可能存在的 `-wal` / `-shm` 文件、`account.key`、`update-token.key`、`cloud-sync.key`、插件和旧配置。若旧容器设置了 `AGENT2API_ACCOUNT_KEY`，必须原值保留；有效环境密钥优先于 `account.key`，不要新生成一把替代。下方只将这项环境变量写到受保护的文件，不在终端显示。其他自定义环境变量、端口、网络和额外挂载也要沿用。

新版使用独立目录中的副本，原目录留给旧容器。`/www/server/panel/data` 可能同时属于服务器面板，不能整体移动、覆盖或清空。复制与备份可能包含其他文件，因此迁移目录与密钥文件都应作为敏感备份保管。请在服务器的 **root Bash** 中执行，替换镜像占位符；先拉镜像，再停旧容器复制和打包，任何步骤失败即停止。需要足够空间容纳数据副本及归档，停机时间包含复制、备份和新版启动时间。

```bash
set -euo pipefail
umask 077
NEW_IMAGE='ghcr.io/shifuf/agent2api:sha-<PUBLISHED_FULL_40_CHARACTER_SHA>'
SOURCE_DATA='/www/server/panel/data'
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' agent2api)" = "$SOURCE_DATA"
test -d "$SOURCE_DATA"
docker pull "$NEW_IMAGE"

STAMP=$(date +%Y%m%d-%H%M%S)
MIGRATION_DIR="/opt/agent2api/migrations/$STAMP"
FORK_DATA="$MIGRATION_DIR/data"
OLD_CONTAINER="agent2api-before-fork-$STAMP"
test ! -e "$MIGRATION_DIR"
mkdir -p "$FORK_DATA"
chmod 700 "$MIGRATION_DIR"
printf '%s\n' "$OLD_CONTAINER" > "$MIGRATION_DIR/old-container-name.txt"
docker inspect --format 'container={{.Id}} image={{.Config.Image}} imageId={{.Image}}' agent2api > "$MIGRATION_DIR/container-image.txt"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' agent2api |
  sed -n '/^AGENT2API_ACCOUNT_KEY=/p' > "$MIGRATION_DIR/account-key.env"

docker stop --time 60 agent2api
cp -a -- "$SOURCE_DATA/." "$FORK_DATA/"
tar --numeric-owner -cpf "$MIGRATION_DIR/data-before-fork.tar" -C "$FORK_DATA" .
tar -tf "$MIGRATION_DIR/data-before-fork.tar" >/dev/null
docker rename agent2api "$OLD_CONTAINER"
docker run -d --name agent2api --restart unless-stopped \
  -p 3065:3065 \
  --env-file "$MIGRATION_DIR/account-key.env" \
  -e AGENT2API_SELF_UPDATE=0 \
  -e AGENT2API_CAPTCHA_ENABLED=1 \
  -v "$FORK_DATA:/data" \
  "$NEW_IMAGE"
printf 'old_container=%s\nmigration_dir=%s\n' "$OLD_CONTAINER" "$MIGRATION_DIR"
```

保存最后输出的 `migration_dir`。若复制或打包失败，旧容器尚未改名，可运行 `docker start agent2api` 恢复，再排查备份问题；不要继续后面的替换命令。旧容器保留了可写层：若以前用过面板一键更新，它比重新拉取旧镜像标签更能准确恢复原程序。

启动后检查 `/health`，并在面板核对账号、凭证状态、网关 Key、插件和路由组。账号与 Key 保留；已有手动对外模型按上文迁入路由组。上游目录仅用于管理来源，不自动发布模型。请在「路由」检查迁移结果，按需创建并启用路由组，沿用客户端原模型 ID，再用原 Key 验证实际请求。健康检查通过不代表业务已恢复。后续升级继续挂载输出目录里的 `data`，并保持 `AGENT2API_SELF_UPDATE=0`。

回滚时，替换为刚才记录的迁移目录。先停止新版，再启动保留的旧容器；旧容器仍使用未被新版升级的原目录，因此无需覆盖任何数据库：

```bash
set -euo pipefail
MIGRATION_DIR='/opt/agent2api/migrations/<MIGRATION_TIMESTAMP>'
OLD_CONTAINER=$(cat "$MIGRATION_DIR/old-container-name.txt")
docker container inspect "$OLD_CONTAINER" >/dev/null
STAMP=$(date +%Y%m%d-%H%M%S)
if docker container inspect agent2api >/dev/null 2>&1; then
  docker stop --time 60 agent2api
  docker rename agent2api "agent2api-fork-stopped-$STAMP"
fi
docker rename "$OLD_CONTAINER" agent2api
docker start agent2api
```

保留旧容器、原数据目录、`data-before-fork.tar` 和 `account-key.env`。不要同时运行新旧实例。若选择原地升级同一目录，则回滚必须恢复升级前的整份数据及原密钥，不能只换回旧镜像：例如 `3.3.0-beta.5/.6` 的 schema 22 会升级为 `3.4.2` 的 schema 24，旧程序拒绝打开更高版本的库。Compose 部署也应先停止服务、备份并复制到独立目录，再修改镜像、数据挂载和 `AGENT2API_SELF_UPDATE`，同时保留原 Compose 配置供回滚。

### 内存占用

镜像里的网关（Linux 目标）已内置 jemalloc 内存分配器。长时间运行、多账号并发转发时，它比系统自带的分配器更不容易产生内存碎片、RSS 也不容易缓慢增长 —— 这正是小内存机器最常被拖垮或 OOM 的一环。

小内存机器建议给容器设一个内存上限：超限时内核杀掉进程，再由 `restart: unless-stopped` 拉起，表现为「重启一次」，而不是把宿主机（或同机其它服务）拖垮。

```bash
# docker run
docker run -d --name agent2api --restart unless-stopped --memory=1g \
  -p 3065:3065 -v ./data:/data \
  ghcr.io/shifuf/agent2api:latest
```

compose 用户在服务里加一行 `mem_limit: 1g`（`docker-compose.yml` 里已附注释示例）；swarm 或 `docker compose --compatibility` 用 `deploy.resources.limits.memory`。1g 只是起点，按实际并发量调。

两处常驻内存的图片缓存上限都能用环境变量调小（默认各 `128` MiB）：`AGENT2API_IMAGE_CACHE_MB`（生成图片的下载缓存）、`AGENT2API_IMAGE_COMPRESS_CACHE_MB`（会话图片压缩结果缓存）。写坏或越界会回落默认值，不会让服务起不来。

`MALLOC_ARENA_MAX=2` 这类 glibc 分配器调优，只对**没有内置 jemalloc 的形态**有意义（旧版镜像、自行编译的服务端、桌面端）；本镜像已不需要设它。

**网页面板的功能差异**（源于「没有本机桌面客户端」）：网页登录（WorkBuddy / Qoder / Cline）、手机验证码、粘贴凭证完全可用；需要本机回调的网页登录（AutoClaw / CatPaw / Accio / CodeArts / Trae）与「导入本机登录态」不可用，请改用粘贴凭证。桌面端开着「同时开放网页管理面板」时，用浏览器访问该面板也是这一套差异 —— 同一份界面、同一套判定。

### 容器内更新（可选）

本 fork 默认设置 `AGENT2API_SELF_UPDATE=0`，通过 `docker compose up -d --pull always --no-build` 更新容器，保留 `./data`。这样镜像标签与运行代码保持一致，也避免将自己维护的功能替换成上游 Release。

如确实需要容器内原地更新，可显式设置 `AGENT2API_SELF_UPDATE=1`，并配置 `WORKBUDDY_UPDATE_REPO` / `WORKBUDDY_UPDATE_API_BASE` 指向自己维护的发布源。面板会下载 `agent2api-server-linux-<arch>.tar.gz` 并校验 `.sha256`，替换可执行文件与 `ui/`，再由 restart 策略启动新进程。

同一个 `agent2api-server-linux-<arch>.tar.gz` 也是 [Linux 服务端](#linuxsystemd) 的安装包：包内的 `agent2api-server` 与 `ui/` 是这条更新链按名取的条目，另外还带着 `install.sh` / `agent2api.service` / `agent2api.env.example`。容器更新链只认前两个条目（其余读完即丢，见 `selfupdate::extract_bundle`），所以一份产物同时服务两种用途 —— 容器里解包替换，裸机上解包跑 `install.sh`。

代价要清楚：更新后容器标签与**实际运行的版本会漂移**（`docker inspect` 显示的仍是旧 tag），执行 `docker compose pull && up -d` 重建容器会回到镜像里的版本。想固定版本就别开这个入口。

## 验证与客户端接入

网关起来后，用 curl 确认联通性（`model` 填 `GET /v1/models` 里任一实际存在的名字）：

```bash
curl http://127.0.0.1:3065/health
curl http://127.0.0.1:3065/v1/models

curl http://127.0.0.1:3065/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

客户端接入示例（Python SDK）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3065/v1", api_key="sk-local")
resp = client.chat.completions.create(
    model="deepseek-v4.1-flash",     # 名单里有哪家就是哪家，见 GET /v1/models
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

**浏览器页面**（自建 Web UI 等）用 `fetch` 直连会被跨源预检拒绝——网关默认不应答 CORS，预检落到 API Key 校验上得 401。两种解法：① 设置页「安全 → 网关跨域访问」打开（来源 `*`；此时任何网页都能借本机网关打上游，建议同时配「网关 Key」）；② 页面与网关同源——本地静态服务托管页面并把 `/v1` 反代到 `127.0.0.1:3065`。

## 局域网访问

默认只监听 `127.0.0.1`。开启「设置 → 通用 → 局域网访问」后改听所有网卡，局域网设备把 API 地址指向本机 IP 即可共用（界面会给出完整地址）。出于安全，开启前必须注册面板管理员：管理接口要求管理员会话或网关 Key，无可用 Key 时转发接口同样拒绝服务（开启流程会自动补一把「默认」Key）；也可选择同时开放网页面板（默认关闭）。改动重启生效。

桌面端（Windows / macOS）装包里就带着网页面板那一份 `ui/`，打开「同时开放网页管理面板」后局域网设备用浏览器访问同一地址即是管理界面 —— 与 Docker 版是同一份界面；**桌面窗口自己不走网页登录**（没有登录页），它以本机第一把网关 Key 作为凭证，打开这个开关不需要你额外登录桌面端。网页登录页只在浏览器访问面板时出现。

## 手机端

手机端有三种形态，按需要选：

| 形态 | 怎么装 | 适合 |
| --- | --- | --- |
| **浏览器 / PWA** | 手机浏览器打开 `/m`，可「添加到主屏幕」 | 临时看、不想装东西、iPhone 首选 |
| **Android APK** | 装 `Agent2API-<版本>.apk` | 要图标、要全屏、要管多台服务器 |
| **iOS IPA** | 装 `Agent2API-<版本>.ipa`（未签名，需自行重签） | 要图标、要全屏 |

三者的界面是同一份代码，区别在「谁提供页面」：PWA 由网关出（所以必须开「同时开放网页管理面板」），APK / IPA 把界面打进包里（所以离线也能起界面，且不需要那个开关）。

### 前置条件（按形态）

**桌面端（Windows / macOS / Linux）**：两个开关都要开，缺一不可。

1. 「设置 → 通用 → 局域网访问」—— 允许局域网设备访问网关。开启流程会要求先注册面板管理员，并自动补一把名为「默认」的 Key。
2. 「设置 → 通用 → 局域网访问 → 同时开放网页管理面板」—— 托管 `ui/` 静态目录。**浏览器 / PWA 形态需要它**（`/m` 由网关出，开关关着时 404）；**APK / IPA 不需要**（界面在包里），但仍然要第 1 项，否则网关只监听 `127.0.0.1`，手机连不上。

两项都要重启生效。

**服务端 / Docker**：不用额外开开关 —— 这两种形态默认就监听所有网卡、默认托管 `ui/`（Dockerfile 里 `AGENT2API_UI_DIR=/app/ui` 是写死的）。只要容器或服务的端口对局域网可达即可。若你手工设过 `AGENT2API_HOST=127.0.0.1`，改成 `0.0.0.0`；若 `AGENT2API_UI_DIR` 指向的目录不存在，面板会 404 而 API 照常工作。

### 在手机上打开（浏览器 / PWA）

`http://<网关所在机器的局域网IP>:3065/m`

桌面端就是上一步界面给出的那个地址（形如 `192.168.1.23`），把端口后面的 `/v1` 换成 `/m`。Docker / 服务端用宿主机的局域网 IP 与映射出去的端口。

首次打开会跳到登录页，用面板管理员账号登录后自动回到手机端。没注册过管理员时，登录页会先让你创建一个。

### 安装 APK（Android）

装包后首次打开是一个「服务器」页，流程只有三步：

1. 点「添加」，填网关的 `IP 或域名:端口`（如 `192.168.1.23:3065`）。协议可写 `http://` 或 `https://`，不写默认 http；不写端口时 http 补 3065、https 走标准 443；
2. 点「连接并保存」—— 会先探活，连不上会当场说清楚是地址错还是网关没开局域网；
3. 弹出登录页，输入这台网关的管理员账号密码（没注册过管理员的会变成「创建管理员」）。

**多台服务器**：再点一次「添加」即可。每台的登录状态各自独立保存 —— 切过去不用重新登录，切回来也一样。入口在「设置 → 服务器」，列表里点哪台就切到哪台；**登录页底部也有「换一台服务器」**，退出登录或被登出后不用先登进去再找入口。

**APK 的已知限制**：

- 不写协议时默认走 `http://` 局域网地址，明文。风险面是「同一局域网内可嗅探」，网关本身仍然要管理员登录。想消除的话给网关配 TLS（反代或隧道都行），在 App 里填 `https://` 地址即可 —— 协议会被原样保留，证书无效时探活会直接失败。
- 界面随 APK 版本走，不随网关升级。网关升级后如果新增了页面，要装新版 APK 才看得到；纯数据变化不受影响。

### 安装 IPA（iOS）

Release 里的 `Agent2API-<版本>.ipa` **默认是未签名包** —— 苹果不允许开发者随意分发可安装的 App，未签名包需要用户用自己的 Apple ID 重签一次。三条路：

| 方式 | 需要 | 有效期 |
| --- | --- | --- |
| **AltStore / SideStore / Sideloadly** | 一台电脑（首次）+ 免费 Apple ID | 7 天，到期重签 |
| **Apple Developer Program** | $99/年，自己配证书与描述文件 | 1 年 |
| **App Store / TestFlight** | $99/年 + 审核 | 长期 |

侧载的具体步骤：把 `.ipa` 拖进 AltStore（或 SideStore），用 Apple ID 重签后安装。免费账号限制：同时最多 3 个 App、每 7 天要重签一次。

**iPhone 用户如果只是想在手机上看网关，直接用 Safari 打开 `/m` 并「添加到主屏幕」即可**，不需要装 IPA —— 观感与原生应用几乎一致，也省掉重签的麻烦。

**IPA 的已知限制**：

- **应用内更新只能跳转**：iOS 不允许 App 自己下载并安装可执行代码，所以设置页的「软件更新」在 iOS 上给的是「去下载」按钮（打开 Release 页面），不会像 Android 那样直接下载安装。PWA 形态则走 Service Worker，刷新即可。
- 局域网 `http://` 网关：`Info.plist` 已放开 ATS 明文限制并声明了本地网络用途；首次连接时系统会弹「允许访问本地网络」，必须点允许，否则所有请求都会失败且没有提示。
- 其余与 APK 相同：界面随包版本走、协议默认 http。

### 安装到主屏幕（浏览器 / PWA）

可选，装完就是全屏、无地址栏。手机端「设置 → 安装到桌面」里直接给了入口：

- **Android / Chrome**：设置页点「安装到主屏幕」（弹系统安装框）；也可以走右上角菜单 →「添加到主屏幕」/「安装应用」
- **iOS / Safari**：Safari 没有安装接口，设置页会写明步骤 —— 分享 →「添加到主屏幕」

装完从桌面图标进入，直接落到手机端首页。已在独立窗口里运行时，设置页会显示「已安装」。

有新版本时页面底部会浮出一条「重启更新」：网关升级后新版本的界面已经下好，点一下切过去（不点也不影响当前使用，下次打开自然生效）。

> **为什么没有应用商店包**：手机端连的必然是**另一台机器上跑的网关**（网关要读那台机器的登录态、写它的配置文件，手机上跑不了）。它的本质是「远程访问一个 HTTP 服务」，浏览器已经是最合适的载体 —— 同源认证、免安装、跟着网关一起升级。PWA 形态额外给了全屏与主屏幕图标，观感与原生应用一致；APK / IPA 则是把同一份界面打进包里，换来独立图标与离线起界面。
>
> **Service Worker（离线外壳）只在 `https` 或 `localhost` 下生效**：局域网走的是 `http://<IP>`，浏览器不提供 SW，所以断网时手机端打不开。这是浏览器的安全限制，不是功能缺失 —— 正常使用时网关在线，不受影响。

### 能做什么、不能做什么

| 能做 | 不能做（请回桌面端） |
| --- | --- |
| 看报表、账号状态、余额、请求日志、运行日志 | 添加账号（扫码 / 粘贴令牌 / 导入登录态） |
| 启停账号、刷新凭证、删除账号 | 编辑账号的凭证、代理、限流规则 |
| 一键签到、看签到记录 | 逐项领取新手福利与套餐 |
| 查看、获取、启停上游模型，按 Key 分组选择自定义渠道模型；查看账号密钥详情 | 上游模型测试、思考等级与能力设置；修改账号凭证 |
| 复制网关 Key、启停 Key | 新建 Key、设置可用范围白名单 |
| 管理与测试 HTTP / SOCKS5 代理及订阅节点，同步 Clash Verge 端点，下载、导入和启停内核 | 新增、编辑、刷新代理订阅及导入订阅文件 |
| 启停定时任务、改间隔；创建、编辑、预演和管理路由组 | 改端口、全局重试、全局超时、数据保留 |
| 助手快捷查询（余额 / 重复模型 / 今日用量 / 限流账号） | 助手的自由对话与工具调用 |
| 查看 Agent 接管状态、还原 | 改写客户端配置（手机读不到本机文件） |

桌面端侧栏底部有「手机端打开」入口，点开即是同一个页面。
