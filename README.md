# r2c-proxy

> 轻量级代理：将 OpenAI Responses API 转换为 Chat Completions API，支持 Anthropic Messages API 透传

## 为什么需要这个？

仅支持 OpenAI Responses API 协议的 AI Agent 工具（如 Codex、OpenCode 等），无法直接接入仅支持 Chat Completions API 的国内大模型。

这个代理就是桥梁：

- **Responses API → Chat Completions API**：完整转换，让 Codex、OpenCode 等工具接入国内大模型
- **Anthropic Messages API 透传**：让 Claude Code 等工具接入已支持 Anthropic 协议的国内大模型

## 快速开始

### 环境要求

- Node.js >= 18
- 支持 Windows、macOS、Linux

### 下载

```bash
git clone https://github.com/Herger58/r2c-proxy.git
cd r2c-proxy
```

### 配置

编辑 `config.json`：

```json
{
  "port": 8788,
  "base_url": "https://your-api-endpoint/v1",
  "anthropic_base_url": "https://your-api-endpoint/anthropic",
  "api_key": "your-api-key",
  "default_model": "your-model",
  "multimodal_model": "your-multimodal-model"
}
```

**配置说明：**

| 字段 | 说明 | 示例 |
|------|------|------|
| `port` | 代理监听端口 | `8788` |
| `base_url` | Chat Completions API 地址 | `https://api.moonshot.cn/v1` |
| `anthropic_base_url` | Anthropic Messages API 地址（透传用） | `https://api.deepseek.com/anthropic` |
| `api_key` | API 密钥 | `sk-xxx` |
| `default_model` | 默认模型名 | `gpt-4o` |
| `multimodal_model` | 多模态模型名（支持图片时自动切换） | `gpt-4o-mini` |

### 启动

**Windows：**

```bash
# 方式一：直接启动
node server.js

# 方式二：后台启动
start.bat

# 方式三：静默后台启动（无窗口）
start.vbs

# 停止
stop.bat
```

**macOS / Linux：**

```bash
# 直接启动
node server.js

# 后台启动
nohup node server.js &

# 停止
pkill -f "node server.js"
```

启动后会显示：

```
[r2c-proxy] listening on http://127.0.0.1:8788
[r2c-proxy] forwarding to https://your-api-endpoint/v1/chat/completions
[r2c-proxy] API key: configured
```

## 使用方法

将 AI Agent 的 API Base URL 指向本代理即可。

### 配合 Codex 使用

```bash
# 设置环境变量
export OPENAI_BASE_URL=http://127.0.0.1:8788/v1
export OPENAI_API_KEY=your-api-key

# 启动 Codex
codex
```

### 配合 OpenCode 使用

在 OpenCode 设置中，将 API Base URL 设置为：

```
http://127.0.0.1:8788
```

### 配合 Claude Code 使用

```bash
# 设置环境变量
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788

# 启动 Claude Code
claude
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/responses` | POST | Responses API（转换为 Chat Completions） |
| `/v1/messages` | POST | Anthropic Messages API（透传） |
| `/health` | GET | 健康检查 |

## 功能特性

- **Responses API → Chat Completions API**：完整的请求格式转换
- **Anthropic Messages API 透传**：直接代理到支持 Anthropic 协议的厂商
- **流式输出**：SSE 流式支持
- **工具调用**：函数/工具调用格式转换
- **推理内容**：thinking/reasoning 内容保留
- **多模态**：图片输入支持（需模型支持）
- **local_shell 转换**：自动将 local_shell 工具转换为 shell 函数

## 日志

运行日志保存在 `proxy.log`，可用于排查问题。

## 许可证

MIT
