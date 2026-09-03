# dsh-tui

一个给 DeepSeek Harness (dsh) 用的**纯终端交互客户端**（bundle 插件 + `tui` profile）。

与 Web UI 共用同一套核心：同一个 agent 循环、同一套工具（bash/fs/子代理/工作流/目标……）、同一份模型与凭据配置、**同一个会话存储**（`$DSH_HOME/sessions`，jsonl.zstd）。在终端里创建/继续的会话，之后可以在 Web UI 里恢复，反之亦然（包括 argent gateway 的 `gw-*` 会话）。

不需要浏览器，不需要 Finder 弹窗——目录、路径全部用文本表达（会话工作目录 = 启动时的目录，或 `--workspace`）。

> 独立迭代仓库：本包不依赖 argent-dsh，但参考了 argent 的插件供给模式（`pnpm add file:` 装入 + 零 registry 依赖 + DSH_HOME 多实例感知）。兼容 dsh **0.1.1-rc.1**（锁定版本线）。

## 安装（正规化）

### 路径 A：官方 `dsh plugin` 流程（标准，任何机器一条命令）

```bash
dsh plugin --profile tui add github:cstcen/dsh-tui
```

- 自动初始化 profile、从 GitHub 安装、`bundles` 自动补齐为 `[dsh-base, dsh-tui]`；
- 仓库 **public**：任何机器免登录可装（无需 GitHub 账号/SSH key）；
- **更新**：重跑同一条命令（pnpm 会拉取最新 main）；
- 卸载：`dsh plugin --profile tui remove dsh-tui`；
- 多实例：`DSH_HOME=~/.dsh-some-instance dsh plugin --profile tui add github:cstcen/dsh-tui`。

### 路径 B：clone + 安装脚本（本地开发 / file: 依赖）

```bash
git clone git@github.com:cstcen/dsh-tui.git && cd dsh-tui
node scripts/install.mjs --check        # 装入默认 home；--check 附带冒烟
DSH_HOME=~/.dsh-some-instance node scripts/install.mjs
node scripts/install.mjs --uninstall
```

安装器（`scripts/install.mjs`）做什么：

1. 引导/规整 `$DSH_HOME/profiles/tui/package.json`：`dsh.profile.bundles = [@deepseek-ai/dsh-base, dsh-tui]`；
2. **清除 dependencies 里任何 `@deepseek-ai/*`**——dsh 子包必须解析自安装闭包（`$DSH_HOME/profiles/node_modules` 回退层），从 registry 装会产生混合版本/断链（dsh 全局红线）；
3. `pnpm add file:<本仓库>` 把包装入 profile（先删旧拷贝强制刷新源码更新）；
4. 自检 bundles + `--check` 冒烟。

**依赖策略**：包本身**零 dependencies**，运行期依赖（`@deepseek-ai/dsh-*`、`schemastery`、`commander`）全部由 dsh 安装闭包提供，仅在 `peerDependencies` 声明兼容版本（不会触发安装）。

**迭代开发**：标准流程 = 改源码 → `git push` → 重跑路径 A 命令刷新；改完想先本地验证（不 push）时用路径 B 的安装器（`file:` 依赖直连工作区）：

```bash
node --check lib/index.js
node scripts/install.mjs            # 本地 file: 刷新（路径 B）
dsh --profile tui --help
printf '/help\n/exit\n' | dsh --profile tui   # REPL 冒烟（不触达 LLM）
```

## 使用

```bash
dsh --profile tui                         # 在当前目录开新会话
dsh --profile tui --workspace ~/Code/x    # 指定会话工作目录
dsh --profile tui --resume session-7      # 恢复已持久化的会话
```

会话内命令：

| 命令 | 作用 |
|---|---|
| `/help` | 帮助 |
| `/new` | 开一个新会话 |
| `/sessions [n]` | 列出最近 n 个持久化/存活会话（默认 15，含自动标题、cwd、时间；`*` = 本进程存活） |
| `/resume <sessionId>` | 切换到持久化会话 |
| `/resume #<n>` | 切换到最后一次 `/sessions` 列表的第 n 条 |
| `/session` / `/cwd` | 显示当前会话 id / 工作目录 |
| `/stop` | 取消当前回合 |
| `/exit`（`/quit`、`/q`） | 退出（Ctrl+C / Ctrl+D 也可） |

