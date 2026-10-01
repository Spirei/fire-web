export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installRequestInstrumentation } = await import("./lib/apiRequestInstrumentation");
    installRequestInstrumentation();
    const { startFeedScheduler } = await import("./lib/feedGeneration");
    startFeedScheduler();
  }
}
