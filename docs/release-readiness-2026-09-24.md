# 本地开源发布核对（2026-09-24）

本文件记录**开源首发审查与测试边界**，不是公网 AI 已上线、双向真人跨网通话已验收的证明。首发范围是 human-only 1:1 音视频源码；`/ai.html` 仍是独立的私有原型。

文档整理补记：早期架构、实施计划、命名取舍、开源调研与未来双人 + AI 方案已迁至私有 `project-notebook` 的 LiltCall 方案页；当前产品仓只保留实现/复现文档及脱敏的部署、测试摘要。较长的原始运行记录保留在本地 `docs/.private/` 并由 `.gitignore` 排除，**未备份或推送**。下面的干净副本测试是整理前的历史快照，不代表本次发布候选。

## 已补齐

- 项目所有者选择 Apache-2.0；仓库根目录加入官方完整 [`LICENSE`](../LICENSE)，并在 npm/Python 项目元数据中标注。这只覆盖本项目原创源码，不替第三方依赖、模型权重或声音素材授予许可。
- 增加 [`CONTRIBUTING.md`](../CONTRIBUTING.md)、[`SECURITY.md`](../SECURITY.md)、Bug/Feature Issue 模板及 PR 模板。公开仓库的安全私报入口须在首推源码前启用并验证；文档模板不能替代实际通道。
- README 已有中英文界面、架构与测试边界；截图由 [`tests/capture-readme.mjs`](../tests/capture-readme.mjs) 用合成摄像头画面和假麦克风生成。两幅可编辑 `.excalidraw` 图均无嵌入文件，并有渲染预览；未发现前端外链图片或字体运行时加载。未复制调研项目源码。

## 凭据与依赖审查

- 对本地目录运行 `gitleaks dir . --redact --no-banner`：报告 **2 个需人工核对的匹配**，分别是 `apps/ai/streaming_cloud.py:80` 的代码参数名 `secret_key`、`deploy/coturn/turnserver.conf.example:12` 的大写替换占位符；核对后均不是实际凭据。通用模式的文件名扫描还命中两个 `.example` 配置，内容是替换提示。未发现需要提交的 `.env.local`、`.dev.vars`、私钥文件；`.gitignore` 对这些路径有规则。扫描不是无泄漏保证，也**没有 Git 历史可扫**：首次提交后、公开前必须重新跑工作树和历史扫描，人工检查命中项，不应对整类文件做宽泛豁免。
- `package-lock.json` 当前有 180 个依赖包条目且均有许可证元数据；主要是 MIT、Apache-2.0、ISC、BSD、0BSD、CC0 等。开发工具链的 `sharp`/`libvips` 平台包含 LGPL-3.0-or-later 条款；这些二进制没有放进源码仓库。若将来发布打包应用或镜像，需要按实际分发物重新做完整归因与义务审查。
- 当前本机 AI 虚拟环境有 105 个发行包。直接依赖的 FastAPI、Pipecat、Uvicorn、腾讯云 SDK、websockets 等在已安装元数据中为 MIT/BSD/Apache 类；`pocket-tts` 的已安装包未填许可元数据，其[上游源码许可](https://github.com/kyutai-labs/pocket-tts/blob/main/LICENSE)为 MIT，但**声音/模型资源需另查各自条款**。间接依赖 `num2words` 和 [`soxr`](https://github.com/dofuuz/python-soxr) 带 LGPL；本仓库不打包它们的源码或 wheel。此清单不是所有可选 Python 依赖及其资源的完整 SBOM。

## 已处理的发布前风险与未完成的体验验收

1. GitHub 目标为 `chicogong/liltcall`，首发采用一个 initial commit。先建公开空仓库、启用并核验私密漏洞报告，再推源码；推送后的仓库状态以 GitHub 为准。
2. 公开的默认 Wrangler 配置改为本地配置，不再绑定现用自定义域名；部署需从忽略的生产配置模板明确替换域名与密钥。每房间待用票据上限 12，单连接 10 秒信令消息上限 120；它们是局部滥用刹车，不是全局费用上限。
3. 本机干净副本已完成重新安装与自动化复现；仍需让不熟悉项目的人在另一台机器按文档独立启动，并用不同真实设备/网络做**双向真人**音视频验收，留匿名指标。同机合成媒体、生产强制 TURN 及单向手机反馈不能替代这一关。
4. 若要对外介绍 AI 流式能力，先核对实时 ASR/TTS 额度与后付费、在受控私有环境做真实闭环和延迟/打断/失败测试；目前不能宣称其已部署、已达到延迟目标或可供公网使用。

## 本轮本地回归

2026-09-24，本次发布候选：`npm run check`、`npm run build` 通过；`npm test` 31/31；Python 合同测试 27/27；`npm run test:e2e` 34 通过、1 项需单独凭据的强制 TURN 用例按配置跳过；`npm run test:ai` 无模型 WebRTC 音频探针 4/4；`npm run test:relay:local` 在本机临时 coturn 上强制中转 1/1。`npm audit --audit-level=moderate` 为 0 漏洞。未运行会调用真实云服务的 AI 流式测试，也未运行公网部署测试。这些是本机模拟媒体的测试，不代替两台真实设备验收。

## 干净副本复现

2026-09-24：从仓库的 **115 个未忽略候选文件**复制到全新临时目录，不复制 `.git`、`node_modules`、`.venv`、本机 `.env`/`.dev.vars` 或私钥。副本中 `npm ci` 从空 `node_modules` 安装 78 个适用当前平台的包，`uv sync --extra cloud` 从空 `.venv` 安装 75 个包；Playwright Chromium/WebKit 安装检查通过。随后类型检查、构建、前端单测 31/31、Python 合同测试 27/27、常规浏览器端到端 32 通过/1 按配置跳过、无模型 AI 音频探针 4/4、本地 coturn 强制中转 1/1，全部在副本中通过。

这验证的是**同一台 Mac 上的干净项目目录**，安装仍可使用机器级 npm/uv/浏览器缓存和已装的 `turnserver`，不等于无缓存安装、Linux CI、新人复现或真实跨网通话。额外尝试的 Python Playwright 页面冒烟因其单独的 36.9 MiB 工具包下载持续无进展而中止；项目自带的 Chromium/WebKit 端到端套件已实际打开并操作页面，此项未完成的重复检查不计入通过。未触发真实云 AI 调用或公网测试。
