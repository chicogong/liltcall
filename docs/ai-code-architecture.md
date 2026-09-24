# LiltCall 代码架构：真人通话与私有 AI 语音

[查看架构图 PNG](diagrams/ai-streaming-architecture.png) · [编辑 Excalidraw 源图](diagrams/ai-streaming-architecture.excalidraw)

![真人通话与私有 AI 流式语音架构](diagrams/ai-streaming-architecture.png)

## 两条路径，不混用房间

真人 1:1 音视频仍由 `apps/web` 的浏览器页面、`apps/edge` 的 Worker/Room Durable Object 和自托管 TURN 组成。Worker 处理房间成员、信令和短期 TURN 凭据；媒体由 WebRTC 选择直连或 TURN 中转。AI 服务**不在**这个房间里，也不会自动接收真人通话的音频。

私有 1 人 + AI 原型由浏览器的独立 `/ai.html` 显式启动。浏览器与 `apps/ai/server.py` 中的 Pipecat SmallWebRTC 服务建立音频连接；AI 进程是另一个 WebRTC 端点，不需要为这个 1:1 模式引入 SFU。该服务仅接受回环来源，暂未公开部署。远端私有测试使用受控隧道承载信令，并为媒体单独配置短期 ICE/TURN 凭据；隧道不是公网 AI 接入方案。

## AI 服务的模块边界

| 模块 | 职责 |
|---|---|
| `server.py`、`private_ice.py` | 服务生命周期、单连接准入、SmallWebRTC 协商、回环访问限制、私有 ICE 配置。按显式模式选择流水线。 |
| `probe.py`、`local_agent.py` | 无模型音频探针；或完全本地 Whisper → Ollama → Pocket TTS 路径。不会隐式切换云服务。 |
| `cloud_voice_config.py` | 两种云模式共用的凭据检查、计费开关和轮次/字数上限。流式模式另需实时服务开关和 AppID。 |
| `cloud_agent.py` | 已有整段 API 的腾讯云一句话识别、整段 TTS 适配器；保留为对照路径。 |
| `streaming_cloud.py` | 实时 ASR WebSocket 与流式 TTS WebSocket 的签名、协议、增量帧和单连接音频时长边界。 |
| `cloud_voice_pipeline.py` | 两种云模式共享的 Pipecat 流水线组装：输入、STT、VAD/上下文、硅基流动流式 LLM、TTS、输出。适配器由调用方注入。 |
| `voice_observability.py`、`cloud_timing.py` | 不记录语音内容的帧计数与每轮阶段计时。统计不是口到耳延迟。 |

关键依赖方向是 `server → 模式适配器 → 共享流水线/配置/观测`。整段与流式模式只共享稳定的编排和边界，不共享各自的腾讯云协议状态机；流式模式也不再通过整段模式导入计费配置。新服务商适配器应满足 STT/TTS 帧接口并注入共享编排，不应复制 LLM 上下文、VAD、计数与计时流水线。

## 流式帧与验收口径

`cloud-stream` 的预期数据流是：浏览器 16 kHz PCM → 腾讯云实时 ASR → **仅稳定句段** → 硅基流动 Qwen SSE 文本 → 腾讯云流式 TTS 增量 PCM → 浏览器 RTP。ASR 中间结果不入 LLM；TTS 可以在 LLM 全文结束前产出音频，但服务商仍可能为了断句而缓存文本。45 秒 PCM、最多 3 轮及每轮 120 字是单连接成本刹车，**不是账户级预算**。

测试分层应分别报告：纯离线协议/签名测试、无模型 WebRTC 音频探针、本地模型端到端、真实云服务闭环、远端网络/真机接通。当前流式模式只有离线协议测试，未调用真实实时 ASR/TTS，未测得流式首包延迟，也未部署公网；旧整段模式的历史延迟不能用于流式模式。真实云测试必须先核对三方额度与后付费状态，再显式开启双计费闸门及测试闸门。细节见[流式验证说明](ai-streaming.md)和[延迟口径](ai-latency.md)。
