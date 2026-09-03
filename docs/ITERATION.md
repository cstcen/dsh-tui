# dsh-tui 迭代进度

> 本文件是 dsh-tui 的进度记录：**迭代前先读这里**，改动完成后更新「当前状态」并追加历史。
> 配套技能：`skills/dsh-tui-dev/SKILL.md`（架构红线 + 冒烟清单，装到 `~/.dsh/skills/dsh-tui-dev/` 后每个会话可用）。

- 仓库：`/Users/chester/Code/dsh-tui` → GitHub `cstcen/dsh-tui`（public，免登录安装）
- 兼容线：dsh **0.1.1-rc.1**（本机锁定版本，flat-scope / 197 子包）
- 定位：独立迭代的 dsh 纯终端客户端（bundle 插件 + `tui` profile），不依赖 argent-dsh，参考其插件供给模式

## 当前状态 — v0.2.0（2026-09-03）

### 功能
- REPL：TTY 下 `tui>` 提示符；管道（非 TTY）可脚本化；忙碌时输入排队
- 流式输出：`session/event` 渲染文本流、`(thinking…)` 标记、tool 行、turn 结果
- 会话持久化/恢复：`--resume`、`/resume <id>`、`/resume #<n>`（官方 `agents.resume`，保留 header 元数据）
- `/sessions [n]`：经 `ctx.sessionQuery` 列持久化/存活会话（自动标题、cwd、时间、`*` 存活标记）
- surface prompt `app:tui-surface`：模型知道自己在终端 REPL（实测生效）
- 会话与 Web UI / argent gateway 会话互通（同一 `$DSH_HOME/sessions` 存储）

### 安装状态（本机）
- `~/.dsh/profiles/tui/`：Path A 安装（`dsh-tui: github:cstcen/dsh-tui`，v0.2.0），bundles `[dsh-base, dsh-tui]`
- 多实例：`DSH_HOME=<home> dsh plugin --profile tui add github:cstcen/dsh-tui`

### 已验证（0.1.1-rc.1）
- 命令冒烟 / 真实 LLM 流式 / `/sessions` 标题 / `/resume #n` 链路 / surface prompt / 会话自动标题

### 已知限制（保留项）
- 会话内切换不销毁旧 agent（dispose 拆工厂 workaround，0.1.1 未修）
- reasoning 原文不显示；流式重绘朴素；Ctrl+C 直接退出（用 `/stop` 取消）；`/sessions` 无 cwd 过滤

## 版本历史

### v0.2.0（2026-09-03）
- **安装正规化**：`scripts/install.mjs`（DSH_HOME 感知、manifest 规整清 `@deepseek-ai/*` 依赖、pnpm `file:` 装入、--check/--uninstall）；随后定为 Path A（`dsh plugin --profile tui add github:cstcen/dsh-tui`）为标准安装，install.mjs 为本地开发路径
- **零依赖策略**：dependencies 清空 → 运行期依赖全部由 dsh 安装闭包提供；peerDependencies 文档化 0.1.1-rc.1 线（实测 pnpm 会从 registry 解析旧声明 → 失败/混合版本风险）
- **功能**：`/sessions`（sessionQuery + 标题 + `#n` 快捷恢复）；`app:tui-surface` surface prompt
- **文档**：README 重写（安装/迭代/卸载）；本进度文件；`skills/dsh-tui-dev/SKILL.md`
- commit：`e7fecc9`（功能）、`833d04a`（README Path A 标准化）

### v0.1.0（2026-08-17）
- 首版 REPL：会话创建/恢复、流式渲染、命令（/help /new /resume /session /cwd /stop /exit）
- 关键决策（沿用至今）：REPL 跑在 async-generator effect（resume 需活跃 fiber）；dispose 拆工厂 workaround；插件必须真实拷贝进 profile（软链接解析不到安装闭包）
- commit：`b192f5e`

## Backlog（候选迭代项，按优先级）

- [ ] `/model` 切换命令（读 `agentDefaultModel` 的候选集，session 级覆盖）
- [ ] reasoning 原文显示开关（`/reasoning on|off`）
- [ ] Ctrl+C 语义：空闲退出 / 运行中取消当前回合
- [ ] `/sessions` 按 cwd 过滤（`/sessions --cwd <dir>`）
- [ ] `npm publish` 发布（需确认 npm 账号；发布后任意机器 `dsh plugin --profile tui add dsh-tui`）
- [ ] 会话删除/归档命令（`/rm <id>`，谨慎：需走官方删除 API）
- [ ] 安装器集成 skill 同步（install.mjs 把 `skills/*` 拷到 `$DSH_HOME/skills/`）
- [ ] 提示符/流式重绘改进（长行输入不错位）

## 迭代节奏速览

```bash
# 改 → 本地验证（不 push）
node --check lib/index.js
node scripts/install.mjs && printf '/help\n/exit\n' | dsh --profile tui
# 发布
git commit -m "..." && git push origin main
dsh plugin --profile tui add github:cstcen/dsh-tui   # Path A 刷新（装 github: 依赖的机器）
# 收尾
# 更新本文件 + SKILL.md，随代码提交
```
