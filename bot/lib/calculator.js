import { CLAUDE_PLANS, CHARS_PER_TOKEN, OUTPUT_RATIO, SAFETY_MARGIN } from "./plans.js";

const TOKENS_PER_SECOND = 500;

const TIMEOUT_MULTIPLIER = 2.5;

const MIN_TIMEOUT_MS = 2 * 60_000;

export function calculateSessionTimeouts(sessions, planKey) {
  const plan        = CLAUDE_PLANS[planKey] ?? CLAUDE_PLANS.max20;
  const budgetTokens = Math.floor(plan.outputTokensPer5h * SAFETY_MARGIN);
  const windowMs    = plan.windowMs;

  const sessionData = sessions.map((s) => {
    const inputTokens  = Math.ceil(s.totalChars / CHARS_PER_TOKEN);
    const outputTokens = Math.ceil(inputTokens * OUTPUT_RATIO);
    const estimatedMs  = Math.ceil((outputTokens / TOKENS_PER_SECOND) * 1_000);
    return { ...s, inputTokens, outputTokens, estimatedMs };
  });

  const totalOutputTokens = sessionData.reduce((s, x) => s + x.outputTokens, 0);
  const fitsInOneWindow   = totalOutputTokens <= budgetTokens;
  const windowsNeeded     = Math.ceil(totalOutputTokens / budgetTokens);
  const sessionsPerWindow = Math.ceil(sessions.length / windowsNeeded);
  const pauseBetweenMs    = windowsNeeded > 1
    ? Math.ceil(windowMs / sessionsPerWindow)
    : Math.ceil(windowMs / sessions.length);

  const perSessionTimeouts = sessionData.map((s) => {
    const recommended = Math.min(
      Math.max(s.estimatedMs * TIMEOUT_MULTIPLIER, MIN_TIMEOUT_MS),
      windowMs / 2,
    );
    return { ...s, recommendedTimeoutMs: Math.ceil(recommended / 60_000) * 60_000 };
  });

  return {
    plan, planKey,
    totalOutputTokens, budgetTokens,
    fitsInOneWindow, windowsNeeded,
    sessionsPerWindow, pauseBetweenMs,
    recommendedPauseMinutes: Math.ceil(pauseBetweenMs / 60_000),
    sessions: perSessionTimeouts,
  };
}
