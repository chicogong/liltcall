import "./style.css";
import { routeFromIceTransport, summarizeConnectionStats, summarizeIceChecks, type ConnectionDiagnostics, type IceCheckCounts, type StatsEntry } from "./connection-diagnostics";
import { resolveLocale, translate, type CopyKey, type Locale } from "./i18n";
import type { IceResponse } from "../../../packages/protocol/src/index";

type Role = "host" | "guest";
type Session = { roomId: string; sessionToken: string; participantId: string; role: Role; expiresAt: number; inviteToken?: string };
type ApiError = { error?: string };
type WireMessage = { type: string; [key: string]: unknown };

const apiBase = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = $("app");
const landingView = $("landing-view");
const prejoinView = $("prejoin-view");
const callView = $("call-view");
const createButton = $<HTMLButtonElement>("create-button");
const joinButton = $<HTMLButtonElement>("join-button");
const enterButton = $<HTMLButtonElement>("enter-button");
const retryButton = $<HTMLButtonElement>("retry-button");
const backButton = $<HTMLButtonElement>("back-button");
const previewStatus = $("preview-status");
const micCheck = document.querySelector<HTMLElement>(".mic-check")!;
const callHeading = $("call-heading");
const callMessage = $("call-message");
const callStatus = $("call-status");
const invitePanel = $("invite-panel");
const copySecondaryButton = $<HTMLButtonElement>("copy-secondary-button");
const notice = $("notice");
const peerLabel = $("peer-label");
const peerDot = $("peer-dot");
const localLabel = $("local-label");
const localAvatar = $("local-avatar");
const callDetail = $("call-detail");
const mediaDiagnostic = $("media-diagnostic");
const mediaNote = $("media-note");
const iceStateLabel = $("ice-state");
const iceDiagnostic = $("ice-diagnostic");
const signalState = $("signal-state");
const micState = $("mic-state");
const remoteAudio = $<HTMLAudioElement>("remote-audio");
const previewVideo = $<HTMLVideoElement>("preview-video");
const localVideo = $<HTMLVideoElement>("local-video");
const remoteVideo = $<HTMLVideoElement>("remote-video");
const previewTile = $("preview-tile");
const selfTile = $("self-tile");
const remoteTile = $("remote-tile");
const previewCameraButton = $<HTMLButtonElement>("preview-camera-button");
const cameraButton = $<HTMLButtonElement>("camera-button");
const meterBars = [...document.querySelectorAll<HTMLElement>("#meter i")];
const languageButton = $<HTMLButtonElement>("language-button");

let savedLanguage: string | null = null;
try { savedLanguage = localStorage.getItem("liltcall:language"); } catch { /* Storage is optional. */ }
let locale: Locale = resolveLocale(savedLanguage, navigator.language);

function setCopy(element: HTMLElement, key: CopyKey, values?: Record<string, string | number>): void {
  element.dataset.i18n = key;
  if (values) element.dataset.i18nParams = JSON.stringify(values);
  else delete element.dataset.i18nParams;
  element.textContent = translate(locale, key, values);
}

function setDetail(key: CopyKey): void {
  delete callDetail.dataset.route;
  delete callDetail.dataset.firstRtpMs;
  delete callDetail.dataset.video;
  mediaDiagnostics = null;
  mediaDiagnostic.hidden = true;
  mediaNote.hidden = true;
  setCopy(callDetail, key);
}

function renderDiagnostic(): void {
  const route = callDetail.dataset.route;
  if (!route) return;
  const routeKey = route === "direct" ? "directP2p" : route === "relay" ? "turnRelay" : "routeUnknown";
  const parts = [translate(locale, "receivingAudio"), translate(locale, routeKey)];
  if (callDetail.dataset.video === "true" && remoteTile.classList.contains("has-video")) parts.push(translate(locale, "receivingVideo"));
  if (firstRtpMs !== null) parts.push(translate(locale, "firstRtp", { seconds: (firstRtpMs / 1000).toFixed(1) }));
  callDetail.textContent = parts.join(" · ");
}

function renderMediaDiagnostic(): void {
  if (!mediaDiagnostics) return;
  const unavailable = translate(locale, "statUnavailable");
  const format = (value: number | null): number | string => value ?? unavailable;
  setCopy(mediaDiagnostic, "mediaDiagnostics", {
    rtt: format(mediaDiagnostics.roundTripTimeMs),
    audioReceived: format(mediaDiagnostics.audioPacketsReceived),
    audioJitter: format(mediaDiagnostics.audioJitterMs),
    audioLost: format(mediaDiagnostics.audioPacketsLost),
    videoReceived: format(mediaDiagnostics.videoPacketsReceived),
    videoJitter: format(mediaDiagnostics.videoJitterMs),
    videoLost: format(mediaDiagnostics.videoPacketsLost),
    videoFreezes: format(mediaDiagnostics.videoFreezeCount),
  });
  mediaDiagnostic.hidden = false;
  mediaNote.hidden = false;
}

