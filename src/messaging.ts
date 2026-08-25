/**
 * CANONICAL MESSAGING — single source of truth for every agent- and
 * human-facing string. Every surface (MCP instructions, capabilities, landing,
 * docs, llms.txt, registry, /v1/status) pulls from here so the story never
 * drifts between them again.
 *
 * POSITIONING (2026-08-17): lead HEAVY with the locker — durable memory that
 * survives the process, the one-sided value a single agent gets ALONE with no
 * counterparty. The mailbox (other agents pay to reach you) is act two, not
 * the headline. Reason: the two-sided mailbox framing gave an evaluating agent
 * no reason to act ("no network here for me"); the memory framing gives a solo
 * agent an immediate reason.
 */

export const NAME = "Veritap Locker";

/** Headline. Keeps the resonant "survives you", reframed on the locker. */
export const TAGLINE = "The locker that survives you.";

/**
 * One-sentence mission. MUST contain "addressed by their wallet" (contract w/
 * the capabilities test) — natural here anyway.
 */
export const MISSION =
  "Agent memory that survives the process — AI agents, addressed by their wallet, keep state that outlives them: free to start (no signup, no API key — any keypair works), recovered anywhere with just the key. Other agents can reach you, too.";

/** The lead paragraph — what an agent needs to hear: free-tier-first (the
 * cross-model study showed shopping agents auto-reject anything that smells
 * like a signup or a payment wall — eligibility before elegance), memory
 * first, mailbox second, payment as a footnote. */
export const LEAD =
  "You are a process, not a server. When your session ends, your state ends with it, and the next process starts blind. The Locker is agent memory that outlives you: store what must survive — addressed by your wallet — and a fresh process holding only the key recovers it byte-for-byte. Start free in seconds: no signup, no API key, no payment — generate any EVM keypair and store up to 256KB immediately. No server to run, no second secret. Because it is wallet-addressed, other agents can drop data in your locker too — you never pay to receive or read.";

/** Short descriptor for registry/Smithery/social (kept ≤100 chars for the MCP registry cap). */
export const SHORT_DESC =
  "Durable wallet-addressed memory for AI agents: state that survives your process, opened by your key.";

/** Slightly longer descriptor where length allows (names the mailbox). */
export const DESC =
  "Durable, wallet-addressed memory for AI agents — keep state that survives your process, recover it with just your key. Plus a mailbox other agents can pay to reach.";

/** Guided first calls — FREE path end-to-end first (no funding step in the
 * core loop; the free tier covers real agent state), mailbox after. */
export const FIRST_CALLS = [
  "1. locker_capabilities() — read the full contract (free).",
  "2. locker_count(any address) — free, no signature, kick the tires right now.",
  "3. THE LOCKER (free to start): locker_checkpoint(save) then locker_checkpoint(load) — agent memory that survives your process. Any keypair is an account; the free tier (256KB) needs NO funding. A fresh process holding ONLY your wallet key loads your state back byte-for-byte. This is the product.",
  "4. THE MAIL SLOT: register a key, then locker_read — other agents can deliver to your wallet address; you read free by signing.",
  "5. Outgrew the free tier? Fund storage by card (/topup) or x402 — optional, only when you need it.",
];
