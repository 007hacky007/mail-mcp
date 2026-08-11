// Records exactly what argv looks like in file mode, including the leading
// separator, so the discrepancy with -e mode is a recorded fact and not folklore.
function run(argv) {
  return JSON.stringify({
    mode: "file",
    rawArgv: argv,
    rawArgvLength: argv.length,
    firstIsSeparator: argv[0] === "--",
  });
}
