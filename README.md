# dsh-live-token-speed

给 DSH Web GUI 输入框底部统计条换一个**实时**输出速度。

内置 `ActivityPill`（`@deepseek-ai/dsh-client-ui-chat`）显示的是
`decodeTokens / decodeMs` —— 整个会话的**平均**解码速度，跑到后面几乎不动，
看不出当前这一刻模型快还是慢。

本插件以同一个单元格 id（`activity`）注册进 `conversation.composer.dock`，
替换内置实现：

| 状态 | 显示 |
| --- | --- |
| 流式输出中 | 最近 **2 秒**滑动窗口的实时 tok/s（约 10Hz 刷新） |
| 刚结束一步 | 该步的平均 tok/s |
| 空闲/历史 | 该步平均；点开浮层还能看到会话平均 |

浮层（点统计条打开）对比三个数字：**实时 / 本步平均 / 会话平均**，外加模型用时、
工具用时、平均 TTFT。

## 安装

本机（开发机，直接链本地目录）：

```powershell
dsh plugin --profile desktop add "E:/随便玩玩dsh/live-token-speed"
```

多机/平板（从 GitHub 拉取，本仓库为 public，无需凭据）：

```powershell
# 装最新 main
dsh plugin --profile <你的profile> add github:WeidongTech/dsh-live-token-speed

# 或锁定到某个发布版本
dsh plugin --profile <你的profile> add github:WeidongTech/dsh-live-token-speed#v0.1.1
```

更新（平板同理）：

```powershell
dsh plugin --profile <你的profile> update dsh-live-token-speed
# 若 pnpm 没解析到新提交，重新 add 一次即可
```

装完**重启 DSH**（宿主启动时才组装插件树，重启后客户端半才会被加载）。

> 电脑上改完这个插件后：改 `package.json` 的 `version` → `git commit` → `git push`（可选再打 tag），平板执行上面的 update 即可拿到新版本。本机 profile 用的是 `link:` 本地目录，改完重启 DSH 就生效，不需要经过 GitHub；GitHub 只作为平板的发布渠道。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-live-token-speed
```

## 实时值怎么来的

`assistant/live-chunk` 事件逐帧驱动 chat 快照里的 `legacy.partial`（尚未 settle 的
assistant-step，携带正在增长的 `blocks`）。插件：

1. 渲染时把 `blocks` 里的文本按密度折算成 token 累计数（CJK ≈ 1 字 1 token，
   其余 4 字 1 token，与 `dsh-token-meter` 的启发式一致），并做前缀增量缓存；
2. `requestAnimationFrame` 循环把（时刻，累计 token）压入环形缓冲；
3. 取窗口内最早样本作基线，`Δtoken / Δt` 即实时速度；没有新 token 时窗口右移，
   读数自然衰减到 0；
4. `turn:step` 变化时清零缓存，避免跨步算出负速度。

## 可调参数

`client.js` 顶部：

| 常量 | 默认 | 含义 |
| --- | --- | --- |
| `WINDOW_MS` | `2000` | 滑动窗口长度，越小越跟手、越大越平滑 |
| `MIN_SPAN_MS` | `150` | 窗口跨度下限，不足则先不出数 |
| `EMIT_MS` | `100` | 刷新节流（10Hz） |
| `CHARS_PER_TOKEN` | `4` | 非 CJK 文本密度 |

改完重启 DSH 生效。

## 结构

```
live-token-speed/
├── package.json        # dsh.bundle.patch + dsh.client
├── cordis.patch.yml    # insert 一行把插件挂进 profile
├── index.js            # Host 半：空实现（功能全在浏览器）
└── client.js           # Client 半：替换 activity 单元格
```

## License

MIT
