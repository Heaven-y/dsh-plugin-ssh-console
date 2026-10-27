# dsh-plugin-ssh-console

[![npm](https://img.shields.io/npm/v/dsh-plugin-ssh-console.svg)](https://www.npmjs.com/package/dsh-plugin-ssh-console)
[![Test](https://github.com/Heaven-y/dsh-plugin-ssh-console/actions/workflows/test.yml/badge.svg)](https://github.com/Heaven-y/dsh-plugin-ssh-console/actions/workflows/test.yml)

**给 DeepSeek Harness 补一个「SSH 控制台」面板：连上远程服务器，只读看目录、像 nvitop 那样盯 CPU/GPU、并开一个真正的交互式终端。**

侧边栏新增一个图标（和「插件」「自动化」并排），点开是主区域整页。对话记录不受影响，点回对话就回去了。

多台服务器是**一排标签**：点哪个标签，下面四个页签（概览/进程/文件/终端）就只显示那一台。同一时刻只采样当前这一台。

```
┌ SSH 控制台                                    ● 2 台已连接 ┐
│ ● A100服务器 ×  │  ● 3号服务器 ×  │        [+ 连接其他]   │  ← 服务器标签
├ 概览 │ 进程 │ 文件 │ 终端 ──────────────────────────────┤  ← 页签
│ A100服务器   Linux 6.8.0 · yz@122.205.68.212:10007 · 3m  │
│  CPU 99.5% ▓▓▓▓  内存 884G/2.0T ▓▓▓  负载 2164  磁盘 38% │
│  #0 A100 100% 58°C ▓▓▓▓  27G/80G ▓▓  13 进程              │
│  #1 A100  95% 38°C …                                      │
└───────────────────────────────────────────────────────────┘
```

## 功能

- **多台并存，一次看一台**：可以同时保持多条连接（顶部标签条），点标签切换，四个页签都跟着当前标签走。每台独立连接、独立 CPU 基线；只有当前这台在轮询采样，其余不产生 SSH 往返。
- **概览**：每 2 秒采样当前主机。CPU（`/proc/stat` 两次差分算真实占用）、内存、负载、磁盘，以及每卡 GPU 的两条独立指标条——**利用率一条、显存一条**，各自贴在各自的数字下面。
- **进程**：两张表，都是真实数据而不是摘要。
  - **GPU 进程**：**按卡分组**，每张卡一个标题行（`#3  5 进程 · 63.8 GiB`），下面列 `GPU# / PID / 用户 / 显存 / 命令`。把 `nvidia-smi` 的裸 pid 通过 `/proc` 反查成「谁在跑、跑什么」。
  - **Top 进程**：`PID / 用户 / CPU% / 内存% / 常驻内存 / 线程数 / 运行时长 / 状态 / 完整命令行`。
  - 两张表的**命令行都是完整显示**，长命令自动换行，不省略、不截断（截断会丢掉解释器路径和脚本名，只剩下参数）。
  - GPU 进程**一条都不少**：`nvidia-smi` 的输出顺序是乱的，先排序再限制条数，不会因为截断把后面几张卡的进程整片丢掉。
- **文件**：**只读**浏览。`cd` + `stat` 列目录，点目录进入，点文本文件看开头预览（最多 256 KiB）。远端只执行 `cd` / `stat` / `head -c`，**不写、不删、不上传下载**。
- **连接其他服务器**：已连状态下点右上角按钮弹出**对话框**（Esc / 点遮罩可关），不再把下面的页签往下挤。只有在还没连任何服务器时，连接表单才占据页面本身。
- **终端**：**真正的远端 PTY**（`ssh2` 的 `shell()` 通道 + 内置 xterm.js 渲染）。提示符、颜色、行编辑、Tab 补全、`Ctrl-C`、`vim`/`htop`/`top` 全屏程序都能正常用；面板缩放会同步 `stty size`。
  - 点开「终端」页签**自动连上**，不需要再点一次按钮。
  - **同一台服务器可开多个终端**（上限 6 个）。每个都是独立登录：各自的 `cd`、环境变量、滚动缓冲、窗口尺寸互不影响。顶部标签条列出全部终端，点一下切到哪个窗格；`+ 新建` 再开一个。
  - **分屏**：`◫` 左右分屏、`⬒` 上下分屏，两格各跑一个终端；`取消分屏` 只收起布局，终端不关。「关闭终端」才真正结束。
  - **会话保留**：切页签、切服务器、切分屏、甚至关掉面板再打开，回来的还是同一个 shell——`cd` 的目录、导出的环境变量、跑着的命令都还在；重新打开面板时会向宿主查询仍在的终端并接回去。
  - 参考了 [Pebrel](https://github.com/Kuddev/pebrel) 那种「真终端 + SSH」的形态——它是整套 Rust/GPUI 应用（自身渲染器、分屏、SFTP），不能嵌进网页，所以这里只取它最关键的形态：真 PTY + 分屏，而不是把命令当文本跑。
  - **分屏的代价**（实测）：900px 宽的面板左右分屏后每格约 **55 列**，上下分屏约 **116×9 行**。行数少于 10 时 `htop` 之类会显得挤，建议宽屏再分。

## 服务器清单

自动读 `~/.ssh/config`，无需配置就能看到你已声明的 Host。也可以在 `cordis.patch.yml` 里追加：

```yaml
- id: ssh-console
  name: 'dsh-plugin-ssh-console'
  config:
    refreshMs: 2000
    execTimeoutMs: 60000
    includeSshConfig: true
    servers:
      - label: 实验室 B 机
        host: 10.0.0.21
        port: 22
        user: yz
        identityFile: ~/.ssh/id_rsa_lab
```

## 认证

1. **默认**：`~/.ssh` 下的私钥（`id_ed25519` / `id_rsa` / `id_ecdsa`），或 ssh-agent（Windows 命名管道 `\\.\pipe\openssh-ssh-agent`）。
2. **密码**：界面上那个可选输入框。密码只存在 Harness 宿主进程内存里，**不写盘、不进 config、不进日志**，断开即丢。
3. 私钥由宿主进程读取，浏览器永远拿不到密钥内容。

## 安全边界

| 面 | 边界 |
|---|---|
| 目录浏览 | 只读，远端只跑 `cd` / `stat` / `head -c` |
| 文件预览 | 只读，只取开头一小段 |
| 终端 | **自由执行**，等同你本人 `ssh` 登录（刻意如此，否则跑不了训练和改文件） |
| 密码 | 仅内存，断开即丢 |
| 连接 | 每台服务器一条常驻连接，可同时连多台；断开某一台只影响那一台 |
| 终端回滚 | 宿主侧最多保留 512 KiB，超出丢最旧的，客户端会收到重置标记 |

## 已知限制

- 需要远端是 **GNU coreutils**（`stat -c`）。老 BSD/macOS 服务器上目录浏览会明确报错而不是乱猜。
- GPU 依赖 `nvidia-smi`；没有 NVIDIA 卡时概览显示「未检测到 NVIDIA GPU」，其余指标照常。
- CPU 百分比需要两次采样；刚连上的首帧已预置基线，通常直接有值。
- 终端输出是**短轮询**（约 120 ms 一次）而不是流式推送，所以按键回显有约一个轮询间隔的延迟；可正常用于全屏程序，但不如本地终端跟手。
- 不提供 SFTP 上传/下载、跳板机、端口转发。

## 安装

### 桌面端（DeepSeek Harness App）

**设置 → 插件 → 添加插件**，输入包名：

```
dsh-plugin-ssh-console
```

也可以直接填版本 `dsh-plugin-ssh-console@1.0.0`。

装完**完全退出 App 再打开**（Host 半与客户端 chunk 都变了，HMR 不重载插件 JS）。

> ⚠️ 桌面端的 profile 不能走 CLI 安装（DSH 对 `desktop` profile 做了排他保护），请走上面的「设置 → 插件」。

### Web / CLI profile

```sh
dsh plugin --profile <profile> add dsh-plugin-ssh-console
```

也可以直接从 GitHub 装（会锁定到具体 commit）：

```sh
dsh plugin --profile <profile> add github:Heaven-y/dsh-plugin-ssh-console
```

## 开发

```sh
npm ci                         # 装依赖（含构建 client.xterm.js 所需的 @xterm/*）
npm run build                  # 重新生成 client.xterm.js（内嵌的 xterm 渲染器）
npm test                       # 三套测试：Host 真机 / Client 结构 / 分屏状态机
```

也可以单独跑：

```sh
node test/host.test.mjs        # Host 半：真机 24 项（连不上就跳过网络部分）
node test/client.test.mjs      # Client 半：结构 13 项
node test/panes.test.mjs       # 分屏状态机：3 项
```

`client.xterm.js` 是**生成文件但提交进仓库**——这样包不需要构建步骤就能用。CI 会重新构建并逐字节比对，提交的不是最新构建就直接失败。内嵌的 `@xterm/xterm` 与 `@xterm/addon-fit` 均为 MIT，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 发布

发版只有一条命令，前提是工作区干净且在 `main` 上：

```sh
npm run release patch        # 或 minor / major / 1.2.3
npm run release minor --dry-run   # 只看会做什么，不打标签
```

它会**先跑完三套测试**，再 `npm version` 同时改版本号、提交、打 `v*` 标签，然后推送。标签一推，[`.github/workflows/publish.yml`](.github/workflows/publish.yml) 就会：

1. 校验仓库里的 `client.xterm.js` 就是当前源码的构建产物；
2. 再跑一遍 `npm test`；
3. `npm publish --provenance`；
4. 用该标签创建 GitHub Release。

所以「发版 = 推一个标签」，没有第二步会忘，也没有凭据落在本地。

**鉴权用哪条路：**

| 场景 | 做法 |
|---|---|
| 首次发布（包还不存在） | 必须用 token：仓库 Secrets 里加 `NPM_TOKEN` |
| 之后（推荐） | 在 npmjs.com 把本仓库配成该包的 **Trusted Publisher**，然后**删掉** `NPM_TOKEN` secret |

token 删掉后 workflow 会自动回落到 OIDC；它那条 `npm config delete` 就是为这个切换准备的。走 OIDC 时仓库里没有任何 npm 凭据可以泄漏或轮换。

## 验证状态

- **Host 半 24 项真机测试**：目录清单、`~` 展开、缺目录报错、CPU/GPU/内存采样、进程行的 rss/线程/时长字段、GPU 进程归属（uid → 命令）、**56 条 GPU 进程一条不少且按卡分组**、命令退出码、文件预览、超时中断、**PTY 的 ANSI/真 `/dev/pts`/窗格尺寸**、**resize 同步**、**全屏程序可跑**、**重开终端复用同一个 shell**、**同一条连接上两个独立 PTY（`t1` 在 `/tmp`、`t2` 在 `/var`，环境与尺寸互不影响）**、**未指定 termId 时明确拒绝而不是瞎猜**、**关一个不影响另一个**、关全部后拒绝写入、双机并行、断开清理。实测 `yz@122.205.68.212:10007`（5×A100）与 `yz@211.69.141.69:26518`。
- **Client 半 13 项结构测试**：工厂导出、内嵌 chunk 注册与导出面、14 个 descriptor 与 Host 签名逐字对齐、侧边栏与主面板同 id、中英词典对称、样式仅用主题 token、缺少 Remote 载体时明确失败、**概览/进程页只渲染当前选中的那台**、**每张 GPU 卡两根条各自跟自己的指标**、**连接表单是弹窗**、**命令行完整不截断**、**终端自动打开、可新建/分屏/取消分屏且切页不销毁**、**一个窗格只挂一个 xterm 实例（并发 open 不再叠画布、不重复发送按键）**。
- **已用无头 Chrome 实测**：
  - **GPU 进程表用真机数据整表渲染**：55 条进程、5 个分组标题全部出现，命令格 0 个被裁切，表格与页面零横向溢出。
  - 另塞入真实的 224 字符训练命令，在 900 / 1420px 下命令格 `clippedX/Y` 全为 `false`，长命令换到 3 行完整显示。
  - GPU 卡在 680 / 820 / 1000 / 1420px 四种宽度下**零文字截断、零横向溢出**；故意塞进 50 字长卡名，验证是换行而不是省略号。
  - 八根指标条读回 DOM 量宽度：`#1` 利用率 100% → 209px、显存 68.2% → 142.6px（轨道 209px），与数字全部吻合（误差 < 0.5%）。浅色与深色两套令牌都渲过。
  - 真 xterm 在 820px 面板里算出 **106 列 × 38 行**、容器有实际尺寸（514px 高），不会因为容器塌陷把 PTY 缩到最小。
  - **分屏布局实测**（900×620 面板）：左右分屏每格 **55 列 × 24 行**（416×316px）、上下分屏每格 **116 列 × 9 行**（842×143px），两格都能正常显示提示符。
- **未验证**：真实 Harness 面板里的键盘输入手感（需要浏览器控制权）。
