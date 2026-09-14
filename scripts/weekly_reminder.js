// 定投日提醒：算出这次该投多少、买 QQQ 还是 TQQQ，生成一条 GitHub Issue 的标题和正文。
// 被 .github/workflows/weekly-reminder.yml 调用；也能单独跑：node scripts/weekly_reminder.js
const fs = require("fs");
const path = require("path");
const DCA = require("../docs/strategy.js");

const DATA = path.join(__dirname, "..", "docs", "data.json");

// 美东时间的今天（工作流里 GitHub 的时钟是 UTC）
function todayInNewYork(now) {
  const d = now || new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function fmtMoney(v) {
  return "$" + (v < 1000 ? v.toFixed(2) : Math.round(v).toLocaleString("en-US"));
}
function fmtPct(v, d) {
  return (v < 0 ? "−" : "") + Math.abs(v).toFixed(d == null ? 1 : d) + "%";
}

// data: 原始 data.json；opts: { today, owner, repo, config }
function buildReminder(data, opts) {
  opts = opts || {};
  const cfg = DCA.withDefaults(opts.config || {});
  const series = DCA.prepare(data);
  if (!series.n) return { skip: true, reason: "没有行情数据" };

  const today = opts.today || todayInNewYork();
  const wd = DCA.weekdayOf(DCA.dayNumber(today));
  if (wd < 1 || wd > 5) return { skip: true, reason: "周末不投" };
  if (!opts.force && cfg.frequency !== "daily" && wd !== cfg.investWeekday) {
    return { skip: true, reason: "今天不是定投日" };
  }

  const dd = DCA.drawdowns(series, cfg.basis).dd;
  const tl = DCA.trendLines(series, cfg.maWindow);
  const i = series.n - 1; // 用最后一个交易日的收盘价
  if (series.dates[i] >= today) {
    // 数据已经包含今天（收盘后才更新），那就用前一天
  }
  const r = DCA.decide(cfg, dd, tl.dev, tl.ok, i);
  const amount = cfg.baseAmount * r.multiplier;
  const asset = r.buyTqqq ? "TQQQ" : "QQQ";
  const toT = r.buyTqqq ? amount * cfg.flowShare / 100 : 0;

  const dateCn = today.slice(5, 7).replace(/^0/, "") + "月" + today.slice(8, 10).replace(/^0/, "") + "日";
  const title = `${dateCn}（${DCA.WEEKDAY_CN[wd]}）：投 ${fmtMoney(amount)} 买 ${asset}（×${r.multiplier}）`;

  const lines = [];
  lines.push(`## 这次投 ${fmtMoney(amount)}，买 **${asset}**`);
  lines.push("");
  lines.push(`- 基础金额 ${fmtMoney(cfg.baseAmount)} × **${r.multiplier}** 倍`);
  if (r.buyTqqq && cfg.flowShare < 100) {
    lines.push(`- 其中 ${fmtMoney(toT)} 买 TQQQ，剩下 ${fmtMoney(amount - toT)} 买 QQQ`);
  }
  lines.push(`- 依据 ${series.dates[i]} 收盘：QQQ ${fmtMoney(series.close[i])}，TQQQ ${fmtMoney(series.t[i])}`);
  lines.push(`- 离${cfg.basis === "ath" ? "历史" : "近一年"}最高点跌了 **${fmtPct(dd[i])}**`);
  if (tl.ok[i]) {
    lines.push(`- ${cfg.maWindow} 日均线 ${fmtMoney(tl.ma[i])}，现价比它` +
      (tl.dev[i] < 0 ? `低 ${fmtPct(-tl.dev[i])}（下跌趋势）` : `高 ${fmtPct(tl.dev[i])}`));
  }
  lines.push("");
  if (r.buyTqqq) {
    lines.push(`> 回撤已经到了 ${cfg.dipThreshold}% 的门槛，按规则这次买 TQQQ。`);
    lines.push("> 买完记得看一眼 TQQQ 占组合的比例，超过 " + cfg.tqqqCap + "% 就把超出的部分换回 QQQ。");
  } else if (tl.ok[i] && tl.dev[i] < 0) {
    lines.push(`> 虽然跌破了 200 日均线，但还没跌到 ${cfg.dipThreshold}%，这次仍然买 QQQ。`);
  } else {
    lines.push("> 不是大跌，这次买 QQQ。");
  }
  if (cfg.sellOnRecover && tl.ok[i] && tl.dev[i] >= 0) {
    lines.push("> 你开了「涨回均线就换回 QQQ」：现在在均线上方，手里的 TQQQ 该换成 QQQ。");
  }
  if (series.hasSpy) {
    const st = DCA.steadyDefaults({});
    const base = cfg.baseAmount;
    const parts = [
      `SPY ${fmtMoney(base * st.coreWeight / 100)}`,
      `QQQ ${fmtMoney(base * st.qqqWeight / 100)}`,
      `TQQQ ${fmtMoney(base * st.tqqqWeight / 100)}`,
    ];
    lines.push("");
    lines.push(`如果你走的是**稳妥模式**（${Math.round(st.coreWeight)}/${Math.round(st.qqqWeight)}/${Math.round(st.tqqqWeight)}）：` +
      `这次就投 ${fmtMoney(base)}，不加码，分成 ${parts.join(" · ")}。` +
      `实际下单前在网站上按你自己的持仓算一下，缺得多的那层会多分一点。`);
  }
  lines.push("");
  lines.push(`美股开盘：北京时间 21:30（夏令时）/ 22:30（冬令时）。`);
  if (opts.owner && opts.repo) {
    lines.push("");
    lines.push(`网站：https://${opts.owner}.github.io/${opts.repo}/`);
  }
  lines.push("");
  lines.push(`<sub>提醒按仓库里的默认基础金额 ${fmtMoney(cfg.baseAmount)} 算。你自己的金额只存在浏览器里，按上面的倍数乘一下就行。这不是投资建议。</sub>`);

  return {
    skip: false,
    title,
    body: lines.join("\n"),
    amount, multiplier: r.multiplier, asset, state: r.state,
    basedOn: series.dates[i],
  };
}

if (require.main === module) {
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const out = buildReminder(data, {
    owner: process.env.GITHUB_REPOSITORY_OWNER,
    repo: (process.env.GITHUB_REPOSITORY || "/").split("/")[1],
    force: process.argv.includes("--force"),
  });
  if (out.skip) {
    console.log("skip: " + out.reason);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "skip=true\n");
  } else {
    console.log(out.title);
    console.log("");
    console.log(out.body);
    var bodyPath = path.join(process.env.RUNNER_TEMP || require("os").tmpdir(), "issue-body.md");
    fs.writeFileSync(bodyPath, out.body);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT,
        "skip=false\ntitle=" + out.title.replace(/\r?\n/g, " ") + "\nbody_path=" + bodyPath + "\n");
    }
  }
}

module.exports = { buildReminder, todayInNewYork };
