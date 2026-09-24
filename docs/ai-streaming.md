# 私有流式语音链路（离线协议验证阶段）

2026-09-24：新增独立 `cloud-stream` 模式，**未调用真实实时 ASR/TTS，也未部署**。旧 `cloud` 模式仍保留为整段 API 对照，已发布的双人音视频路径不变。

[代码架构、模块职责与可编辑架构图](ai-code-architecture.md)。

```text
浏览器麦克风 → WebRTC → 私有 Pipecat
  → 腾讯云实时 ASR WebSocket：16 kHz PCM 每 200 ms 推送，丢弃可变的中间文本
  → 仅稳定句段 → 硅基流动 Qwen：OpenAI 兼容 SSE 流式文本
  → 腾讯云 TextToStreamAudioWSv2：增量文本输入、二进制 PCM 增量输出
  → WebRTC → 浏览器扬声器
```

腾讯云[实时语音识别协议](https://cloud.tencent.com/document/api/1093/48982)要求短期 HMAC 签名、音频接近实时速率发送，稳态结果为 `slice_type=2`；本实现仅将稳态句段送 LLM，避免可变中间结果造成重复回答。腾讯云[流式文本语音合成协议](https://cloud.tencent.com/document/api/1073/108595)要求等待 READY、持续发送 `ACTION_SYNTHESIS`、以 `ACTION_COMPLETE` 结束并等待 FINAL，二进制 PCM 到达即输出。服务端只用 16 kHz 单声道 PCM，音色仍为 `402000`。Pipecat 当前固定版本的 OpenAI 兼容 LLM 服务使用 `stream=True`，LLM 文本帧不等整段结果才进入 TTS。腾讯云 TTS 仍可能为语调/断句缓存到句末标点；“流式”不保证每个 token 都立即产生声音。

本轮针对两个真实等待点做了保守调整：实时 ASR 的静音断句阈值由 700 ms 降到协议允许的 600 ms；LLM 提示词鼓励先给出带句号的有信息短句。若增量文本出现至少 12 字的分句逗号，**仅送往 TTS 的文本**把该逗号变为腾讯云支持的分句符 `；`，让合成可在 LLM 整段结束前启动；转发给下游的原始 LLM 文本不变。短逗号保持原样，最后仍按原协议发送 `ACTION_COMPLETE` 并等待 FINAL。可能的代价是长句语调变化、ASR 在短暂停顿处过早断句；尚未有真人/真实服务商质量与延迟对照，不能声称实际节省 100 ms 或首包已达标。

## 费用和启动门槛

**一句话识别的额度不能用于实时 ASR。** 腾讯云分别列出[实时 ASR](https://cloud.tencent.com/document/product/1093/35686)和一句话识别额度；任何真实调用前都需重新核对适用额度、地区和后付费状态。TTS 流式合成的资源包适用性也需按账号核对；[TTS 计费说明](https://cloud.tencent.com/document/product/1073/34112)指出免费包耗尽后的行为取决于后付费开关。硅基流动额度另算。代码有单通话 45 秒 PCM、最多 3 个稳定 ASR 句段/3 轮 TTS、每轮最多 120 字，以及两个显式开关；这些都**不是账户级硬预算**。

仅在本人核对三方额度与后付费状态后，从可信密钥管理器向进程注入 `TENCENTCLOUD_APP_ID`、`TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`SILICONFLOW_API_KEY`，再显式设置 `LILTCALL_AI_CLOUD_ALLOW_BILLING=1` 和 `LILTCALL_AI_REALTIME_ALLOW_BILLING=1`。不得将凭据写进仓库或 Vite 环境变量。启动命令只示意非敏感开关：

```bash
cd apps/ai
uv sync --extra cloud
LILTCALL_AI_MODE=cloud-stream LILTCALL_AI_CLOUD_ALLOW_BILLING=1 \
LILTCALL_AI_REALTIME_ALLOW_BILLING=1 \
uv run --extra cloud uvicorn server:app --host 127.0.0.1 --port 7860 --no-access-log
```

若同一个本机 `.venv` 还要运行本地 Whisper/Pocket 模式，依赖同步时同时指定 `--extra local --extra cloud`；只同步 `cloud` 会卸载未被该 extra 需要的本地模型包。

未满足 AppID、凭据和两个计费开关时，服务启动即拒绝。此服务只允许回环 HTTP；要接浏览器需本机 Vite 代理或受控隧道，**不能把 7860 端口公开**。不自动降级到整段 API，也不自动重试可计费请求。

人工核对费用后，还需单独设置 `LILTCALL_AI_STREAM_TEST=1` 才能执行 `npm run test:ai:stream` 浏览器闭环；该命令不在普通 CI 里。本次没有运行它。

## 测试状态与下一关

已用假 WebSocket 和假凭据离线验证 URL 签名、200 ms PCM 分块/45 秒封顶、去重且只转发稳态 ASR、TTS 增量文本/PCM/FINAL、**较长分句在 LLM 结束前输出 PCM**、原始 LLM 文本不变、错误消息脱敏、计费开关与流水线构建；没有真实云调用。`npm run test:ai:stream -- --list` 在假 AppID/显式开关下只列出用例，不启动服务；缺少开关时按预期拒绝。此前整段 API 的 0.63/1.14/1.42 秒等样本**不能套用到新模式**。本次测试环境的跨境实时 ASR 地区通路不可用，因此本机不能直接完成真实流式闭环；不为测试改计费/跨境设置。下一关是在具备有效地区和费用保护的私有环境做限时真实语音闭环，然后测远端/手机、打断、p50/p95、断网和费用。实现尚属试验代码，不应宣称流式首包延迟或公网可用性。
