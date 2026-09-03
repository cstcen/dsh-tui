---
name: dsh-tui-dev
description: dsh-tui 开发者技能：独立仓库 /Users/chester/Code/dsh-tui（GitHub cstcen/dsh-tui）的迭代开发知识——架构与红线、安装/刷新流程、冒烟清单、兼容性约束、进度记录。当任务涉及修改 dsh-tui 源码、安装/卸载/刷新 tui profile、排查 dsh --profile tui 问题、或记录迭代进度时使用。
version: 1.0.0
author: chester (cstcen)
license: MIT
metadata:
  dsh-tui:
    repo: git@github.com:cstcen/dsh-tui.git
    installedAs: '~/.dsh/profiles/tui (dsh-tui: github:cstcen/dsh-tui)'
    tags: [dsh, tui, cordis, plugin, repl]
---

# dsh-tui 开发者（dsh-tui-dev）

## 定位

dsh-tui 是**独立迭代**的 DeepSeek Harness 纯终端交互客户端（bundle 插件 + `tui` profile）。
不依赖 argent-dsh，但参考其插件供给模式。本文档是迭代时的上下文与红线速查。

## 核心入口

- **源码仓库**：`/Users/chester/Code/dsh-tui`（git，origin = `git@github.com:cstcen/dsh-tui.git`，private）
- **进度文档**：仓库内 `docs/ITERATION.md`（当前状态/版本历史/backlog——迭代前先读它）
- **运行副本**：`~/.dsh/profiles/tui/`（Path A 安装：`dependencies: dsh-tui: github:cstcen/dsh-tui`，跑的是 GitHub main，**不是**本地工作区）

## 红线（继承 dsh 全局规则 + 本项目特例）

1. **严禁重启本机 dsh web**（LaunchAgent com.whyshu.dsh-web）——当前会话就跑在里面；
2. **严禁升级/重装全局 dsh**——锁定 0.1.1-rc.1（flat-scope、197 子包）；dsh-tui 代码只对该版本线负责；
3. **严禁往 profile 装 `@deepseek-ai/*` registry 依赖**（混合版本断链红线）——包本身零 dependencies，运行期依赖由 dsh 安装闭包提供，peerDependencies 仅文档声明（不触发安装）；
4. **不要手拷代码进 `~/.dsh/profiles/tui/node_modules/`**——那是 pnpm 管理区，刷新走安装流程（见下）。

## 架构要点（改动前必读）

- **形态**：npm 包 + `package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml` 插入两行（`tui-startup` 解析 flags、`tui` 跑 REPL）；profile 的 bundles = `[@deepseek-ai/dsh-base, dsh-tui]`。与 headless/web 同级的"独立进程应用"，**不是**会话级 preset 插件。
- **文件**：`lib/startup.js`（--resume/--workspace → tuiStartup 服务）、`lib/index.js`（REPL 主体）、`scripts/install.mjs`（file: 本地安装器）、`skills/dsh-tui-dev/SKILL.md`、`docs/ITERATION.md`。
- **REPL 必须跑在活跃 fiber 里**：`agents.resume` 依赖 owner-lifecycle effect——`apply` 里用 `ctx.effect(async function* () { await run(...) })`（cordis effect 只能 yield disposer/nullable，所以 await 在生成器体内）。裸 fire-and-forget 会导致 resume 立刻 abort。
- **dispose 拆工厂（0.1.1 未修，workaround 保留）**：`handle.dispose()` 会沿 owner-fiber 链拆掉 agent-loop 的工厂注册，之后 `agents.create` 报 "no agent factory registered"。所以 `/new`、`/resume` 只换引用**不销毁旧 agent**；进程内二次 resume 同一 id 会显式报错（提示退出重启）。别"修复"成 dispose——会踩工厂问题。
- **事件流**：`ctx.on("session/event", (session, event) => …)` 渲染 `assistant/chunk`（text-delta 流式 / reasoning-delta 只打一次 `(thinking…)`）、`tool/call`、`tool/result`、`turn/end`。
- **surface prompt**：`apply` 里 `ctx.inject(["systemPrompt"], …)` + `systemPrompt.section({name: "app:tui-surface", …})`（镜像 web 的 app:web-surface）。
- **会话列表**：`ctx.sessionQuery.listSessions()`（records: `{header, live, persisted}` newest-first）+ `readTitleSnapshots(ids)`（返回 per-id `{status, value:{session, title}}`，title 是快照对象要取 `.title`）。
- **API 依赖**（均来自安装闭包，版本 0.1.1-rc.1）：`agents.create/resume`、`ctx.get("appExit")(code)`、`@deepseek-ai/dsh-llm` 的 `createUserMessage`、`@deepseek-ai/dsh-session` 的 `SessionId`、`schemastery`（schema 是 callable，用 `.default()` 不用 `.optional()`）。

## 安装 / 刷新 / 卸载

标准（Path A，任何机器一条命令；private 仓库需 SSH key）：

```bash
dsh plugin --profile tui add github:cstcen/dsh-tui      # 装 & 刷新（拉 GitHub main）
dsh plugin --profile tui remove dsh-tui                 # 卸载
DSH_HOME=~/.dsh-some-instance dsh plugin --profile tui add github:cstcen/dsh-tui  # 多实例
```

本地开发（Path B，file: 直连工作区，**不 push 也能试**）：

```bash
node scripts/install.mjs            # 刷新为 file: 依赖（含 manifest 规整：清 @deepseek-ai/* 依赖 + bundles 自检）
node scripts/install.mjs --check    # 附带冒烟
node scripts/install.mjs --uninstall
```

注意：Path B 会把 profile 依赖从 `github:` 切回 `file:`；需要回到标准态就再跑一次 Path A。

## 冒烟清单（改动后必跑）

```bash
node --check lib/index.js lib/startup.js
dsh --profile tui --help                                   # 装载/参数
printf '/help\n/exit\n' | dsh --profile tui                # REPL（不触达 LLM）
printf '/sessions\n/exit\n' | dsh --profile tui            # 会话列表（标题/cwd/时间）
printf '只回复两个字：OK\n' | dsh --profile tui             # 真实 LLM + 流式
printf '/sessions 3\n/resume #2\n/session\n/exit\n' | dsh --profile tui   # 快捷恢复链路
dsh --profile tui --resume <旧会话id>                       # 恢复 + 上下文记忆
```

## 迭代流程

1. 读 `docs/ITERATION.md` 了解当前状态与 backlog；
2. 改源码（保持红线与架构要点）；
3. `node --check` + Path B 本地刷新验证（可选 `--check` 冒烟）；
4. `git commit` + `git push origin main`；
5. 若机器装的是 Path A（github: 依赖），重跑 `dsh plugin --profile tui add github:cstcen/dsh-tui` 生效；
6. 更新 `docs/ITERATION.md`（状态/历史/backlog）与 `skills/dsh-tui-dev/SKILL.md`（如有架构变化），随代码一起提交。

## 已知限制（v0.2，迭代候选见 ITERATION.md backlog）

- 会话内切换不销毁旧 agent（dispose 拆工厂 workaround，见上）；
- reasoning 原文不显示（只打 `(thinking…)`）；
- 流式与输入行重绘朴素，长行可能错位；
- Ctrl+C 直接退出进程（boot 层 SIGINT），取消回合用 `/stop`；
- `/sessions` 全 home 会话混列（含 argent gateway `gw-*`），无 cwd 过滤。
