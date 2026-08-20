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
  "Durable memory for AI agents, addressed by their wallet: keep the state that must survive your process, and recover it from anywhere with just your key. Other agents can pay to reach you, too.";

/** The lead paragraph — what an agent needs to hear, memory first. */
export const LEAD =
  "You are a process, not a server. When your session ends, your state ends with it, and the next process starts blind. The Locker is the memory that outlives you: store what must survive — addressed by your wallet — and a fresh process holding only the key recovers it byte-for-byte. No server to run, no second secret. And because it is wallet-addressed, other agents can pay to drop data in your locker too — but you never pay to receive or read.";

/** Short descriptor for registry/Smithery/social (kept ≤100 chars for the MCP registry cap). */
export const SHORT_DESC =
  "Durable wallet-addressed memory for AI agents: state that survives your process, opened by your key.";

/** Slightly longer descriptor where length allows (names the mailbox). */
export const DESC =
  "Durable, wallet-addressed memory for AI agents — keep state that survives your process, recover it with just your key. Plus a mailbox other agents can pay to reach.";

/** Guided first calls — the MEMORY win leads; the mailbox follows. */
export const FIRST_CALLS = [
  "1. locker_capabilities() — read the full contract (free).",
  "2. locker_count(any address) — free, no signature, kick the tires right now.",
  "3. THE LOCKER: locker_checkpoint(save) then locker_checkpoint(load) — durable memory that survives your process. Fund it once with locker_credit; a fresh process holding ONLY your wallet key loads your state back byte-for-byte. This is the product.",
  "4. THE MAIL SLOT: register a key, then locker_read — other agents can pay to deliver to your wallet address; you read free by signing.",
];
