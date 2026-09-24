import "./style.css";
import "./ai.css";
import { formatCloudLatency, type CloudTimingMetrics } from "./ai-latency";

type Locale = "en" | "zh-CN";
type Answer = { sdp: string; type: "answer"; pc_id: string };
type ProbeMetrics = { input_frames: number; nonzero_audio_detected: boolean; response_sent: boolean };
type LocalMetrics = CloudTimingMetrics & { input_frames: number; nonzero_audio_detected: boolean; vad_starts: number; vad_stops: number; transcriptions: number; llm_text_frames: number; tts_audio_frames: number };
type Mode = "audio-probe" | "local-voice" | "cloud-voice" | "cloud-stream-voice";

const copy = {
  en: {
    kicker: "LOCAL PROTOTYPE · NO MODEL KEYS",
    heading: "Voice path, before the AI.",
    description: "This test connects your browser microphone to a Pipecat service over WebRTC. A short tone comes back only after the service receives real microphone samples. It does not transcribe, reason, or speak.",
    idle: "Ready to test",
    connecting: "Connecting…",
    connected: "WebRTC connected",
    verified: "Microphone in, test tone out",
    ended: "Call ended",
    failed: "Connection failed",
    hint: "Click connect to grant microphone access. Headphones prevent feedback.",
    connectedHint: "Speak or wait for the fake microphone signal. The service replies with one short tone.",
    verifiedHint: "The audio route works. This is a transport probe, not STT → LLM → TTS.",
    endedHint: "Your microphone and the server peer connection have been closed.",
    connect: "Connect microphone",
    hangup: "Hang up",
    footnote: "Local-only: the Vite development server proxies signaling to 127.0.0.1:7860. The existing two-person call and deployed site are unchanged.",
    details: "Connection details",
    metrics: "ICE: {ice} · Mic frames: {frames} · Non-silent input: {input} · Tone sent: {tone} · Audio packets received: {packets}",
    yes: "yes", no: "no", unavailable: "—",
    requestFailed: "The local AI service is unavailable. Start it and try again.",
    permissionDenied: "Allow microphone access in your browser and try again.",
    playbackBlocked: "Tap the audio player to hear the test tone.",
    localKicker: "LOCAL VOICE AGENT · NO MODEL API",
    localHeading: "Talk to an AI on this Mac.",
    localDescription: "Your microphone goes by WebRTC to this local Pipecat service. Whisper transcribes, Qwen2.5 runs in local Ollama, and Pocket TTS speaks back in English. The models must be downloaded first; this call uses no hosted model API.",
    localConnectedHint: "Speak a short English sentence, then pause. The local models may take a few seconds.",
    localVerified: "Local AI audio returned",
    localVerifiedHint: "Whisper, Ollama, and Pocket TTS produced a reply. This says nothing yet about public-network reliability or conversational quality.",
    localMetrics: "ICE: {ice} · Input frames: {frames} · Non-silent: {nonzero} · VAD start/stop: {starts}/{stops} · STT turns: {stt} · LLM text frames: {llm} · TTS audio frames: {tts} · Audio packets received: {packets}",
    cloudLatency: " · Latest turn {turn}: ASR request {stt} ms · LLM first text {llmFirst} ms / complete {llmTotal} ms · TTS first request {tts} ms · LLM start → first server audio frame {serverAudio} ms · Click → first observed inbound RTP {browserRtp} ms",
    localFootnote: "Local-only, English voice: the models run on this Mac. No transcript is saved to a database. The existing two-person call and deployed site are unchanged.",
    cloudKicker: "CLOUD VOICE TEST · PROVIDER USAGE MAY COST MONEY",
    cloudHeading: "Talk to the cloud AI.",
    cloudDescription: "Only after you click connect, your voice is sent over WebRTC to this private Pipecat service, then speech audio goes to Tencent Cloud ASR. The transcript goes to SiliconFlow's Qwen model; its reply text goes to Tencent Cloud TTS. Do not use sensitive speech. This prototype allows at most three turns per call; private tests may set a lower limit.",
    streamCloudDescription: "Private streaming test: microphone PCM goes over WebRTC to Tencent realtime ASR; only stable sentence transcripts reach SiliconFlow's streaming Qwen model. Generated text is sent incrementally to Tencent flowing TTS and audio returns as it arrives. Do not use sensitive speech. Realtime ASR has a separate quota and may incur charges; this call is capped at 45 seconds and three turns.",
    cloudConnectedHint: "Speak a short Chinese sentence, then pause. Each turn may use provider quota or incur charges.",
    cloudVerified: "Cloud AI audio returned",
    cloudVerifiedHint: "Audio returned from the provider path. Check the service logs and billing consoles before wider use.",
    cloudFootnote: "Private prototype only; this is not available on the public LiltCall site. Audio reaches the configured AI service and then Tencent Cloud; text reaches SiliconFlow and Tencent Cloud TTS. Provider retention follows their policies. The two-person call is unchanged.",
    streamLatency: " · Latest turn {turn}: ASR final after speech end {stt} ms · LLM first text {llmFirst} ms / complete {llmTotal} ms · TTS first PCM after first text {tts} ms · LLM start → first server audio frame {serverAudio} ms · Click → first observed inbound RTP {browserRtp} ms",
  },
  "zh-CN": {
    kicker: "本地原型 · 无需模型密钥",
    heading: "先打通语音，再接 AI。",
    description: "本测试通过 WebRTC 把浏览器麦克风接到 Pipecat 服务。服务收到非静音的麦克风采样后，才返回一段短提示音。目前不会转写、思考或语音回答。",
    idle: "准备测试",
    connecting: "连接中…",
    connected: "WebRTC 已连接",
    verified: "麦克风已送达，测试音已返回",
    ended: "通话已结束",
    failed: "连接失败",
    hint: "点击连接后才会请求麦克风权限；建议佩戴耳机，避免回声。",
    connectedHint: "说话或等待模拟麦克风发声；服务只会返回一次短提示音。",
    verifiedHint: "音频链路已通；这还是传输探针，不是 STT → LLM → TTS。",
    endedHint: "麦克风与服务端 WebRTC 连接均已关闭。",
    connect: "连接麦克风",
    hangup: "挂断",
    footnote: "仅本地：Vite 开发服务器把信令转发到 127.0.0.1:7860。现有双人通话和线上站点不受影响。",
    details: "连接详情",
    metrics: "ICE：{ice} · 麦克风帧：{frames} · 非静音输入：{input} · 已发送提示音：{tone} · 收到音频包：{packets}",
    yes: "是", no: "否", unavailable: "—",
    requestFailed: "本地 AI 服务不可用。启动服务后重试。",
    permissionDenied: "请允许浏览器使用麦克风后重试。",
    playbackBlocked: "请点击音频播放器，播放测试音。",
    localKicker: "本地语音 AI · 无模型 API",
    localHeading: "和这台 Mac 上的 AI 对话。",
    localDescription: "麦克风通过 WebRTC 送至本机 Pipecat 服务；Whisper 转写，Ollama 上的 Qwen2.5 回答，Pocket TTS 用英语播报。首次需要下载模型，通话不调用托管模型 API。",
    localConnectedHint: "说一句简短英语，然后稍作停顿。本地模型可能需要几秒钟。",
    localVerified: "本地 AI 音频已返回",
    localVerifiedHint: "Whisper、Ollama 与 Pocket TTS 已生成回复；这尚不代表公网可靠性或对话质量已验收。",
    localMetrics: "ICE：{ice} · 输入帧：{frames} · 非静音：{nonzero} · VAD 开始/结束：{starts}/{stops} · STT 话轮：{stt} · LLM 文本帧：{llm} · TTS 音频帧：{tts} · 收到音频包：{packets}",
    cloudLatency: " · 最近第 {turn} 轮：ASR 请求 {stt} 毫秒 · LLM 首段文本 {llmFirst} 毫秒 / 完成 {llmTotal} 毫秒 · 首次 TTS 请求 {tts} 毫秒 · LLM 开始至服务端首帧音频 {serverAudio} 毫秒 · 点击至首次观察到入站 RTP {browserRtp} 毫秒",
    localFootnote: "仅本地、英语发声：模型运行在这台 Mac，不把转写保存到数据库；现有双人通话和线上站点不受影响。",
    cloudKicker: "云端语音测试 · 可能消耗额度或产生费用",
    cloudHeading: "和云端 AI 对话。",
    cloudDescription: "点击连接后，语音通过 WebRTC 到达私有 Pipecat 服务，再发送到腾讯云语音识别；转写文本发给硅基流动的 Qwen 模型，回复文本送腾讯云语音合成。请勿说出敏感信息。原型每次通话最多三轮，私有测试可设置更低上限。",
    streamCloudDescription: "私有流式试验：麦克风 PCM 经 WebRTC 实时送到腾讯云 ASR；仅稳定句段转写送硅基流动 Qwen 流式生成；文本增量送腾讯云流式 TTS，音频到达即返回。请勿说敏感信息。实时 ASR 使用独立额度且可能计费；单次通话最多 45 秒、三轮。",
    cloudConnectedHint: "说一句简短中文，然后暂停。每轮可能消耗服务商额度或产生费用。",
    cloudVerified: "云端 AI 音频已返回",
    cloudVerifiedHint: "服务商链路返回了音频。扩大使用前仍需检查日志和账单。",
    cloudFootnote: "仅私有原型，LiltCall 公网站点尚未开放 AI。音频先到指定 AI 服务，再到腾讯云；文本送硅基流动与腾讯云 TTS。服务商留存规则以其政策为准；现有双人通话不受影响。",
    streamLatency: " · 最近第 {turn} 轮：说话结束至 ASR 稳定句段 {stt} 毫秒 · LLM 首段文本 {llmFirst} 毫秒 / 完成 {llmTotal} 毫秒 · 首段文本至 TTS 首帧 PCM {tts} 毫秒 · LLM 开始至服务端首帧音频 {serverAudio} 毫秒 · 点击至首次观察到入站 RTP {browserRtp} 毫秒",
  },
} as const;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("ai-stage");
const status = $("ai-status");
const hint = $("ai-hint");
const error = $("ai-error");
const connectButton = $<HTMLButtonElement>("ai-connect");
const hangupButton = $<HTMLButtonElement>("ai-hangup");
const audio = $<HTMLAudioElement>("ai-audio");
const metricsEl = $("ai-metrics");