其他输入会作为消息发给 agent。agent 忙碌时输入的文本会排队，在当前回合结束后依次回答。

远程场景：在远端机器 SSH 到本机后直接运行 `dsh --profile tui`，纯终端操作，不需要 Web UI 的目录选择器（那东西会弹 Mac 本机的 Finder）。

## 特性与实现

- **终端表面上下文（surface prompt）**：每个会话的 system prompt 注入 `app:tui-surface` 段（对齐 web 的 `app:web-surface` 做法），模型知道自己跑在终端 REPL 里（无浏览器、无目录选择器、路径用文本）。
- **流式输出**：订阅 `session/event` 火鹤流，实时渲染 `assistant/chunk`（文本流 + `(thinking…)` 提示）、`tool/call`、`tool/result`、`turn/end`（completed/aborted/error）。
- **会话持久化**：走 dsh-base 的 `session-persistence-jsonl`，与 Web UI 同一存储。
- **会话列表**：`/sessions` 走 0.1.1 的 `ctx.sessionQuery`（`listSessions` + `readTitleSnapshots`），newest-first、live/persisted 标记。
- **会话恢复**：`--resume` / `/resume` 通过 `agents.resume`（官方恢复路径，保留 cwd/seedLength 等 header 元数据）。
- **REPL**：`node:readline`，TTY 下显示 `tui>` 提示符；管道（非 TTY）模式下不写提示符，可脚本化。
- **退出**：`/exit` 或 EOF 通过 launcher 的 `appExit` 优雅关闭整棵树（有未完成回合时 EOF 会等回合结束再退出）。

## 已知限制（v0.2）

- 会话内切换（`/new`、`/resume`）**不销毁旧 agent**：`handle.dispose()` 会沿 owner-fiber 链把 agent-loop 的工厂注册一起拆掉（0.1.1 源码未修），导致后续 `agents.create` 失败，所以旧会话只是留在内存注册表里，随进程退出统一清理。进程内对同一 sessionId 二次 `/resume` 会给出明确报错（需退出重启）。
- `assistant/chunk` 的 `reasoning-delta` 只显示一次 `(thinking…)` 标记，不输出推理原文。
- 提示符与流式输出的重绘是朴素实现（输出后重新 `prompt()`），长行输入时可能短暂错位。
- Ctrl+C 会直接退出整个进程（boot 层安装的 SIGINT 处理），`/stop` 用于取消回合。
- `/sessions` 显示整个 home 的会话（含 argent gateway `gw-*`），目前不支持按 cwd 过滤。

## 结构

```
dsh-tui/
├── package.json          # dsh.bundle.patch → cordis.patch.yml；零依赖 + peer 声明
├── cordis.patch.yml      # bundle 层：插入 tui-startup + tui 两行
├── scripts/
│   └── install.mjs       # 正规化安装器（DSH_HOME 感知、pnpm file: 装入、--check/--uninstall）
└── lib/
    ├── startup.js        # 解析 --resume/--workspace，提供 tuiStartup 服务
    └── index.js          # REPL：会话创建/恢复、/sessions、事件流渲染、surface prompt
```

关键 API（均来自 dsh 发行版内部包，由安装闭包提供）：

- `ctx.on("session/event", (session, event) => …)` —— 实时事件流
- `ctx.sessionQuery.listSessions()` / `readTitleSnapshots(ids)` —— 会话列表与标题
- `agents.create({ sessionId, meta: { cwd }, agentOptions, setup })` —— 新会话
- `agents.resume({ resumeSessionId, agentOptions, setup })` —— 恢复（须在活跃 fiber 内调用，见 `apply` 里的 async-generator effect）
- `ctx.get("appExit")(code)` —— 优雅退出
- `ctx.inject(["systemPrompt"], …)` + `systemPrompt.section(...)` —— surface prompt 段
