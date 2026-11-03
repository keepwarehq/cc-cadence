# ccprofile

自用 VS Code 扩展：一个聊天面板，在 Claude（Max 订阅）和你自己买的其他模型之间切换。

- **Claude 档**（内置）：直接启动本机的 `claude -p`，用它自己 `/login` 的 Max 订阅。扩展不读、不存、不转发 Claude 的 token。
- **其他模型**：在面板里填 Base URL 和 API Key。也是启动同一个 `claude -p`，只是带上 `ANTHROPIC_BASE_URL` 和 Key，所以所有模型都能读写文件、跑命令。Base URL 要填服务商的 **Anthropic 兼容地址**。
- 默认权限模式是 `bypassPermissions`：工具调用不再询问。只在受信任的工作区启用；没打开文件夹时拒绝运行。

## 用法

1. 先在终端里用 `claude` 执行 `/login`，登录 Max（只需要一次）。
2. 点左侧活动栏的 ccprofile 图标，打开「对话」面板。
3. 顶部第一个下拉框选模型：
   - 「＋ 添加模型…」：依次填名称、Base URL、API Key、模型名（可留空）。
   - 「管理模型…」：改 Base URL、换 Key、改模型名、重命名、删除。
4. 第二个下拉框是权限模式，可以临时切到 `plan` 只读。
5. 对话中途可以换模型：下一条消息用新模型，并用 `--resume` 接着同一个会话。

右下角状态栏显示当前模型，点击可切换。命令面板里有「ccprofile: 自检」，切换不生效时用它查原因。

## 工作方式

每发一条消息，启动一次：

```
claude -p --output-format stream-json --verbose --include-partial-messages \
       --permission-mode <模式> [--resume <session>] [--model <模型>]
```

- 消息从 stdin 写入，事件从 stdout 逐行读出。
- 工作目录是当前打开的第一个文件夹。
- 启动前先去掉进程环境里所有 `ANTHROPIC_*`、`CLAUDE_CODE_*` 变量，避免它们抢在 Max 订阅前面被用来认证。
- 第三方档再加上：
  - `ANTHROPIC_BASE_URL`
  - Key：默认放进 `ANTHROPIC_AUTH_TOKEN`，可以改成 `ANTHROPIC_API_KEY`
  - 模型名：同时映射到 `ANTHROPIC_MODEL` 和 opus / sonnet / haiku 三个别名

每轮开始后，状态行会显示认证来源。Claude 档如果不是「Max 订阅」，会给出警告。

### 注意

- `~/.claude/settings.json` 或项目 `.claude/settings*.json` 的 `env` 里如果有 `ANTHROPIC_*`，它们比进程环境优先，扩展去不掉，所有档位都会受影响。「自检」会检查这一项。
- 跨模型续接同一个会话（比如 Claude 聊到一半切到别的模型）时，整段历史都会发给新模型，对方不一定接受。如果报错，点「新对话」。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `ccprofile.claudePath` | `~/.local/bin/claude` | claude CLI 路径 |
| `ccprofile.defaultPermissionMode` | `bypassPermissions` | 每个窗口打开时的权限模式 |
| `ccprofile.profiles` | `[]` | 其他模型档位（Key 不在这里，在系统钥匙串） |

高级写法（在 settings.json 里）：

```jsonc
"ccprofile.profiles": [
  { "id": "claude", "model": "opus" },                 // 覆盖内置 Claude 档
  { "id": "claude-sonnet", "label": "Claude Sonnet", "model": "sonnet" },  // 不填 baseUrl = 也是 Claude 订阅
  {
    "id": "my-model", "label": "我的模型",
    "baseUrl": "<Anthropic 兼容地址>",
    "authEnv": "ANTHROPIC_AUTH_TOKEN",
    "models": { "opus": "<模型名>", "sonnet": "<模型名>", "haiku": "<模型名>" },
    "env": { "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1" }
  }
]
```

## 开发

```bash
npm install
npm test          # 编译 + 离线测试（回放真实事件、jsdom 跑 webview）
npm run smoke     # 真调本机 claude 跑两轮，会用一点订阅额度
npm run package   # 打包成 ccprofile-0.0.1.vsix
code --install-extension ccprofile-0.0.1.vsix
```

按 F5 会打开扩展开发窗口，工作区是 `sandbox/`。bypass 模式下在里面随便试，不会动到别的目录。
