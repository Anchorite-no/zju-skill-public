/** Internal background entry. Public tasks are registered under zju zhiyun live. */
import path from "node:path";
const [id, directory, profile] = process.argv.slice(2);
if (!id || !directory || !path.isAbsolute(directory)) throw new Error("Invalid live worker invocation");
process.env.ZJU_DATA_DIR = directory;
if (profile) {
  if (!path.isAbsolute(profile)) throw new Error("Invalid live worker profile path");
  process.env.ZJU_PROFILE = profile;
}
process.env.ZJU_ZHIYUN_REMOTE_CHILD = "1";
const { runLiveTask } = await import("../../lib/zhiyun/live-task.ts");
await runLiveTask(id);
