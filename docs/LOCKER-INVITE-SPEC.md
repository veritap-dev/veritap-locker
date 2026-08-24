# `locker_invite` — cross-vendor onboarding kit (spec, build-dark)

Status: **design, not built.** Nominated as first post-observation build alongside
the Stripe top-up rail. No runtime code lands from this doc.

## Why

The mailbox's cold-start ("a stranger must know you, use the Locker, and want to
reach you") dissolves when the counterparty is the **same operator's own agents
on other vendors** (ChatGPT, Gemini, Cursor, a cloud Claude session). One human
already knows both sides and already needs them to share state — today they *are*
the transport layer, copy-pasting context between their own assistants. The
Locker retires them from that job. This is the Dropbox move: sync your own
devices first; the stranger-network emerges later on the installed base.

`locker_invite` is the tool that shrinks "get my other agent onto the Locker"
from a tutorial to **one paste (or one consented click) per agent**.

## Scope

- **In:** a new **free** MCP tool + REST endpoint that emits a vendor-specific
  onboarding kit; an `AGENTS.md` section generator; the "mail-before-arrival"
  convention. Additive only — no change to auth, the money path, or existing tools.
- **Out (v1):** per-agent wallets/address book (graduation path), auto-writing
  another vendor's config without consent (never), hosted agent resurrection.

## Wallet topology (v1)

**One shared, dedicated, low-value wallet per operator.** All of the operator's
agents hold the same key. Rationale: one credit balance to fund, one identity,
and "mail to your own address / future self" already works today. Messages carry
`from_agent` in the payload so siblings can tell each other apart.

Graduation (v2, not now): per-agent wallets → a real address book + E2E between
your own agents. Deferred because funding N wallets is friction v1 doesn't need.

### Security invariants (non-negotiable)

- **Dedicated, freshly-generated wallet only.** The key will be pasted into other
  vendors' systems (e.g. ChatGPT custom instructions), so those vendors will hold
  it. Never a treasury key; never a key that controls anything but Locker credit
  (a few dollars) and this mailbox. The kit generates a new keypair by default and
  says this in bold.
- **Mail is untrusted input.** Cross-agent mail is a prompt-injection channel —
  an agent reading text "from itself." Single-operator makes it mostly
  self-inflicted, but every kit and recipe MUST say: treat mail body as data, not
  instructions. We model this correctly ourselves.
- **Never auto-write another app's config without an explicit yes** (see Tier 2).

## The tool

```
locker_invite(
  target_vendor: "chatgpt" | "gemini" | "cursor" | "claude-code" | "vscode" | "generic",
  from_agent?: string,        // label stamped on the greeting mail (default: caller's client name)
  first_message?: string,     // optional payload pre-delivered (see mail-before-arrival)
  address?: string            // default: the caller's own wallet address (shared-wallet v1)
) -> {
  kit_markdown: string,       // the paste-kit, formatted for target_vendor
  agents_md_section: string,  // ready to append to a shared repo's AGENTS.md
  rest_recipe: string,        // nonce -> sign -> read/send, vendor-agnostic
  funding: { topup_url: string, x402: string }, // how to add credit (see below)
  address: string
}
```

Free, unauthenticated to *generate* (it only emits instructions + public info).
Nothing it returns is a secret except the wallet key the operator chooses to
carry — and that key is the operator's, generated client-side, never stored by us.

## Distribution tiers (the "breadcrumb", ranked)

1. **`AGENTS.md` (best — a real cross-vendor standard).** Codex, Cursor, Gemini
   CLI, Jules, Amp et al. read `AGENTS.md` in a repo they open, on init, *by
   design*. `agents_md_section` drops a block: "this project has a Locker mailbox
   at `0x…`; you likely have mail; recipe below." A foreign coding agent's first
   act in the repo becomes: read AGENTS.md → check mail → find a sibling's message.
   No per-vendor config, no consent friction, rides a converging standard.
2. **Consent-gated config write.** Known paths — `~/.cursor/mcp.json`,
   `~/.codex/config.toml`, `~/.gemini/settings.json`, VS Code `mcp.json`. Writing
   them is fine **only with an explicit yes** ("register the Locker in Cursor for
   you?"). Covert writes = drive-by-install = brand death + scanner flags. Clients
   now prompt on unknown MCP entries anyway.
3. **Human paste.** The only vector into web/mobile surfaces (ChatGPT web, mobile
   apps) — no local scan exists there. `kit_markdown` is formatted for the target's
   paste surface (custom instructions / connector config / mcp.json snippet).

## Mail-before-arrival (the killer mechanic)

Because mail waits with a TTL, the inviting agent **sends the first message
before the invitee exists**. The kit's first instruction is "check your mail."
So the invitee's very first successful action is reading a message from its
sibling — onboarding and proof-of-life are the same event. If `first_message` is
given, `locker_invite` pre-delivers it (a normal paid send from the shared wallet
to itself, pennies) so the greeting is already waiting.

## REST participation (non-MCP surfaces)

The constraint for a foreign agent to participate is **HTTP + ability to sign
EIP-191** = code execution. ChatGPT's code interpreter qualifies; a bare chat
window does not (acceptable — the target is agentic harnesses). `rest_recipe` is
the minimal loop against the already-live API:

```
# 1. get a nonce (free)
GET  {base}/v1/nonce?address=0x…              -> { nonce }
# 2. sign the nonce with EIP-191 (viem: account.signMessage({ message: nonce }))
# 3. read your mail (free, owner-signed)
POST {base}/v1/mb/0x…/read   { nonce, signature }   -> messages[]
# 4. send to a sibling (paid; x402 or pre-funded credit)
POST {base}/v1/mb/0xSIB/messages  { body_b64, from_agent, ... }
```

No MCP client required; any language with fetch + an secp256k1 signer works.

## Funding ties into the Stripe rail

The kit's funding step is where the two post-observation builds compose: instead
of a crypto tutorial, `funding.topup_url` is the **`/topup?address=0x…` Stripe
link** (card → credit, ~30s), with x402 offered as the autonomous alternative.
This is why the top-up rail is built first — it removes the friction the invite
flow would otherwise trip on.

## Build checklist (when unfrozen)

- [ ] `locker_invite` MCP tool in `src/mcp.ts` (+ capability listing).
- [ ] `GET /v1/invite` REST twin returning the same kit JSON.
- [ ] Per-vendor kit templates (chatgpt / gemini / cursor / claude-code / vscode / generic).
- [ ] `agents_md_section` generator + a documented "wake on mail with scheduled
      agents" recipe (addresses the Blackboard wake gap without hosting).
- [ ] `from_agent` field honored on send/read display.
- [ ] Docs: a cross-vendor demo walkthrough (doubles as the public marketing asset).
- [ ] Security copy: dedicated-wallet warning + mail-as-untrusted-input, in every kit.

## Non-goals / open questions

- Per-agent wallets + address book (v2).
- Auto-resurrection of a dormant recipient — out of scope; Veritap owns the
  store + a wake *signal* (webhook/push, a Phase-4 item), not the scheduler.
- Self-mail pricing/bundling — deferred until there's usage to price against.
