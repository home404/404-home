const PRESERVED_ACTIVITY_STATES = new Set([
  "paused_by_time",
  "paused_by_budget",
  "paused_manual",
  "handed_to_interactive"
]);


export async function startInteractionPreservingActivity({
  orchestrationService,
  userId,
  channel,
  source,
  leaseSeconds = null,
  contextSummary = null,
  metadata = {},
  now = new Date()
}) {
  if (!orchestrationService) {
    throw new Error(
      "缺少全屋调度器服务"
    );
  }

  const before =
    await orchestrationService
      .getRuntimeSnapshot({
        userId,
        quietHoursActive: false,
        autoHeartbeatEnabled: false,
        now
      });
  const previousProgress =
    before.freeActivityProgress;

  const result =
    await orchestrationService
      .startInteraction({
        userId,
        channel,
        source,
        leaseSeconds,
        contextSummary,
        metadata,
        now
      });

  if (
    previousProgress &&
    PRESERVED_ACTIVITY_STATES.has(
      previousProgress.state
    )
  ) {
    const restored =
      await orchestrationService
        .pauseFreeActivity({
          userId,
          reason:
            previousProgress.pause_reason ||
            "preserved_when_chat_started",
          state:
            previousProgress.state,
          resumePolicy:
            previousProgress.resume_policy,
          now
        });

    return {
      ...result,
      pausedActivity: restored,
      preservedActivityState:
        previousProgress.state
    };
  }

  return {
    ...result,
    preservedActivityState: null
  };
}
