# LiltCall：一人 + AI 本地语音原型

状态（2026-09-23）：**本机合成麦克风端到端测试通过；未部署、未接入现有双人房间。** 浏览器通过 WebRTC 把音频送到 `127.0.0.1:7860` 的 Pipecat SmallWebRTC 服务，服务运行本地 Whisper STT → Ollama/Qwen2.5 LLM → Pocket TTS，再把合成音频作为 WebRTC 音轨返回。没有云模型密钥或托管模型请求。这个模式是**一位真人对一位 AI**，不需要 SFU，也不复用双人房间的 guest 席位。未来两位真人 + AI 需要另行设计权限和媒体拓扑，当前并未实现。

```text
浏览器 /ai.html
    ├─ 麦克风音轨 ── WebRTC ──▶ Pipecat SmallWebRTC (127.0.0.1:7860)
    │                                      │
    │                                      ▼
    │                            Whisper tiny → Ollama/Qwen2.5:0.5b
    │                                      → Pocket TTS / alba
    └─ 回复音轨 ◀── WebRTC ────────────────┘

Vite 开发服务器仅转发 `/ai-api` 信令与计数到本机服务。`/ai.html` 是独立开发页，未放进目前的 Vite 生产构建入口；现有 Vercel、Worker、TURN 和双人通话代码路径不走这个服务。两个媒体端点仍是 WebRTC 对端；服务端必须接触明文语音才能做 STT，因此不能把它称作浏览器间端到端私密通话。

## 本机运行

需要 macOS/Linux、Node.js 22+、`uv`、Python 3.11/3.12、Ollama 和 Chromium。合成语音自动化测试使用 macOS `say` 和 `sox`；手动打开页面不限于该测试夹具。首次模型/依赖下载约数 GB，之后本机运行；当前试验只验证英语语音。以下命令均在此仓库根目录执行。

```bash
npm install
cd apps/ai
uv sync --extra local
uv run --extra local python -m nltk.downloader punkt_tab
ollama pull qwen2.5:0.5b
```

如果 NLTK 下载器在受限代理下拒绝请求，可从 [NLTK 官方数据仓库固定提交](https://github.com/nltk/nltk_data/tree/550b6625bcef1f2abff2ff770a5a0d272c9c6b2a/packages/tokenizers)下载 `punkt_tab.zip`；校验 SHA-256 `e57f64187974277726a3417ca6f181ec5403676c717672eef6a748a7b20e0106` 后解压到 `$HOME/nltk_data/tokenizers/`。服务启动时会检查英语分句数据，不会因缺数据而静默显示“AI 已就绪”。Whisper 和 Pocket TTS 的模型权重由各自依赖在首次通话时下载，首次连接可能较慢；不要在无缓存的离线机器上预期立即可用。模型许可、下载源和生产分发方案在公开部署前还需单独核验。

三个终端分别运行：

```bash
OLLAMA_NO_CLOUD=1 OLLAMA_NOHISTORY=1 ollama serve
```

```bash
cd apps/ai
LILTCALL_AI_MODE=local uv run --extra local uvicorn server:app --host 127.0.0.1 --port 7860 --no-access-log
```

```bash
npm run dev:web
```

打开 `http://127.0.0.1:5187/ai.html`，点击“连接麦克风”，说一句英语后停顿；页面显示输入帧、非静音、VAD 开始/结束、STT/LLM/TTS 帧数和浏览器收到的音频 RTP 包。连接前不请求麦克风。挂断会停止本地麦克风并向服务请求关闭 WebRTC 对端。

无需模型的传输探针：只运行第二、三个终端，但第二个终端改为 `uv run uvicorn server:app --host 127.0.0.1 --port 7860 --no-access-log`；页面在收到非静音麦克风采样后返回一次测试音，不会调用 STT/LLM/TTS。

## 自动化与验收口径

```bash
npm run check
npm run test:ai
npm run test:ai:local
```

`test:ai` 是无模型的 Chromium 假设备链路测试：验证麦克风样本到服务、提示音回到浏览器 RTP、语言切换、挂断释放、无效 offer 拒绝以及仅允许一个对端。`test:ai:local` 需要 macOS `say`、`sox` 和已下载的 Ollama/NLTK 数据；它生成英语合成语音，经 Chromium 假麦克风进入实际 Whisper/Ollama/Pocket TTS，要求 STT、LLM、TTS 计数和浏览器入站音频 RTP 都大于零，并在结束后检查服务对端释放。不要将一次 smoke pass 当成转写准确度、答案质量或低延迟的统计结论。

两个 Playwright 命令共用本机 `7860` 与 `5187` 端口，须**顺序运行**。模型测试会自行启动需要的本地服务；若另一个模式已在运行，请先停止它，避免连到错误的后端。

当前页面显示的是累计帧/包数，**尚未测量**“用户一句话结束→首段回复音频可播放”的 p50/p95。下一步至少覆盖多轮、用户打断、长时间运行/模型失败、移动浏览器、不同公网、断线重连及服务异常后的座位回收。每种场景记录成功/失败分母、端到端首音频延迟和资源占用，再决定模型大小及是否部署。不要在未经容量验证的共享服务器上直接承载本地模型栈。

## 安全和部署边界

这个 FastAPI 原型没有房间身份验证和抗滥用预算，**只能绑定 127.0.0.1**，不能直接暴露公网。它最多接受一个 WebRTC 对端；仅返回计数，不保存音频或转写到本项目数据库。第三方模型运行时仍可能有自己的缓存；Ollama 通过 `OLLAMA_NO_CLOUD=1` 指定本地模式。后续公开版须有独立域名/HTTPS、短期鉴权、明确麦克风和 AI 数据使用提示、并发/时长限制、滥用/费用上限、模型许可证核对和真实设备验收。公网 WebRTC 通常还需要 ICE/STUN/TURN 配置；本机 `iceServers: []` 的成功不证明跨网络可连。
