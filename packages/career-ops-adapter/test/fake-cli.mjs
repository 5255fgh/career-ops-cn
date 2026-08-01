import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const fileFlagIndex = args.indexOf("--file");
const inputPath = fileFlagIndex === -1 ? undefined : args[fileFlagIndex + 1];

if (
  inputPath === undefined ||
  fileFlagIndex !== 0 ||
  args.length !== 3 ||
  args[2] !== "--no-save"
) {
  process.stderr.write("invalid fake CLI invocation\n");
  process.exitCode = 64;
} else {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  await writeFile(
    join(process.cwd(), "last-invocation.json"),
    JSON.stringify({
      execPath: process.execPath,
      scriptPath: process.argv[1],
      args,
      cwd: process.cwd(),
      inputPath,
      input,
    }),
    "utf8",
  );

  const fixturePath = (filename) => join(process.cwd(), "fixtures", filename);
  const writeFixture = async (filename, stream = process.stdout) => {
    stream.write(await readFile(fixturePath(filename), "utf8"));
  };

  switch (input.jobId) {
    case "normal-zh":
      await writeFixture("normal-zh.txt");
      break;
    case "normal-en":
      await writeFixture("normal-en.txt");
      break;
    case "ansi": {
      const fixture = JSON.parse(await readFile(fixturePath("ansi.json"), "utf8"));
      process.stdout.write(fixture.stdout);
      break;
    }
    case "summary-missing":
      await writeFixture("summary-missing.txt");
      break;
    case "score-corrupt":
      await writeFixture("score-corrupt.txt");
      break;
    case "score-out-of-range":
      await writeFixture("score-out-of-range.txt");
      break;
    case "api-auth-error":
      await writeFixture("api-auth-error.stderr.txt", process.stderr);
      process.exitCode = 1;
      break;
    case "non-zero-exit":
      await writeFixture("non-zero-exit.stderr.txt", process.stderr);
      process.exitCode = 2;
      break;
    case "gateway-retry-success": {
      const attemptPath = join(process.cwd(), "gateway-attempt.txt");
      let attempt = 0;
      try {
        attempt = Number.parseInt(await readFile(attemptPath, "utf8"), 10);
      } catch {}
      attempt += 1;
      await writeFile(attemptPath, String(attempt), "utf8");
      if (attempt < 3) {
        await writeFixture("gateway-error.stderr.txt", process.stderr);
        process.exitCode = 1;
      } else {
        await writeFixture("normal-zh.txt");
      }
      break;
    }
    case "gateway-always-fail":
      await writeFixture("gateway-error.stderr.txt", process.stderr);
      process.exitCode = 1;
      break;
    case "stdout-over-limit":
      await writeFixture("stdout-over-limit.txt");
      break;
    case "timeout":
    case "cancel":
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
      break;
    default:
      process.stderr.write(`unknown fake CLI mode: ${input.jobId}\n`);
      process.exitCode = 65;
  }
}
