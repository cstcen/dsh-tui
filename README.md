# dsh-tui

一个给 DeepSeek Harness (dsh) 用的**纯终端交互客户端**（bundle 插件 + `tui` profile）。

与 Web UI 共用同一套核心：同一个 agent 循环、同一套工具（bash/fs/子代理/工作流/目标……）、同一份模型与凭据配置、**同一个会话存储**（`$DSH_HOME/sessions`，jsonl.zstd）。在终端里创建/继续的会话，之后可以在 Web UI 里恢复，反之亦然。

不需要浏览器，不需要 Finder 弹窗——目录、路径全部用文本表达（会话工作目录 = 启动时的目录，或 `--workspace`）。

## 安装（已在本机完成）

```
~/.dsh/profiles/tui/
├── package.json            # bundles: ["@deepseek-ai/dsh-base", "dsh-tui"]
├── cordis.patch.yml        # 用户层（可留空）
├── pnpm-workspace.yaml
└── node_modules/dsh-tui/   # 插件（工作区 /Users/chester/Code/dsh-tui 的副本）
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
| `/resume <sessionId>` | 切换到磁盘上的持久化会话 |
| `/session` / `/cwd` | 显示当前会话 id / 工作目录 |
| `/stop` | 取消当前回合 |
| `/exit`（`/quit`、`/q`） | 退出（Ctrl+C / Ctrl+D 也可） |

其他输入会作为消息发给 agent。agent 忙碌时输入的文本会排队，在当前回合结束后依次回答。

远程场景：在远端机器 SSH 到本机后直接运行 `dsh --profile tui`，纯终端操作，不需要 Web UI 的目录选择器（那东西会弹 Mac 本机的 Finder）。

## 特性与实现

- **流式输出**：订阅 `session/event` 火鹤流，实时渲染 `assistant/chunk`（文本流 + `(thinking…)` 提示）、`tool/call`、`tool/result`、`turn/end`（completed/aborted/error）。
- **会话持久化**：走 dsh-base 自带的 `session-persistence-jsonl`，与 Web UI 同一存储。
- **会话恢复**：`--resume` / `/resume` 通过 `agents.resume`（官方恢复路径，保留 cwd/seedLength 等 header 元数据）。
- **REPL**：`node:readline`，TTY 下显示 `tui>` 提示符；管道（非 TTY）模式下不写提示符，可脚本化。
- **退出**：`/exit` 或 EOF 通过 launcher 的 `appExit` 优雅关闭整棵树（有未完成回合时 EOF 会等回合结束再退出）。

## 已知限制（v0.1）

- 会话内切换（`/new`、`/resume`）**不销毁旧 agent**：`handle.dispose()` 会沿 owner-fiber 链把 agent-loop 的工厂注册一起拆掉，导致后续 `agents.create` 失败，所以旧会话只是留在内存注册表里，随进程退出统一清理。进程内对同一 sessionId 二次 `/resume` 会给出明确报错（需退出重启）。
- `assistant/chunk` 的 `reasoning-delta` 只显示一次 `(thinking…)` 标记，不输出推理原文。
- 提示符与流式输出的重绘是朴素实现（输出后重新 `prompt()`），长行输入时可能短暂错位。
- Ctrl+C 会直接退出整个进程（boot 层安装的 SIGINT 处理），`/stop` 用于取消回合。

## 开发与迭代

源码在 `/Users/chester/Code/dsh-tui/`（工作区），profile 里是拷贝。改完源码后同步并冒烟：

```bash
node --check /Users/chester/Code/dsh-tui/lib/index.js
cp -R /Users/chester/Code/dsh-tui/. ~/.dsh/profiles/tui/node_modules/dsh-tui/
dsh --profile tui --help                      # 语法/装载
printf '/help\n/exit\n' | dsh --profile tui   # REPL 冒烟（不触达 LLM）
```

## 结构

```
dsh-tui/
├── package.json          # dsh.bundle.patch → cordis.patch.yml
├── cordis.patch.yml      # bundle 层：插入 tui-startup + tui 两行
└── lib/
    ├── startup.js        # 解析 --resume/--workspace，提供 tuiStartup 服务
    └── index.js          # REPL：会话创建/恢复、事件流渲染、命令
```

关键 API（均来自 dsh 发行版内部包）：

- `ctx.on("session/event", (session, event) => …)` —— 实时事件流
- `agents.create({ sessionId, meta: { cwd }, agentOptions, setup })` —— 新会话
- `agents.resume({ resumeSessionId, agentOptions, setup })` —— 恢复（须在活跃 fiber 内调用，见 `apply` 里的 async-generator effect）
- `ctx.get("appExit")(code)` —— 优雅退出