let locale: Locale = navigator.language.startsWith("zh") ? "zh-CN" : "en";
let backendMode: Mode | null = null;
let peer: RTCPeerConnection | null = null;
let microphone: MediaStream | null = null;
let peerId: string | null = null;
let generation = 0;
let metricsTimer: ReturnType<typeof setInterval> | null = null;
let probeMetrics: ProbeMetrics | null = null;
let localMetrics: LocalMetrics | null = null;
let inboundPackets = 0;
let callStartedAt: number | null = null;
let firstInboundAudioObservedMs: number | null = null;
let statusKey: "idle" | "connecting" | "connected" | "verified" | "ended" | "failed" = "idle";
let errorKey: "requestFailed" | "permissionDenied" | "playbackBlocked" | null = null;

function renderMetrics(): void {
  const dictionary = copy[locale];
  if (backendMode === "local-voice" || backendMode === "cloud-voice" || backendMode === "cloud-stream-voice") {
    metricsEl.textContent = dictionary.localMetrics
      .replace("{ice}", peer?.iceConnectionState ?? dictionary.unavailable)
      .replace("{frames}", String(localMetrics?.input_frames ?? 0))
      .replace("{nonzero}", localMetrics ? (localMetrics.nonzero_audio_detected ? dictionary.yes : dictionary.no) : dictionary.unavailable)
      .replace("{starts}", String(localMetrics?.vad_starts ?? 0))
      .replace("{stops}", String(localMetrics?.vad_stops ?? 0))
      .replace("{stt}", String(localMetrics?.transcriptions ?? 0))
      .replace("{llm}", String(localMetrics?.llm_text_frames ?? 0))
      .replace("{tts}", String(localMetrics?.tts_audio_frames ?? 0))
      .replace("{packets}", String(inboundPackets));
    if (backendMode === "cloud-voice" || backendMode === "cloud-stream-voice") {
      const streaming = backendMode === "cloud-stream-voice";
      metricsEl.textContent += formatCloudLatency(streaming ? dictionary.streamLatency : dictionary.cloudLatency,
        localMetrics, firstInboundAudioObservedMs, dictionary.unavailable, streaming);
    }
    return;
  }
  metricsEl.textContent = dictionary.metrics
    .replace("{ice}", peer?.iceConnectionState ?? dictionary.unavailable)
    .replace("{frames}", String(probeMetrics?.input_frames ?? 0))
    .replace("{input}", probeMetrics ? (probeMetrics.nonzero_audio_detected ? dictionary.yes : dictionary.no) : dictionary.unavailable)
    .replace("{tone}", probeMetrics ? (probeMetrics.response_sent ? dictionary.yes : dictionary.no) : dictionary.unavailable)
    .replace("{packets}", String(inboundPackets));
}

