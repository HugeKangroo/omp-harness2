import { spawn } from "node:child_process";
import { assertNoHomeDotEnv, credentialInfo, probeRpcCapabilities } from "./runner";

export interface DoctorCheck { name: string; status: "pass" | "fail" | "warn"; detail: string }
export interface DoctorReport { ok: boolean; checks: DoctorCheck[]; version?: string }
export interface DoctorOptions { ompCommand?: string; model?: string }

async function versionOf(command: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C" } });
    let output = "";
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(output.trim());
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(new Error("OMP --version timed out.")); }, 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4096) { child.kill("SIGKILL"); done(new Error("Unexpectedly large OMP version output.")); }
    });
    child.stderr.resume();
    child.on("error", error => done(error));
    child.on("close", code => done(code === 0 ? undefined : new Error(`OMP --version exited ${code}.`)));
  });
}

/** Runs only local protocol/configuration checks: it never sends a model prompt. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let version: string | undefined;
  const add = (name: string, status: DoctorCheck["status"], detail: string) => checks.push({ name, status, detail });
  try {
    version = await versionOf(options.ompCommand || "omp");
    if (!/\b18\.13\.[12]\b/.test(version)) add("omp-version", "fail", `${version}: this alpha supports tested OMP 18.13.1–18.13.2 only.`);
    else add("omp-version", "pass", version);
  } catch (error) { add("omp-version", "fail", error instanceof Error ? error.message : String(error)); }
  if (process.platform === "win32") add("process-groups", "fail", "POSIX process groups are required for reliable worker cancellation.");
  else add("process-groups", "warn", "Workers use a separate POSIX process group with bounded TERM/KILL cleanup. Verify descendant-signal permissions in deployment; owner metadata remains if cleanup cannot be confirmed.");
  try { await assertNoHomeDotEnv(); add("ambient-env", "pass", "No home .env; worker config/auth/cache roots are temporary and inherited environment is allowlisted."); }
  catch (error) { add("ambient-env", "fail", error instanceof Error ? error.message : String(error)); }
  if (options.model) {
    try {
      const auth = credentialInfo(options.model);
      add("auth", auth.present ? "pass" : "fail", auth.present ? `An explicit ${auth.variable}/HARNESS2_API_KEY is available; its value was not inspected or displayed.` : `Set ${auth.variable} or HARNESS2_API_KEY. OMP OAuth/login databases are not inherited.`);
    } catch (error) { add("auth", "fail", error instanceof Error ? error.message : String(error)); }
  } else add("auth", "warn", "No model supplied. Configure an exact provider/model-id and its API-key environment variable; OAuth subscriptions and custom gateways are not supported yet.");
  if (!checks.some(check => check.status === "fail" && check.name !== "auth")) {
    try {
      // Always a bundled, direct transport; a dummy key is used and no prompt is issued.
      const probe = await probeRpcCapabilities(options.ompCommand || "omp");
      add("rpc-tool-boundary", "pass", `Protocol v${probe.protocol}; initial tools empty; host-only tools verified: ${probe.hostTools.join(", ")}. No model request was sent.`);
    } catch (error) { add("rpc-tool-boundary", "fail", error instanceof Error ? error.message : String(error)); }
  }
  add("execution-scope", "warn", "Alpha workers can inspect and edit private snapshot files only. They cannot run tests, shell commands, native tools or generated code. This is an application tool boundary, not an OS sandbox against a hostile local process.");
  add("budget", "warn", "USD limits gate subsequent requests; an in-flight request can overshoot. Missing pricing/accounting fails closed and unknown in-flight spend reserves the entire stage allocation.");
  return { ok: !checks.some(check => check.status === "fail"), checks, ...(version ? { version } : {}) };
}
