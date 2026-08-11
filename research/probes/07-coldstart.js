// Measures the scripting-bridge warm-up penalty: the same trivial round trip,
// repeated, so the first-call cost is visible against the steady state.
function run() {
  const Mail = Application("Mail");
  const timings = [];
  for (let i = 0; i < 5; i++) {
    const t0 = $.NSDate.date;
    Mail.accounts.name();
    timings.push($.NSDate.date.timeIntervalSinceDate(t0));
  }
  return JSON.stringify({ inProcessRoundTrips: timings });
}