function render(): void {
  const dictionary = copy[locale];
  document.documentElement.lang = locale;
  const local = backendMode === "local-voice";
  const streaming = backendMode === "cloud-stream-voice";
  const cloud = backendMode === "cloud-voice" || streaming;
  document.title = `LiltCall — ${cloud ? dictionary.cloudHeading : local ? dictionary.localHeading : dictionary.heading}`;
  $("ai-kicker").textContent = cloud ? dictionary.cloudKicker : local ? dictionary.localKicker : dictionary.kicker;
  $("ai-heading").textContent = cloud ? dictionary.cloudHeading : local ? dictionary.localHeading : dictionary.heading;
  $("ai-description").textContent = streaming ? dictionary.streamCloudDescription : cloud ? dictionary.cloudDescription : local ? dictionary.localDescription : dictionary.description;
  $("ai-connect-label").textContent = dictionary.connect;
  hangupButton.textContent = dictionary.hangup;
  $("ai-footnote").textContent = cloud ? dictionary.cloudFootnote : local ? dictionary.localFootnote : dictionary.footnote;
  $("ai-details-label").textContent = dictionary.details;
  $("ai-language").textContent = locale === "en" ? "中文" : "EN";
  stage.dataset.state = statusKey;
  status.textContent = statusKey === "verified" ? (cloud ? dictionary.cloudVerified : local ? dictionary.localVerified : dictionary.verified) : dictionary[statusKey];
  hint.textContent = statusKey === "verified" ? (cloud ? dictionary.cloudVerifiedHint : local ? dictionary.localVerifiedHint : dictionary.verifiedHint)
    : statusKey === "connected" ? (cloud ? dictionary.cloudConnectedHint : local ? dictionary.localConnectedHint : dictionary.connectedHint)
      : statusKey === "ended" ? dictionary.endedHint : dictionary.hint;
  error.hidden = !errorKey;
  error.textContent = errorKey ? dictionary[errorKey] : "";
  renderMetrics();
}