function renderLanguage(): void {
  document.documentElement.lang = locale;
  document.title = translate(locale, "pageTitle");
  document.querySelector<HTMLMetaElement>('meta[name="description"]')!.content = translate(locale, "pageDescription");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const values = element.dataset.i18nParams ? JSON.parse(element.dataset.i18nParams) as Record<string, string | number> : undefined;
    element.textContent = translate(locale, element.dataset.i18n as CopyKey, values);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", translate(locale, element.dataset.i18nAriaLabel as CopyKey));
  });
  languageButton.textContent = locale === "en" ? "中文" : "EN";
  languageButton.setAttribute("aria-label", translate(locale, locale === "en" ? "switchToChinese" : "switchToEnglish"));
  renderDiagnostic();
  renderMediaDiagnostic();
  renderIceDiagnostic();
}

function setLandingMode(mode: "home" | "rejoin" | "invite" | "unavailable"): void {
  const keys = {
    home: ["homeKicker", "homeTitle", "homeDescription"],
    rejoin: ["rejoinKicker", "rejoinTitle", "rejoinDescription"],
    invite: ["inviteKicker", "inviteTitle", "inviteDescription"],
    unavailable: ["unavailableKicker", "unavailableTitle", "unavailableDescription"],
  } as const;
  const [kicker, title, description] = keys[mode];
  setCopy($("room-kicker"), kicker);
  setCopy($("page-title"), title);
  setCopy($("room-description"), description);
  setCopy($("join-button-label"), mode === "rejoin" ? "rejoinThisCall" : "joinThisCall");
  createButton.hidden = mode !== "home";
  joinButton.hidden = mode !== "rejoin" && mode !== "invite";
}

let session: Session | null = null;
let localStream: MediaStream | null = null;
let peer: RTCPeerConnection | null = null;
let videoSender: RTCRtpSender | null = null;
let remoteVideoTrack: MediaStreamTrack | null = null;
let remoteCameraEnabled = true;
let peerCreating: Promise<RTCPeerConnection> | null = null;
let peerGeneration = 0;
let socket: WebSocket | null = null;
let readySocket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let directRetryTimer: ReturnType<typeof setTimeout> | null = null;
let socketWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let statsTimer: ReturnType<typeof setTimeout> | null = null;
let audioContext: AudioContext | null = null;
let animationFrame = 0;
let awaitingAudioGesture = false;
let pendingCandidates: RTCIceCandidateInit[] = [];
let offerInFlightGeneration: number | null = null;
let stopped = false;
let setupStartedAt: number | null = null;
let firstRtpMs: number | null = null;
let mediaDiagnostics: ConnectionDiagnostics | null = null;
let reconnectAttempt = 0;
let directRetryCount = 0;
let stunErrorCount = 0;
let candidateErrorCount = 0;
let localHostCount = 0;
let localPublicCount = 0;
let localRelayCount = 0;
let remoteHostCount = 0;
let remotePublicCount = 0;
let remoteRelayCount = 0;
let iceChecks: IceCheckCounts = { candidatePairs: null, remoteCandidates: null, requestsSent: null, requestsReceived: null, responsesSent: null, responsesReceived: null };
let pendingKind: "create" | "join" | null = null;
let preparationId = 0;

const SOCKET_CHECK_MS = 5000;
const SOCKET_STALE_MS = 15_000;
const MAX_ICE_RETRIES = 2;

function candidateKind(candidate: string): "host" | "public" | "relay" | null {
  if (/\btyp host\b/i.test(candidate)) return "host";
  if (/\btyp (srflx|prflx)\b/i.test(candidate)) return "public";
  if (/\btyp relay\b/i.test(candidate)) return "relay";
  return null;
}

function renderIceDiagnostic(): void {
  const iceState = peer?.iceConnectionState ?? "new";
  const stateKeys: Record<RTCIceConnectionState, CopyKey> = {
    new: "iceStateNew", checking: "iceStateChecking", connected: "iceStateConnected",
    completed: "iceStateCompleted", disconnected: "iceStateDisconnected",
    failed: "iceStateFailed", closed: "iceStateClosed",
  };
  iceStateLabel.textContent = translate(locale, stateKeys[iceState]);
  setCopy(iceDiagnostic, "iceDiagnostics", {
    localHost: localHostCount, localPublic: localPublicCount, localRelay: localRelayCount,
    remoteHost: remoteHostCount, remotePublic: remotePublicCount, remoteRelay: remoteRelayCount,
    candidatePairs: iceChecks.candidatePairs ?? translate(locale, "statUnavailable"),
    remoteCandidates: iceChecks.remoteCandidates ?? translate(locale, "statUnavailable"),
    checksSent: iceChecks.requestsSent ?? translate(locale, "statUnavailable"),
    checksReceived: iceChecks.requestsReceived ?? translate(locale, "statUnavailable"),
    repliesSent: iceChecks.responsesSent ?? translate(locale, "statUnavailable"),
    repliesReceived: iceChecks.responsesReceived ?? translate(locale, "statUnavailable"),
    stunErrors: stunErrorCount, candidateErrors: candidateErrorCount, retries: directRetryCount,
  });
}

function clearDirectRetry(): void {
  if (directRetryTimer) clearTimeout(directRetryTimer);
  directRetryTimer = null;
}

function scheduleDirectRetry(pc: RTCPeerConnection, delay: number): void {
  if (directRetryTimer || stopped || peer !== pc) return;
  directRetryTimer = setTimeout(() => {
    directRetryTimer = null;
    void retryDirect(pc);
  }, delay);
}

