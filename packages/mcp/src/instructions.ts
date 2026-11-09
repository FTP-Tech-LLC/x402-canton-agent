/**
 * The lines both servers put first in their instructions (the hosted server
 * only with MCP_REMOTE_NEW_TOOLS on). Some clients show only the start of the
 * instructions, so these stay inside the first 512 characters; a test in
 * each server checks it.
 */
export const INSTRUCTIONS_LEAD =
  "Start with get_guide (how this wallet works) and find_paid_apis (what it can pay for). " +
  "Never call pay again for the same purchase: a purchase is never retried, and if a call fails, check get_balance before anything else. " +
  "A pay call pays at most once; set max_cc to cap what it may spend. " +
  "Setup for any assistant: https://www.ftptech.xyz/skill.md. ";
