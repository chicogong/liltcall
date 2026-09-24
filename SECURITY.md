# Security policy

LiltCall is a pre-release reference project. No stable version or response-time commitment is offered yet. The deployed human-call test site and the local-only AI prototype have different trust boundaries; the AI service must not be exposed directly on the public internet.

Do not post a live invitation URL, invite fragment, TURN credential, provider key, transcript, raw audio, candidate IP, or a detailed exploitable report in a public issue. Please redact these from screenshots and logs too.

Report vulnerabilities through the [repository's private vulnerability reporting page](https://github.com/chicogong/liltcall/security/advisories/new) rather than a public issue. The maintainer should keep that GitHub feature enabled and verify its availability after repository changes. For non-sensitive bugs, use the public bug-report template.

Security-sensitive areas include room membership and one-use signaling tickets, invite-secret handling, TURN credential issuance, WebRTC ICE configuration, cross-origin restrictions, and the private AI billing/loopback gates. Please avoid probing the public test deployment without the maintainer's coordination.