async function retryDirect(pc: RTCPeerConnection): Promise<void> {
  if (peer !== pc || stopped || pc.connectionState === "connected") return;
  if (directRetryCount >= MAX_ICE_RETRIES) {
    setPresence("failed");
    setDetail("connectionUnavailable");
    showNotice("connectionUnavailable");
    return;
  }
  ++directRetryCount;
  renderIceDiagnostic();
  setPresence("reconnecting");
  setDetail("connectionRetrying");
  if (session?.role === "host") await sendOffer(true);
  else send({ type: "restart-request" });
  if (peer === pc && !stopped) scheduleDirectRetry(pc, 9000);
}

const roomIdInUrl = /^\/r\/([A-Za-z0-9_-]{24})$/.exec(location.pathname)?.[1] ?? null;
const inviteInUrl = new URLSearchParams(location.hash.slice(1)).get("invite");

function storedSession(roomId: string): Session | null {
  try {
    const raw = sessionStorage.getItem(`liltcall:${roomId}`);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object") {
      const candidate = value as Partial<Session>;
      if (candidate.roomId === roomId && /^[A-Za-z0-9_-]{32,128}$/.test(candidate.sessionToken ?? "")
        && (candidate.role === "host" || candidate.role === "guest") && typeof candidate.participantId === "string"
        && (candidate.role !== "host" || /^[A-Za-z0-9_-]{32,128}$/.test(candidate.inviteToken ?? ""))
        && typeof candidate.expiresAt === "number" && candidate.expiresAt > Date.now()) return candidate as Session;
    }
    sessionStorage.removeItem(`liltcall:${roomId}`);
  } catch { /* A blocked or malformed store must not prevent a new call. */ }
  return null;
}

function saveSession(value: Session): void {
  try { sessionStorage.setItem(`liltcall:${value.roomId}`, JSON.stringify(value)); } catch { /* Rejoin is unavailable without storage. */ }
}

function forgetSession(roomId: string): void {
  try { sessionStorage.removeItem(`liltcall:${roomId}`); } catch { /* Storage is optional. */ }
}

if (roomIdInUrl) {
  session = storedSession(roomIdInUrl);
  if (session?.roomId === roomIdInUrl) setLandingMode("rejoin");
  else if (inviteInUrl && /^[A-Za-z0-9_-]{32,128}$/.test(inviteInUrl)) setLandingMode("invite");
  else setLandingMode("unavailable");
}

renderLanguage();
languageButton.addEventListener("click", () => {
  locale = locale === "en" ? "zh-CN" : "en";
  try { localStorage.setItem("liltcall:language", locale); } catch { /* This tab still switches language. */ }
  renderLanguage();
});

createButton.addEventListener("click", () => void prepare("create"));
joinButton.addEventListener("click", () => void prepare("join"));
enterButton.addEventListener("click", () => void enterCall());
retryButton.addEventListener("click", () => { if (pendingKind) void prepare(pendingKind); });
backButton.addEventListener("click", leavePreview);
$<HTMLButtonElement>("mute-button").addEventListener("click", toggleMute);
previewCameraButton.addEventListener("click", () => void toggleCamera());
cameraButton.addEventListener("click", () => void toggleCamera());
$<HTMLButtonElement>("copy-button").addEventListener("click", () => void copyInvite());
copySecondaryButton.addEventListener("click", () => void copyInvite());
$<HTMLButtonElement>("end-button").addEventListener("click", () => void endCall());
window.addEventListener("pagehide", () => cleanup());

async function api<T>(path: string, method: "GET" | "POST", body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json() as T & ApiError;
  if (!response.ok) throw new Error(data.error ?? `request_failed_${response.status}`);
  return data;
}

function showView(view: "home" | "prejoin" | "call"): void {
  shell.dataset.view = view;
  landingView.hidden = view !== "home";
  prejoinView.hidden = view !== "prejoin";
  callView.hidden = view !== "call";
  const heading = view === "home" ? $("page-title") : view === "prejoin" ? $("preview-title") : callHeading;
  heading.focus();
}

const audioConstraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const videoConstraints: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };

function updateCameraUi(): void {
  const track = localStream?.getVideoTracks().find((item) => item.readyState === "live") ?? null;
  const cameraOn = !!track;
  const preview = track ? new MediaStream([track]) : null;
  previewVideo.srcObject = preview;
  localVideo.srcObject = preview;
  if (preview) {
    void previewVideo.play().catch(() => {});
    void localVideo.play().catch(() => {});
  }
  previewTile.classList.toggle("has-video", cameraOn);
  selfTile.classList.toggle("has-video", cameraOn);
  previewCameraButton.disabled = !localStream;
  cameraButton.disabled = !localStream;
  previewCameraButton.setAttribute("aria-pressed", String(cameraOn));
  cameraButton.setAttribute("aria-pressed", String(cameraOn));
  setCopy(previewCameraButton.querySelector<HTMLElement>("span")!, cameraOn ? "turnCameraOff" : "turnCameraOn");
  setCopy($("camera-button-label"), cameraOn ? "turnCameraOff" : "turnCameraOn");
}

function renderRemoteVideo(): void {
  remoteTile.classList.toggle("has-video", remoteCameraEnabled && remoteVideoTrack?.readyState === "live" && !remoteVideoTrack.muted);
  renderDiagnostic();
}

