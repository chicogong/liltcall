# Contributing to LiltCall

LiltCall is a small, inspectable two-person WebRTC call project. The public human-call path and the private one-human/one-AI prototype are deliberately separate. Please keep their media, authorization, and deployment boundaries explicit in any change.

## Start locally

Follow [本地运行](README.md#本地运行) for the web UI and Worker. The AI prototype has its own [local setup guide](docs/ai-local-spike.md); ordinary contributors do not need cloud credentials or a paid account.

Before opening a pull request, run the checks relevant to your change:

```bash
npm ci
npm run check
npm test
npm run build
npm run test:e2e
```

The ordinary E2E suite uses local fake media; its forced-TURN case is skipped without separate credentials. `npm run test:ai` checks the no-model local audio path. Python AI contract tests can be run from `apps/ai` with `uv run --extra cloud python -m unittest discover -s . -p 'test_*.py'`. Do not run real-provider AI tests without checking billing and explicitly enabling their documented gates.

## Pull-request expectations

- State which path changes: human WebRTC, Worker/signaling, TURN operations, or the separate AI prototype.
- Add or update tests for state transitions, permissions, reconnects, and media behavior affected by the change. Distinguish local fake-device results from real-device and public-network evidence.
- Keep invitation secrets, TURN credentials, provider keys, raw audio, transcripts, private IPs, and user screenshots out of issues, commits, test fixtures, and logs. Use synthetic media and redacted diagnostics.
- Do not add an implicit cloud fallback or make the private AI service public. Changes to public AI access require a separate design for identity, consent, cost limits, and abuse controls.
- Identify any third-party code, model, voice, font, or asset and its license. Do not paste code from an unlicensed example.

By contributing, you agree that your contribution is submitted under the repository's [Apache-2.0 license](LICENSE). This is a source project, not a claim of production reliability; please keep README and evidence statements calibrated to what was actually tested.
