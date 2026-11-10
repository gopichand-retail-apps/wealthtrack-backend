export function writeLog(entry) {
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
  );
}