async function toggleCamera(): Promise<void> {
  const stream = localStream;
  if (!stream) return;
  previewCameraButton.disabled = cameraButton.disabled = true;
  const current = stream.getVideoTracks()[0];
  try {
    if (current) {
      if (videoSender) await videoSender.replaceTrack(null);
      if (localStream !== stream) return;
      current.stop();
      stream.removeTrack(current);
      if (videoSender?.track === current) await videoSender.replaceTrack(null);
    } else {
      const captured = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
      const track = captured.getVideoTracks()[0];
      if (!track || localStream !== stream || stopped) { captured.getTracks().forEach((item) => item.stop()); return; }
      try { if (videoSender) await videoSender.replaceTrack(track); }
      catch (error) { track.stop(); throw error; }
      if (localStream !== stream || stopped) { track.stop(); return; }
      stream.addTrack(track);
      try { if (videoSender && videoSender.track !== track) await videoSender.replaceTrack(track); }
      catch (error) { stream.removeTrack(track); track.stop(); throw error; }
      track.addEventListener("ended", () => {
        if (localStream !== stream) return;
        stream.removeTrack(track);
        void videoSender?.replaceTrack(null).catch(() => {});
        updateCameraUi();
        send({ type: "camera", enabled: false });
      }, { once: true });
    }
    updateCameraUi();
    send({ type: "camera", enabled: !!stream.getVideoTracks()[0] });
  } catch {
    updateCameraUi();
    send({ type: "camera", enabled: !!localStream?.getVideoTracks()[0] });
    showNotice("cameraUnavailable");
  }
  finally { previewCameraButton.disabled = cameraButton.disabled = !localStream; }
}

async function prepare(kind: "create" | "join"): Promise<void> {
  const requestId = ++preparationId;
  pendingKind = kind;
  cleanup();
  stopped = false;
  clearNotice();
  setCopy($("preview-title"), kind === "create" ? "createPreviewTitle" : "joinPreviewTitle");
  setCopy($("preview-description"), kind === "create" ? "createPreviewDescription" : "joinPreviewDescription");
  setCopy($("enter-button-label"), kind === "create" ? "createRoom" : "joinCall");
  enterButton.disabled = true;
  retryButton.hidden = true;
  setCopy(previewStatus, "requestingMicrophone");
  previewCameraButton.disabled = true;
  micCheck.classList.remove("is-ready");
  showView("prejoin");
  try {
    let stream: MediaStream;
    let cameraFallback = false;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: videoConstraints }); }
    catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      cameraFallback = true;
    }
    if (requestId !== preparationId || shell.dataset.view !== "prejoin") { stream.getTracks().forEach((track) => track.stop()); return; }
    localStream = stream;
    updateCameraUi();
    let meterReady = false;
    try { startMeter(stream); meterReady = true; }
    catch { void audioContext?.close(); audioContext = null; }
    micCheck.classList.toggle("is-ready", meterReady);
    setCopy(previewStatus, cameraFallback ? "microphoneReadyNoCamera" : meterReady ? "microphoneReady" : "microphoneReadyNoMeter");
    enterButton.disabled = false;
  } catch (error) {
    if (requestId !== preparationId) return;
    setCopy(previewStatus, error instanceof Error ? explain(`${error.name}:${error.message}`) : "microphoneUnavailable");
    retryButton.hidden = false;
  }
}

function leavePreview(): void {
  ++preparationId;
  pendingKind = null;
  cleanup();
  clearNotice();
  showView("home");
}

async function enterCall(): Promise<void> {
  if (!pendingKind || !localStream) return;
  const kind = pendingKind;
  enterButton.disabled = backButton.disabled = true;
  clearNotice();
  setupStartedAt = kind === "join" ? performance.now() : null;
  firstRtpMs = null;
  stopped = false;
  try {
    if (kind === "create") {
      session = await api<Session & { inviteToken: string }>("/v1/rooms", "POST");
      history.pushState(null, "", `/r/${session.roomId}`);
    } else if (session && roomIdInUrl === session.roomId) {
      await api(`/v1/rooms/${session.roomId}/session`, "GET", undefined, session.sessionToken);
    } else if (roomIdInUrl && inviteInUrl) {
      session = await api<Session>(`/v1/rooms/${roomIdInUrl}/join`, "POST", { inviteToken: inviteInUrl });
      history.replaceState(null, "", `/r/${session.roomId}`);
    } else throw new Error("invalid_invite");
    saveSession(session);
    pendingKind = null;
    showCall();
    await connectSocket();
  } catch (error) {
    showNotice(error instanceof Error ? explain(error.message) : "joinError");
  } finally {
    enterButton.disabled = false;
    backButton.disabled = false;
  }
}

type Presence = "waiting" | "joining" | "connected" | "reconnecting" | "failed";

function setPresence(state: Presence): void {
  const host = session?.role === "host";
  callView.dataset.peer = state;
  const copy: Record<Presence, readonly [CopyKey, CopyKey, CopyKey]> = {
    waiting: host ? ["waitingHostTitle", "waitingHostMessage", "waiting"] : ["waitingGuestTitle", "waitingGuestMessage", "waiting"],
    joining: ["joiningTitle", "joiningMessage", "joiningStatus"],
    connected: ["connectedTitle", "connectedMessage", "connected"],
    reconnecting: ["reconnectingTitle", "reconnectingMessage", "reconnecting"],
    failed: ["failedTitle", "failedMessage", "failedStatus"],
  };
  const [heading, message, status] = copy[state];
  setCopy(callHeading, heading);
  setCopy(callMessage, message);
  setCopy(callStatus, status);
  setCopy(peerLabel, state === "connected" ? "connected" : state === "waiting" ? "waitingToJoin" : state === "failed" ? "connectionFailed" : "peerConnecting");
  peerDot.classList.toggle("live", state === "connected");
  invitePanel.hidden = !host || state === "connected";
  copySecondaryButton.hidden = !host || state !== "connected";
}