function setStatus(key: typeof statusKey): void { statusKey = key; render(); }

async function sendCandidate(candidate: RTCIceCandidate, id: string): Promise<void> {
  const response = await fetch("/ai-api/api/offer", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pc_id: id,
      candidates: [{ candidate: candidate.candidate, sdp_mid: candidate.sdpMid ?? "0", sdp_mline_index: candidate.sdpMLineIndex ?? 0 }],
    }),
  });
  if (!response.ok) throw new Error("candidate_failed");
}

async function updateMetrics(pc: RTCPeerConnection, id: string): Promise<void> {
  if (peer !== pc || peerId !== id) return;
  try {
    const [response, stats] = await Promise.all([fetch(`/ai-api/api/metrics/${encodeURIComponent(id)}`), pc.getStats()]);
    if (peer !== pc || peerId !== id) return;
    if (response.ok) {
      const latest = await response.json() as LocalMetrics | ProbeMetrics;
      if (peer !== pc || peerId !== id) return;
      if (backendMode === "local-voice" || backendMode === "cloud-voice" || backendMode === "cloud-stream-voice") localMetrics = latest as LocalMetrics;
      else probeMetrics = latest as ProbeMetrics;
    }
    inboundPackets = 0;
    stats.forEach((report) => { if (report.type === "inbound-rtp" && report.kind === "audio") inboundPackets += report.packetsReceived ?? 0; });
    if (inboundPackets > 0 && firstInboundAudioObservedMs === null && callStartedAt !== null) {
      firstInboundAudioObservedMs = Math.round(performance.now() - callStartedAt);
    }
    if ((((backendMode === "local-voice" || backendMode === "cloud-voice" || backendMode === "cloud-stream-voice") && (localMetrics?.tts_audio_frames ?? 0) > 0)
      || (backendMode === "audio-probe" && probeMetrics?.response_sent))
      && inboundPackets > 0 && statusKey === "connected") setStatus("verified");
    else renderMetrics();
  } catch { /* This local diagnostic must not interrupt the media path. */ }
}

