# 一人 + AI：腾讯云语音与硅基流动试验

状态（2026-09-24）：**代码已接入；服务商链路、本机浏览器与私有远端服务器的 WebRTC → ASR → LLM → TTS → 浏览器音频测试均通过。AI 服务不常驻、没有公网入口；真机异网链路尚未验收。** 这是独立的 `/ai.html` 试验，不会把现有双人通话的媒体送去 AI。详见[私有服务器试部署记录](ai-private-stage-2026-09-24.md)。

```text
浏览器麦克风 ── WebRTC ──▶ 私有 Pipecat（本机或服务器回环监听）
                                 ├─ VAD 分段 → 腾讯云 SentenceRecognition (16k_zh)
                                 ├─ 转写 → 硅基流动 Qwen/Qwen2.5-7B-Instruct
                                 └─ 回复 → 腾讯云 TextToVoice (16k PCM)
浏览器扬声器 ◀── WebRTC ◀───────┘
```

这是**一位用户与一位 AI**，不需要 SFU；媒体到达 AI 服务后由服务解密并送到第三方。本页记录原有 `cloud` 整段 API 模式：`SentenceRecognition` 在说完一句后才上传短 WAV，不是流式识别。新增的独立 [`cloud-stream` 模式](ai-streaming.md)接入实时 ASR、流式 LLM 与流式文本/音频 TTS，但截至目前只完成离线协议验证，未做真实账号闭环。

[延迟指标定义、现有单次样本与复测方案](ai-latency.md)区分了 ASR/LLM/TTS 请求、服务端首音频帧和浏览器首次观察到 RTP；目前没有真实用户口到耳或延迟分位数。云页面的新阶段计时仅为私有诊断，不含语音文本。

## 账户与费用边界

费用边界：代码采用[腾讯云音色表](https://cloud.tencent.com/document/product/1073/92668)中的 `402000`。一次极小真实调用曾验证服务商链路，但免费额度、资源包和后付费状态因账号及时间而异，不能把历史检查结果当作新运行的授权或零成本保证。**不要把其他项目的密钥复制进仓库，也不要把密钥放进浏览器/Vite 变量。**

先在本人登录的[腾讯云 ASR 控制台](https://console.cloud.tencent.com/asr)、[TTS 控制台](https://console.cloud.tencent.com/tts)确认服务状态、免费包剩余/到期时间、耗尽后是否自动后付费；在[硅基流动控制台](https://cloud.siliconflow.cn/)确认目标账号余额及模型价格。腾讯云[一句话识别](https://cloud.tencent.com/document/api/1093/35646)和[基础语音合成](https://cloud.tencent.com/document/api/1073/37995)按各自接口计量；免费包、价格和活动规则会变，不能由本项目保证免费。

## 本机运行

仅在确认费用与额度后，把**选择的那个账号**的凭据以进程环境变量注入（例如从可信的本地密钥管理器），并显式打开可计费开关。不要 `source` 其他项目的整份 `.env`，也不要提交密钥。以下命令只展示变量名：

```bash
cd apps/ai
uv sync --extra cloud
# 运行前由你的密钥管理器提供 TENCENTCLOUD_SECRET_ID、
# TENCENTCLOUD_SECRET_KEY 和 SILICONFLOW_API_KEY。
LILTCALL_AI_MODE=cloud LILTCALL_AI_CLOUD_ALLOW_BILLING=1 \
  uv run --extra cloud uvicorn server:app --host 127.0.0.1 --port 7860 --no-access-log
```

另一个终端在仓库根目录运行 `npm run dev:web`，打开 `http://127.0.0.1:5187/ai.html`。页面在点击“连接麦克风”前不会请求音频权限；云模式明确提示第三方数据流。默认每次通话最多尝试 3 次 STT、3 次 TTS；私有验收可用 `LILTCALL_AI_CLOUD_MAX_TURNS=1` 或 `2` 降低上限。语音段最多 10 秒，合成文本每次最多 120 字，SDK 网络超时 8 秒，不自动重试。超出上限必须挂断重来；这只是试验级费用护栏，**不是账户级预算**。

## 验证与缺口

无需账号的适配器回归：`cd apps/ai && uv run --extra cloud python -m unittest -v test_cloud_agent`。测试用模拟响应检查请求字段、PCM 返回、超长音频拒绝、轮数上限和计费开关，不接触服务商。`npm run check && npm test && npm run build` 验证前端；`npm run test:ai` 验证原有无模型 WebRTC 探针。两次真实硅基流动极小文本调用分别验证普通和 SSE 流式响应；2026-09-24 用短句合成音频完成一次 TTS → ASR → LLM → TTS 服务商级验证，并用 `npm run test:ai:cloud` 完成一次本机浏览器中文假麦克风 → WebRTC → 真实云端 AI → WebRTC 音频返回测试。云浏览器测试只能在人工核对免费额度与计费设置后，用独立的 `LILTCALL_AI_CLOUD_TEST=1` 和服务端 `LILTCALL_AI_CLOUD_ALLOW_BILLING=1` 开关运行；不得放进 CI 或普通测试集合。它不证明连续稳定性、真人体验或长期免费。

Mac 到远端服务器的私有信令隧道与 WebRTC 媒体路径也已通过，细节见[测试记录](test-results.md)；此路由不是公网开放服务。下一步在独立出口/真机上验收远端 AI 媒体路径；执行前必须再次确认免费额度与两个服务各自的后付费状态，并处理现有 ASR 后付费风险。当前没有真机 AI 路径、打断体验、连续稳定性、p50/p95 延迟或费率验证。该 FastAPI 服务没有公网鉴权，代码拒绝非回环直连，启动时仍须绑定回环地址；生产部署需另行设计短期身份、同意提示、配额预算、审计和独立域名。
