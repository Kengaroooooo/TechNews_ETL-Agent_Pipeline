// 查看最近 workflow 运行情况（只读 GitHub 公共 API；raw.githubusercontent 在本机网络不可达，统一走 api.github.com）
import { Buffer } from "node:buffer";

const REPO = "Kengaroooooo/TechNews_ETL-Agent_Pipeline";
const BASE = `https://api.github.com/repos/${REPO}`;

const [cmd, ...args] = process.argv.slice(2);

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "check-script", Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

if (cmd === "runs") {
  const d = await getJSON(`${BASE}/actions/runs?per_page=20`);
  console.log("total runs:", d.total_count);
  for (const r of d.workflow_runs) {
    console.log([r.id, r.name, r.event, r.status, r.conclusion, r.created_at, r.head_sha.slice(0, 7), (r.display_title || "").slice(0, 60)].join(" | "));
  }
} else if (cmd === "jobs") {
  const runId = args[0];
  const d = await getJSON(`${BASE}/actions/runs/${runId}/jobs`);
  for (const j of d.jobs) {
    console.log(`== ${j.name} [${j.status}/${j.conclusion}] ${(j.started_at || "")} -> ${(j.completed_at || "")}`);
    for (const s of j.steps) {
      console.log(`  ${s.number}. ${s.name} [${s.status}/${s.conclusion}]`);
    }
  }
} else if (cmd === "cat") {
  // node tools/check-gh-runs.mjs cat <path> [ref]
  const [path, ref = "main"] = args;
  const d = await getJSON(`${BASE}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (Array.isArray(d)) {
    for (const f of d) console.log(f.type, f.path);
  } else {
    console.log(Buffer.from(d.content, "base64").toString("utf8"));
  }
} else {
  console.log("usage: node tools/check-gh-runs.mjs runs | jobs <runId> | cat <path> [ref]");
}