function showCall(): void {
  invitePanel.classList.remove("show-link");
  setCopy($("call-room-label"), "roomName", { id: session!.roomId.slice(0, 8).toUpperCase() });
  $<HTMLInputElement>("invite-link").value = session!.inviteToken
    ? `${location.origin}/r/${session!.roomId}#invite=${session!.inviteToken}` : "";
  setCopy($("end-button"), session!.role === "host" ? "endRoom" : "leaveCall");
  setCopy($("mute-button-label"), "muteMic");
  $<HTMLButtonElement>("mute-button").setAttribute("aria-pressed", "false");
  setCopy(localLabel, "microphoneOn");
  localAvatar.classList.remove("is-muted");
  setCopy(signalState, "signalConnecting");
  setCopy(micState, "micOn");
  updateCameraUi();
  setDetail("signalingConnecting");
  renderIceDiagnostic();
  $<HTMLDetailsElement>("call-info").open = false;
  setPresence("joining");
  showView("call");
}

function clearSocketWatchdog(): void {
  if (socketWatchdogTimer) clearInterval(socketWatchdogTimer);
  socketWatchdogTimer = null;
}

function scheduleReconnect(): void {
  if (reconnectTimer || stopped) return;
  const delay = Math.min(500 * 2 ** reconnectAttempt++, 8000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectSocket();
  }, delay);
}

function dropSocket(ws: WebSocket): void {
  if (socket !== ws || stopped) return;
  socket = null;
  readySocket = null;
  clearSocketWatchdog();
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  setCopy(signalState, "signalReconnecting");
  setDetail("signalingInterrupted");
  if (peer?.connectionState === "connected") setCopy(callStatus, "audioLiveReconnecting");
  else setPresence("reconnecting");
  scheduleReconnect();
}

