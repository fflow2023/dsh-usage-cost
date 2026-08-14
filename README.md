# dsh-usage-cost

一个轻量的 DeepSeek Harness 插件：**会话级 + 全局的 API 费用统计**。

## 它是什么 

一个只读的费用估算器，把「当前会话累计花了多少钱」并进底部那行 token 统计，再给设置页加一个「全局累计费用」面板。

核心实现只有一件事：**一个 session projection 单元**，在既有的 `session/event` 回放驱动上做 O(1) 折叠。所有数字都从持久会话日志重放得出——重启、冷读都能恢复，每个会话各自独立累计。

## 功能

1. **会话底部（与 token 统计同一行）**：`… 输入/输出 token | 费用 ¥x.xx（高峰 ¥p / 闲时 ¥o）`
2. **设置 → 费用统计**：全局累计费用、高峰/闲时拆分、按模型（V4 Pro / V4 Flash）拆分、按会话降序列表。

## 安装

在 `cordis.yml` 的 host 组合与 web 组合里各挂一行（包名以你的实际 scope 为准）：

```yaml
# host 组合（提供 usageCost 投影）
- name: dsh-usage-cost
# web 组合（提供底部费用行 + 设置页入口）
- name: dsh-usage-cost/client
```

或使用 `dsh add` 安装后重建 web 包。client 半部分需要打进 web bundle，改完后需重新构建前端产物。

## 计费规则

单位：元 / 百万 tokens，按 **2026-08-17 00:00（北京时间）生效**的峰谷价。来源：[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/quick_start/pricing/)。

| 模型 | 时段 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
|---|---|---|---|---|
| deepseek-v4-flash | 空闲 | 0.05 | 1.5 | 4.5 |
| | 高峰 | 0.10 | 3.0 | 9.0 |
| deepseek-v4-pro | 空闲 | 0.15 | 4.5 | 13.5 |
| | 高峰 | 0.30 | 9.0 | 27.0 |

- **高峰时段**：北京时间 9:00–12:00、14:00–18:00；其余为**空闲**（高峰的一半）。
- 高峰/闲时按每次请求的 `request/header` 时间戳（UTC+8）判定。
- token 口径：`cacheReadTokens` → 缓存命中；`inputTokens` → 缓存未命中（DeepSeek 的 `prompt_tokens` 已减去命中量）；`outputTokens` → 输出；DeepSeek 不报告 cache-write，按 0。
- 只对 `deepseek-v4-pro` 与 `deepseek-v4-flash` 计费；其它模型计入 `unpricedTokens`，**不**静默按错价。

### 涨价后如何更新

所有价格集中在 [`src/pricing.ts`](src/pricing.ts) 的 `PRICES` 一处。价格变动时只改这一个文件、bump 版本号即可，无需改其它代码。

## 轻量设计

- Host：1 个 projection 单元，每个事件 O(1)，无额外订阅/定时器/RPC/持久化。
- Client：2 个 slot 注册，无 store、无副作用、无本地状态。
- 依赖仅 `zod`（schema 校验）+ 必要的 `@deepseek-ai/dsh-*` peer。

## Model Experience

### Request context and condition

#### What the model sees

本插件不向模型注入任何提示、schema、工具或消息。

#### Token effect

零直接 token 影响（只读投影）。

#### KV Cache effect

不影响请求前缀，不使缓存失效。

## License

[MIT](LICENSE)