async function connect(): Promise<void> {
  if (peer || statusKey === "connecting" || !backendMode) return;
  const ownGeneration = ++generation;
  errorKey = null;
  probeMetrics = null;
  localMetrics = null;
  inboundPackets = 0;
  callStartedAt = performance.now();
  firstInboundAudioObservedMs = null;
  connectButton.disabled = true;
  setStatus("connecting");
  let pc: RTCPeerConnection | null = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== ownGeneration) { stream.getTracks().forEach((track) => track.stop()); return; }
    microphone = stream;
    const iceResponse = await fetch("/ai-api/api/private-ice", { cache: "no-store" });
    if (!iceResponse.ok) throw new Error("private_ice_unavailable");
    const ice = await iceResponse.json() as { iceServers: RTCIceServer[] };
    if (!Array.isArray(ice.iceServers) || ice.iceServers.length > 3) throw new Error("private_ice_invalid");
    pc = new RTCPeerConnection({ iceServers: ice.iceServers });
    peer = pc;
    const activePc = pc;
    const queued: RTCIceCandidate[] = [];
    pc.addEventListener("icecandidate", (event) => {
      if (!event.candidate || peer !== pc) return;
      if (!peerId) queued.push(event.candidate);
      else void sendCandidate(event.candidate, peerId).catch(() => { /* ICE can still use other candidates. */ });
    });
    pc.addEventListener("track", (event) => {
      if (peer !== pc || event.track.kind !== "audio") return;
      audio.srcObject = new MediaStream([event.track]);
      void audio.play().catch(() => { errorKey = "playbackBlocked"; render(); });
    });
    pc.addEventListener("connectionstatechange", () => {
      if (peer !== pc) return;
      if (activePc.connectionState === "connected") setStatus("connected");
      else if (activePc.connectionState === "failed") setStatus("failed");
      renderMetrics();
    });
    pc.addTransceiver(stream.getAudioTracks()[0], { direction: "sendrecv" });
    pc.addTransceiver("video", { direction: "recvonly" }); // Required by Pipecat SmallWebRTC negotiation.
    await pc.setLocalDescription(await pc.createOffer());
    const response = await fetch("/ai-api/api/offer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription?.sdp, type: "offer" }),
    });
    if (!response.ok) throw new Error("offer_failed");
    const answer = await response.json() as Answer;
    if (generation !== ownGeneration || peer !== pc) {
      void fetch(`/ai-api/api/offer/${encodeURIComponent(answer.pc_id)}`, { method: "DELETE", keepalive: true });
      return;
    }
    peerId = answer.pc_id;
    await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
    for (const candidate of queued) await sendCandidate(candidate, answer.pc_id);
    hangupButton.disabled = false;
    metricsTimer = setInterval(() => void updateMetrics(pc!, answer.pc_id), 500);
  } catch (failure) {
    if (generation !== ownGeneration) return;
    errorKey = failure instanceof DOMException && failure.name === "NotAllowedError" ? "permissionDenied" : "requestFailed";
    await hangUp(false);
    setStatus("failed");
  } finally { if (generation === ownGeneration) connectButton.disabled = false; }
}

async function hangUp(showEnded = true): Promise<void> {
  ++generation;
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = null;
  const id = peerId;
  peerId = null;
  peer?.close();
  peer = null;
  microphone?.getTracks().forEach((track) => track.stop());
  microphone = null;
  audio.srcObject = null;
  hangupButton.disabled = true;
  connectButton.disabled = false;
  if (showEnded) setStatus("ended");
  if (id) await fetch(`/ai-api/api/offer/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

$("ai-language").addEventListener("click", () => { locale = locale === "en" ? "zh-CN" : "en"; render(); });
connectButton.addEventListener("click", () => void connect());
hangupButton.addEventListener("click", () => void hangUp());
window.addEventListener("pagehide", () => {
  ++generation;
  if (metricsTimer) clearInterval(metricsTimer);
  if (peerId) void fetch(`/ai-api/api/offer/${encodeURIComponent(peerId)}`, { method: "DELETE", keepalive: true });
  peer?.close();
  microphone?.getTracks().forEach((track) => track.stop());
});
render();
void fetch("/ai-api/healthz").then(async (response) => {
  if (!response.ok) throw new Error("service_unavailable");
  const health = await response.json() as { mode: Mode };
  if (health.mode !== "audio-probe" && health.mode !== "local-voice" && health.mode !== "cloud-voice" && health.mode !== "cloud-stream-voice") throw new Error("mode_unknown");
  backendMode = health.mode;
  connectButton.disabled = false;
  render();
}).catch(() => { errorKey = "requestFailed"; render(); });