async function connectSocket(): Promise<void> {
  if (!session || stopped) return;
  const own = session;
  try {
    const { ticket } = await api<{ ticket: string }>(`/v1/rooms/${own.roomId}/ws-ticket`, "POST", undefined, own.sessionToken);
    if (stopped || session !== own) return;
    const url = new URL(`${apiBase}/v1/rooms/${own.roomId}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url.toString());
    socket = ws;
    let lastMessageAt = Date.now();
    clearSocketWatchdog();
    socketWatchdogTimer = setInterval(() => {
      if (socket !== ws || stopped) { clearSocketWatchdog(); return; }
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED || Date.now() - lastMessageAt >= SOCKET_STALE_MS) {
        dropSocket(ws);
      } else if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch { dropSocket(ws); }
      }
    }, SOCKET_CHECK_MS);
    ws.addEventListener("open", () => {
      if (socket === ws && !stopped) ws.send(JSON.stringify({ type: "auth", ticket }));
      else ws.close();
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws || stopped) return;
      lastMessageAt = Date.now();
      const generation = peerGeneration;
      void handleMessage(event.data, ws).catch((error) => {
        if (socket === ws && !stopped && generation === peerGeneration && !isPeerCancelled(error)) {
          showNotice(explain(error instanceof Error ? error.message : "connection_failed"));
        }
      });
    });
    ws.addEventListener("close", () => dropSocket(ws));
  } catch (error) {
    if (stopped || session !== own) return;
    if (error instanceof Error && /room_unavailable|room_not_found|unauthorized/.test(error.message)) { roomEnded(); return; }
    setCopy(signalState, "signalReconnecting");
    if (peer?.connectionState !== "connected") setPresence("reconnecting");
    scheduleReconnect();
  }
}

async function handleMessage(raw: string, source: WebSocket): Promise<void> {
  let data: WireMessage;
  try { data = JSON.parse(raw) as WireMessage; } catch { return; }
  if (data.type === "ready") {
    readySocket = source;
    reconnectAttempt = 0;
    setCopy(signalState, "signalReady");
    setDetail(data.peerPresent ? "waitingForAudio" : "inviteSomeone");
    if (peer?.connectionState === "connected") setPresence("connected");
    else setPresence(data.peerPresent ? "joining" : "waiting");
    if (data.peerPresent) send({ type: "camera", enabled: !!localStream?.getVideoTracks()[0] });
    if (data.peerPresent && session?.role === "host") {
      const existingPeer = peer;
      if (existingPeer && existingPeer.connectionState !== "connected" && existingPeer.signalingState !== "stable") resetPeer();
      if (peer?.connectionState !== "connected") setupStartedAt ??= performance.now();
      await sendOffer(!!existingPeer);
    } else if (data.peerPresent && session?.role === "guest" && peer && peer.connectionState !== "connected") {
      send({ type: "restart-request" });
    }
  } else if (data.type === "peer-joined") {
    setPresence(peer?.connectionState === "connected" ? "connected" : "joining");
    if (peer?.connectionState !== "connected") setDetail("waitingForAudio");
    send({ type: "camera", enabled: !!localStream?.getVideoTracks()[0] });
    if (session?.role === "host") {
      if (peer?.connectionState !== "connected") setupStartedAt ??= performance.now();
      await sendOffer(!!peer);
    }
  } else if (data.type === "restart-request" && session?.role === "host") {
    if (!peer || peer.signalingState === "stable") await sendOffer(!!peer);
  } else if (data.type === "peer-left") {
    setPresence("waiting");
    resetPeer();
    setDetail(session?.role === "host" ? "inviteSomeone" : "waitingForAudio");
  } else if (data.type === "offer" && session?.role === "guest") {
    setupStartedAt ??= performance.now();
    let pc: RTCPeerConnection;
    const generation = peerGeneration;
    const own = session;
    try { pc = await ensurePeer(); }
    catch (error) {
      if (!isPeerCancelled(error) && socket === source && !stopped) showNotice(explain(error instanceof Error ? error.message : "connection_failed"));
      return;
    }
    if (!isCurrentPeer(pc, generation, own) || socket !== source) return;
    await pc.setRemoteDescription(data.description as RTCSessionDescriptionInit);
    if (!isCurrentPeer(pc, generation, own) || socket !== source) return;
    const remoteVideoTransceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === "video");
    if (remoteVideoTransceiver) {
      remoteVideoTransceiver.direction = "sendrecv";
      videoSender = remoteVideoTransceiver.sender;
      await videoSender.replaceTrack(localStream?.getVideoTracks()[0] ?? null);
    }
    if (!isCurrentPeer(pc, generation, own) || socket !== source) return;
    await flushCandidates(pc);
    if (!isCurrentPeer(pc, generation, own) || socket !== source) return;
    const answer = await pc.createAnswer();
    if (!isCurrentPeer(pc, generation, own) || socket !== source) return;
    await pc.setLocalDescription(answer);
    if (!isCurrentPeer(pc, generation, own) || socket !== source) return;
    send({ type: "answer", description: pc.localDescription });
  } else if (data.type === "answer" && session?.role === "host" && peer?.signalingState === "have-local-offer") {
    const pc = peer;
    await pc.setRemoteDescription(data.description as RTCSessionDescriptionInit);
    if (peer === pc && !stopped && socket === source) await flushCandidates(pc);
  } else if (data.type === "ice") {
    const candidate = data.candidate as RTCIceCandidateInit;
    const kind = candidateKind(candidate.candidate ?? "");
    if (kind === "host") ++remoteHostCount;
    else if (kind === "public") ++remotePublicCount;
    else if (kind === "relay") ++remoteRelayCount;
    renderIceDiagnostic();
    if (peer?.remoteDescription) await addRemoteCandidate(peer, candidate);
    else pendingCandidates.push(candidate);
  } else if (data.type === "camera" && typeof data.enabled === "boolean") {
    remoteCameraEnabled = data.enabled;
    renderRemoteVideo();
  } else if (data.type === "room-closed") roomEnded();
}

function isPeerCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === "peer_cancelled";
}

function isCurrentPeer(pc: RTCPeerConnection, generation: number, own: Session | null): boolean {
  return peer === pc && peerGeneration === generation && session === own && !stopped;
}

function clearAudioResume(): void {
  awaitingAudioGesture = false;
  document.removeEventListener("pointerdown", retryRemoteAudio);
  document.removeEventListener("keydown", retryRemoteAudio);
}

function retryRemoteAudio(event: Event): void {
  if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
  clearAudioResume();
  if (stopped || !remoteAudio.srcObject) return;
  void remoteAudio.play().then(() => {
    if (notice.dataset.i18n === "tapForAudio") clearNotice();
  }).catch(() => {
    if (!stopped && remoteAudio.srcObject) requestAudioResume();
  });
}

function requestAudioResume(): void {
  showNotice("tapForAudio");
  if (awaitingAudioGesture) return;
  awaitingAudioGesture = true;
  document.addEventListener("pointerdown", retryRemoteAudio);
  document.addEventListener("keydown", retryRemoteAudio);
}

async function ensurePeer(): Promise<RTCPeerConnection> {
  if (peer) return peer;
  if (peerCreating) return peerCreating;
  const own = session;
  const stream = localStream;
  if (!own || !stream || stopped) throw new Error("peer_cancelled");
  const generation = peerGeneration;
  const creating = (async () => {
    const ice = await api<IceResponse>(`/v1/rooms/${own.roomId}/ice-servers`, "GET", undefined, own.sessionToken);
    if (generation !== peerGeneration || session !== own || localStream !== stream || stopped) throw new Error("peer_cancelled");
    const validServers = ice.iceServers?.length > 0 && ice.iceServers.every((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const relay = urls.some((url) => typeof url === "string" && /^turns?:/.test(url));
      return urls.length > 0 && urls.every((url) => typeof url === "string" && /^(stun:|turn:|turns:)/.test(url))
        && (!relay || (typeof server.username === "string" && !!server.username && typeof server.credential === "string" && !!server.credential));
    });
    const hasRelay = ice.iceServers?.some((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => typeof url === "string" && /^turns?:/.test(url)));
    if (!validServers || (ice.policy === "direct_only" && hasRelay) || (ice.policy === "relay_allowed" && !hasRelay)
      || (ice.policy !== "direct_only" && ice.policy !== "relay_allowed")) throw new Error("ice_config_invalid");
    const pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: "all" });
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    if (own.role === "host") {
      const video = stream.getVideoTracks()[0];
      videoSender = pc.addTransceiver(video ?? "video", { direction: "sendrecv", streams: [stream] }).sender;
    }
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate && isCurrentPeer(pc, generation, own)) {
        const kind = candidateKind(event.candidate.candidate);
        if (kind === "host") ++localHostCount;
        else if (kind === "public") ++localPublicCount;
        else if (kind === "relay") ++localRelayCount;
        renderIceDiagnostic();
        send({ type: "ice", candidate: event.candidate.toJSON() });
      }
    });
    pc.addEventListener("icecandidateerror", () => {
      if (!isCurrentPeer(pc, generation, own)) return;
      ++stunErrorCount;
      renderIceDiagnostic();
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      if (isCurrentPeer(pc, generation, own)) renderIceDiagnostic();
    });
    pc.addEventListener("track", (event) => {
      if (!isCurrentPeer(pc, generation, own)) return;
      if (event.track.kind === "video") {
        remoteVideoTrack = event.track;
        remoteVideo.srcObject = new MediaStream([event.track]);
        const renderVideo = () => {
          if (isCurrentPeer(pc, generation, own)) renderRemoteVideo();
        };
        event.track.addEventListener("mute", renderVideo);
        event.track.addEventListener("unmute", renderVideo);
        event.track.addEventListener("ended", renderVideo);
        renderVideo();
        void remoteVideo.play().catch(() => {});
      } else if (event.track.kind === "audio") {
        remoteAudio.srcObject = new MediaStream([event.track]);
        void remoteAudio.play().catch(() => { if (isCurrentPeer(pc, generation, own)) requestAudioResume(); });
      }
    });
    pc.addEventListener("connectionstatechange", () => {
      if (!isCurrentPeer(pc, generation, own)) return;
      const state = pc.connectionState;
      if (state === "connected") {
        clearDirectRetry();
        directRetryCount = 0;
        if (notice.dataset.i18n === "connectionRetrying" || notice.dataset.i18n === "connectionUnavailable") clearNotice();
      }
      setPresence(state === "connected" ? "connected" : state === "failed" || state === "disconnected" ? "reconnecting" : "joining");
      if (state === "failed" || state === "disconnected") setDetail("audioInterrupted");
      if (state === "failed" || state === "disconnected") scheduleDirectRetry(pc, state === "failed" ? 1000 : 3000);
      renderIceDiagnostic();
    });
    peer = pc;
    scheduleStats(pc);
    return pc;
  })();
  peerCreating = creating;
  try { return await creating; } finally { if (peerCreating === creating) peerCreating = null; }
}

async function sendOffer(restart = false): Promise<void> {
  const own = session;
  const generation = peerGeneration;
  if (offerInFlightGeneration === generation || stopped || own?.role !== "host") return;
  offerInFlightGeneration = generation;
  try {
    const pc = await ensurePeer();
    if (!isCurrentPeer(pc, generation, own) || pc.signalingState !== "stable") return;
    const offer = await pc.createOffer({ iceRestart: restart });
    if (!isCurrentPeer(pc, generation, own)) return;
    await pc.setLocalDescription(offer);
    if (!isCurrentPeer(pc, generation, own)) return;
    send({ type: "offer", description: pc.localDescription });
  } catch (error) {
    if (generation === peerGeneration && session === own && !stopped && !isPeerCancelled(error)) {
      showNotice(explain(error instanceof Error ? error.message : "connection_failed"));
    }
  } finally { if (offerInFlightGeneration === generation) offerInFlightGeneration = null; }
}

async function flushCandidates(pc: RTCPeerConnection): Promise<void> {
  const queued = pendingCandidates.splice(0);
  for (const candidate of queued) {
    if (peer !== pc || stopped) return;
    await addRemoteCandidate(pc, candidate);
  }
}
async function addRemoteCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
  try { await pc.addIceCandidate(candidate); }
  catch {
    if (peer !== pc || stopped) return;
    ++candidateErrorCount;
    renderIceDiagnostic();
  }
}
function send(value: unknown): boolean {
  const ws = socket;
  if (!ws || ws !== readySocket || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify(value)); return true; }
  catch { dropSocket(ws); return false; }
}

async function updateStats(pc: RTCPeerConnection): Promise<void> {
  if (peer !== pc) return;
  try {
    const reports: StatsEntry[] = [];
    (await pc.getStats()).forEach((report) => reports.push(report as unknown as StatsEntry));
    if (peer !== pc) return;
    iceChecks = summarizeIceChecks(reports);
    renderIceDiagnostic();
    if (pc.connectionState !== "connected") return;
    const diagnostic = summarizeConnectionStats(reports);
    if (diagnostic.inboundAudioPackets === 0) return;
    if (diagnostic.route === "unknown") diagnostic.route = routeFromIceTransport(pc);
    if (firstRtpMs === null && setupStartedAt !== null) firstRtpMs = Math.round(performance.now() - setupStartedAt);
    callDetail.dataset.route = diagnostic.route;
    mediaDiagnostics = diagnostic;
    callDetail.dataset.video = String(diagnostic.inboundVideoPackets > 0);
    if (firstRtpMs !== null) callDetail.dataset.firstRtpMs = String(firstRtpMs);
    delete callDetail.dataset.i18n;
    delete callDetail.dataset.i18nParams;
    renderDiagnostic();
    renderMediaDiagnostic();
  } catch { /* The peer may have closed while getStats was in flight. */ }
}

function scheduleStats(pc: RTCPeerConnection): void {
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    statsTimer = null;
    void updateStats(pc).finally(() => {
      if (peer === pc && !stopped) scheduleStats(pc);
    });
  }, pc.connectionState === "connected" && firstRtpMs === null ? 200 : 1000);
}

function startMeter(stream: MediaStream): void {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.frequencyBinCount);
  const draw = () => {
    analyser.getByteFrequencyData(samples);
    const level = localStream?.getAudioTracks()[0]?.enabled
      ? Math.min(1, samples.reduce((sum, n) => sum + n, 0) / samples.length / 90)
      : 0;
    meterBars.forEach((bar, index) => {
      const shape = .28 + .72 * Math.sin((index / (meterBars.length - 1)) * Math.PI);
      bar.style.setProperty("--level", String(level * shape));
    });
    localAvatar.style.setProperty("--mic-level", String(level));
    animationFrame = requestAnimationFrame(draw);
  };
  draw();
}

function toggleMute(): void {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const muted = !track.enabled;
  const button = $<HTMLButtonElement>("mute-button");
  setCopy($("mute-button-label"), muted ? "unmuteMic" : "muteMic");
  button.setAttribute("aria-pressed", String(muted));
  setCopy(micState, muted ? "micMuted" : "micOn");
  setCopy(localLabel, muted ? "microphoneMuted" : "microphoneOn");
  localAvatar.classList.toggle("is-muted", muted);
}

async function copyInvite(): Promise<void> {
  if (!session?.inviteToken) return;
  const field = $<HTMLInputElement>("invite-link");
  const link = field.value;
  try { await navigator.clipboard.writeText(link); showNotice("inviteCopied"); }
  catch {
    invitePanel.hidden = false;
    invitePanel.classList.add("show-link");
    copySecondaryButton.hidden = true;
    field.focus();
    field.select();
    showNotice("copyFailed");
  }
}

async function endCall(): Promise<void> {
  const current = session;
  let leavePending = false;
  if (current?.role === "host") {
    try { await api(`/v1/rooms/${current.roomId}/close`, "POST", undefined, current.sessionToken); }
    catch { showNotice("closeFailed"); return; }
  } else if (current?.role === "guest") {
    try { await api(`/v1/rooms/${current.roomId}/leave`, "POST", undefined, current.sessionToken); }
    catch { leavePending = true; }
  }
  roomEnded();
  if (leavePending) showNotice("leavePending");
}

function roomEnded(): void {
  if (session) forgetSession(session.roomId);
  cleanup();
  session = null;
  pendingKind = null;
  history.replaceState(null, "", "/");
  setLandingMode("home");
  setCopy(signalState, "signalIdle");
  setCopy(micState, "micOff");
  showView("home");
  showNotice("callEnded");
}

function resetPeer(): void {
  ++peerGeneration;
  offerInFlightGeneration = null;
  clearDirectRetry();
  directRetryCount = stunErrorCount = candidateErrorCount = 0;
  localHostCount = localPublicCount = localRelayCount = remoteHostCount = remotePublicCount = remoteRelayCount = 0;
  iceChecks = { candidatePairs: null, remoteCandidates: null, requestsSent: null, requestsReceived: null, responsesSent: null, responsesReceived: null };
  clearAudioResume();
  if (statsTimer) clearTimeout(statsTimer);
  statsTimer = null;
  const previousPeer = peer;
  peer = null;
  videoSender = null;
  previousPeer?.close();
  peerCreating = null;
  remoteAudio.srcObject = null;
  remoteVideo.srcObject = null;
  remoteVideoTrack = null;
  remoteCameraEnabled = true;
  remoteTile.classList.remove("has-video");
  pendingCandidates = [];
  firstRtpMs = null;
  setupStartedAt = null;
  delete callDetail.dataset.route;
  delete callDetail.dataset.firstRtpMs;
  delete callDetail.dataset.video;
  mediaDiagnostics = null;
  mediaDiagnostic.hidden = true;
  mediaNote.hidden = true;
  renderIceDiagnostic();
}
function cleanup(): void {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearSocketWatchdog();
  if (socket) { const previous = socket; socket = null; previous.close(); }
  readySocket = null;
  resetPeer();
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  updateCameraUi();
  if (animationFrame) cancelAnimationFrame(animationFrame);
  void audioContext?.close();
  audioContext = null;
  meterBars.forEach((bar) => bar.style.setProperty("--level", "0"));
  localAvatar.style.setProperty("--mic-level", "0");
  micCheck.classList.remove("is-ready");
}
function clearNotice(): void { delete notice.dataset.i18n; notice.textContent = ""; }
function showNotice(key: CopyKey): void { setCopy(notice, key); }
function explain(code: string): CopyKey {
  if (/rate_limited/.test(code)) return "rateLimited";
  if (/ice_config_invalid|turn_unavailable/.test(code)) return "connectionUnavailable";
  if (/NotAllowedError|PermissionDeniedError/.test(code)) return "permissionDenied";
  if (/room_full/.test(code)) return "roomFull";
  if (/room_unavailable|room_not_found/.test(code)) return "roomUnavailable";
  if (/invalid_invite|unauthorized/.test(code)) return "invalidInvite";
  return "connectionError";
}
