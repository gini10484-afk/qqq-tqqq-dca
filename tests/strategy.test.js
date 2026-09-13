// 运行：node --test tests/strategy.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DCA = require("../docs/strategy.js");

// 从 start 开始的交易日（跳过周末）
function tradingDays(start, count) {
  const out = [];
  let d = DCA.dayNumber(start);
  while (out.length < count) {
    const wd = DCA.weekdayOf(d);
    if (wd >= 1 && wd <= 5) out.push(DCA.dateFromDayNumber(d));
    d++;
  }
  return out;
}
// qs: QQQ 价格；ts: TQQQ 价格（不给就按 3 倍日涨跌推）
function series(dates, qs, ts) {
  const rows = dates.map((d, i) => {
    let t;
    if (ts) t = ts[i];
    else if (i === 0) t = 100;
    else t = null;
    return [d, qs[i], qs[i], t, 1];
  });
  if (!ts) {
    for (let i = 1; i < rows.length; i++) {
      rows[i][3] = rows[i - 1][3] * (1 + 3 * (qs[i] / qs[i - 1] - 1));
    }
  }
  return DCA.prepare({ rows });
}
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
// 平滑的价格路径：先横盘、再慢慢跌四成五、再慢慢涨回去并创新高。
// 一定要平滑，因为 TQQQ 是 3 倍日涨跌，单日跌超过 33% 价格就会变成负数。
function ramp(i) {
  if (i < 40) return 100;
  if (i < 120) return 100 * Math.pow(0.45, (i - 40) / 80);
  return 45 * Math.pow(100 / 45 * 1.3, (i - 120) / 100);
}

// 测试不依赖 DEFAULT_CONFIG（默认值以后可能会改），要什么规则就写明
const BASE = { baseAmount: 100, investWeekday: 1, basis: "ath", maWindow: 20, dipThreshold: 20, tqqqCap: 20, flowShare: 100 };

test("星期计算", () => {
  assert.equal(DCA.weekdayOf(DCA.dayNumber("2026-09-11")), 5);
  assert.equal(DCA.weekdayOf(DCA.dayNumber("2026-09-14")), 1);
  assert.equal(DCA.weekdayOf(DCA.dayNumber("1970-01-01")), 4);
});

test("回撤：历史最高点 / 近一年最高点", () => {
  const d = tradingDays("2026-01-05", 5);
  const s = series(d, [100, 110, 99, 120, 90]);
  const ath = DCA.drawdowns(s, "ath").dd;
  [0, 0, 10, 0, 25].forEach((v, i) => close(ath[i], v));
  // 近一年会忘掉一年前的高点
  const long = tradingDays("2020-01-06", 400);
  const px = long.map((_, i) => (i === 0 ? 200 : 100));
  const s2 = series(long, px);
  const w52 = DCA.drawdowns(s2, "52w").dd;
  close(w52[1], 50);
  close(w52[399], 0);
});

test("均线和偏离", () => {
  const d = tradingDays("2026-01-05", 30);
  const s = series(d, d.map(() => 100));
  const tl = DCA.trendLines(s, 20);
  assert.equal(tl.ok[18], 0);
  assert.equal(tl.ok[19], 1);
  close(tl.ma[19], 100);
  close(tl.dev[19], 0);
});

test("decide：跌破均线分档加码，涨太多少投", () => {
  const cfg = DCA.withDefaults({ ...BASE, tiers: [{ drawdown: 0, multiplier: 1.5 }, { drawdown: 20, multiplier: 2 }, { drawdown: 30, multiplier: 3 }] });
  const dd = [0, 10, 25, 35, 0], dev = [-1, -1, -1, -1, 20], ok = [1, 1, 1, 1, 1];
  assert.equal(DCA.decide(cfg, dd, dev, ok, 0).multiplier, 1.5);
  assert.equal(DCA.decide(cfg, dd, dev, ok, 1).multiplier, 1.5);
  assert.equal(DCA.decide(cfg, dd, dev, ok, 2).multiplier, 2);
  assert.equal(DCA.decide(cfg, dd, dev, ok, 3).multiplier, 3);
  assert.equal(DCA.decide(cfg, dd, dev, ok, 4).multiplier, cfg.hotMultiplier);
  assert.equal(DCA.decide(cfg, dd, dev, ok, 4).state, "hot");
  // 均线数据还不够时按 1 倍、买 QQQ
  assert.equal(DCA.decide(cfg, dd, dev, [0, 0, 0, 0, 0], 2).multiplier, 1);
  assert.equal(DCA.decide(cfg, dd, dev, [0, 0, 0, 0, 0], 2).buyTqqq, false);
});

test("买 TQQQ 的条件：必须同时跌破均线且回撤够深", () => {
  const cfg = DCA.withDefaults({ ...BASE, dipThreshold: 20 });
  const ok = [1, 1, 1, 1];
  //            跌破均线+回撤19  跌破均线+回撤20  均线上方+回撤50  跌破均线+回撤50
  const dd = [19, 20, 50, 50], dev = [-5, -5, 3, -5];
  assert.equal(DCA.decide(cfg, dd, dev, ok, 0).buyTqqq, false);
  assert.equal(DCA.decide(cfg, dd, dev, ok, 1).buyTqqq, true);
  assert.equal(DCA.decide(cfg, dd, dev, ok, 2).buyTqqq, false, "均线上方再跌也不买 TQQQ");
  assert.equal(DCA.decide(cfg, dd, dev, ok, 3).buyTqqq, true);
});

test("定投日：每周取当周第一个不早于定投日的交易日", () => {
  const d = tradingDays("2026-08-31", 10); // 8-31 周一 … 9-11 周五
  const s = series(d, d.map(() => 100));
  assert.deepEqual(DCA.investDays(s, 1, "weekly"), [0, 5]);
  assert.deepEqual(DCA.investDays(s, 3, "weekly"), [2, 7]);
  assert.equal(DCA.investDays(s, 1, "daily").length, 10);
  assert.equal(DCA.nextInvestDate("2026-09-11", 1, "weekly"), "2026-09-14");
  assert.equal(DCA.nextInvestDate("2026-09-14", 1, "daily"), "2026-09-15");
  assert.equal(DCA.nextInvestDate("2026-09-11", 1, "daily"), "2026-09-14");
});

test("回测：价格不动时，投进去多少就是多少", () => {
  const d = tradingDays("2026-01-05", 60);
  const s = series(d, d.map(() => 100));
  const r = DCA.backtest(s, { ...BASE, maWindow: 20 }, { mode: "plainQ" });
  close(r.value, r.invested, 1e-6);
  close(r.tqqqShare, 0);
  assert.equal(r.rebalances, 0);
  assert.ok(r.times >= 10);
});

test("回测：没跌破均线时，四种做法里只有固定比例会买 TQQQ", () => {
  const d = tradingDays("2026-01-05", 80);
  const s = series(d, d.map((_, i) => 100 + i)); // 一路上涨
  const cfg = { ...BASE, maWindow: 20, hotAbove: 100 };
  assert.equal(DCA.backtest(s, cfg, { mode: "dip" }).tqqqBuys, 0);
  assert.ok(DCA.backtest(s, cfg, { mode: "fixed", fixedShare: 20 }).tqqqBuys > 0);
  assert.equal(DCA.backtest(s, cfg, { mode: "comboQ" }).tqqqShare, 0);
});

test("上限：TQQQ 涨多了会被换回 QQQ", () => {
  // 先跌破均线制造买入，再让 TQQQ 暴涨，看占比有没有被压回上限
  const d = tradingDays("2026-01-05", 220);
  const qs = d.map((_, i) => ramp(i));
  const s = series(d, qs);
  const capped = DCA.backtest(s, { ...BASE, maWindow: 20, tqqqCap: 20 }, { mode: "dip" });
  const free = DCA.backtest(s, { ...BASE, maWindow: 20, tqqqCap: 100 }, { mode: "dip" });
  assert.ok(capped.tqqqBuys > 0, "应该买到过 TQQQ");
  // 只在定投日检查和换仓，所以两次定投之间可以稍微超过上限一点
  assert.ok(capped.tqqqShare < 25, "占比应该被压在上限附近：" + capped.tqqqShare);
  assert.ok(free.tqqqShare > 3 * capped.tqqqShare, "不封顶时占比应该高得多");
  assert.ok(capped.rebalances > 0);
  close(capped.invested, free.invested, 1e-6); // 投进去的钱一样多
});

test("flowShare：只把一部分钱买 TQQQ", () => {
  const d = tradingDays("2026-01-05", 220);
  const qs = d.map((_, i) => ramp(i));
  const s = series(d, qs);
  const full = DCA.backtest(s, { ...BASE, maWindow: 20, flowShare: 100, tqqqCap: 100 }, { mode: "dip" });
  const half = DCA.backtest(s, { ...BASE, maWindow: 20, flowShare: 50, tqqqCap: 100 }, { mode: "dip" });
  assert.ok(half.valueT < full.valueT);
  close(half.invested, full.invested, 1e-6);
});

test("sellOnRecover：涨回均线上方会把 TQQQ 全换成 QQQ", () => {
  const d = tradingDays("2026-01-05", 220);
  const qs = d.map((_, i) => ramp(i));
  const s = series(d, qs);
  const hold = DCA.backtest(s, { ...BASE, maWindow: 20, sellOnRecover: false, tqqqCap: 100 }, { mode: "dip" });
  const sell = DCA.backtest(s, { ...BASE, maWindow: 20, sellOnRecover: true, tqqqCap: 100 }, { mode: "dip" });
  assert.ok(hold.tqqqShare > 0);
  close(sell.tqqqShare, 0, 1e-9);
  assert.ok(sell.rebalances > 0);
});

test("回测：ratio 曲线和最惨时刻", () => {
  const d = tradingDays("2026-01-05", 60);
  const s = series(d, d.map(() => 100));
  const r = DCA.backtest(s, { ...BASE, maWindow: 20 }, { mode: "plainQ" });
  assert.equal(r.ratio.length, r.curve.length);
  close(r.ratio[r.ratio.length - 1], 1, 1e-9);
  close(r.worstRatio, 1, 1e-9);
});

test("信号：用最后一个交易日的收盘价，不偷看未来", () => {
  const d = tradingDays("2026-01-05", 100);
  const qs = d.map((_, i) => ramp(i)); // 第 100 天正处在下跌段
  const s = series(d, qs);
  const sig = DCA.currentSignal(s, { ...BASE, maWindow: 20, dipThreshold: 20 });
  assert.equal(sig.basedOn, d[99]);
  assert.equal(sig.asset, "TQQQ");
  assert.equal(sig.amount, sig.multiplier * 100);
  assert.ok(sig.drawdown >= 20);
});

test("持仓检查：算占比和要换多少", () => {
  const d = tradingDays("2026-01-05", 30);
  const s = series(d, d.map(() => 100), d.map(() => 50));
  const r = DCA.holdingsCheck(s, { ...BASE, tqqqCap: 20 }, { qqqShares: 8, tqqqShares: 4 });
  close(r.qqqValue, 800);
  close(r.tqqqValue, 200);
  close(r.tqqqShare, 20);
  assert.equal(r.needRebalance, false);
  const r2 = DCA.holdingsCheck(s, { ...BASE, tqqqCap: 20 }, { qqqShares: 5, tqqqShares: 10 });
  close(r2.tqqqShare, 50);
  assert.equal(r2.needRebalance, true);
  close(r2.overAmount, 300); // 市值 1000，上限 20% = 200，所以超出 300
  close(r2.overShares, 300 / 50);
});

test("资金计划：保守金额不会把钱投光", () => {
  const flat = Array(1000).fill(1);
  const p = DCA.planBudget(flat, { cash: 5200, share: 100, weeks: 52, rate: 1 }, 1);
  close(p.base_ ?? p.baseSafe, 100); // 5200 分 52 次，倍数恒为 1
  close(p.baseAvg, 100);
  // 倍数有高有低时，保守 < 平均
  const mixed = [];
  for (let i = 0; i < 1000; i++) mixed.push(i % 10 === 0 ? 3 : 1);
  const q = DCA.planBudget(mixed, { cash: 5200, share: 100, weeks: 52, rate: 1 }, 1);
  assert.ok(q.baseSafe < q.baseAvg, `${q.baseSafe} 应该小于 ${q.baseAvg}`);
  // 每日定投把钱分成 5 倍次数
  const daily = DCA.planBudget(flat, { cash: 5200, share: 100, weeks: 52, perWeek: 5, rate: 1 }, 1);
  assert.equal(daily.periods, 260);
  close(daily.baseSafe, 20);
});

test("买 TQQQ 的时段", () => {
  const d = tradingDays("2026-01-05", 220);
  const qs = d.map((_, i) => ramp(i));
  const s = series(d, qs);
  const zones = DCA.tqqqPeriods(s, { ...BASE, maWindow: 20, dipThreshold: 20 });
  assert.ok(zones.length >= 1);
  assert.ok(zones[0].from <= zones[0].to);
});

test("设置：不合法的值会退回默认", () => {
  const d = DCA.DEFAULT_CONFIG;
  assert.equal(DCA.withDefaults({ tqqqCap: -5 }).tqqqCap, d.tqqqCap);
  assert.equal(DCA.withDefaults({ tqqqCap: 0 }).tqqqCap, 0);
  assert.equal(DCA.withDefaults({ dipThreshold: 999 }).dipThreshold, d.dipThreshold);
  assert.equal(DCA.withDefaults({ frequency: "x" }).frequency, d.frequency);
  assert.equal(DCA.withDefaults({ frequency: "daily" }).frequency, "daily");
  assert.equal(DCA.withDefaults({ basis: "ath" }).basis, "ath");
  assert.equal(DCA.withDefaults({}).sellOnRecover, false);
  // 分档会排好序，并且一定有一个 0 起点
  const t = DCA.withDefaults({ tiers: [{ drawdown: 30, multiplier: 3 }, { drawdown: 10, multiplier: 2 }] }).tiers;
  assert.equal(t[0].drawdown, 0);
  assert.deepEqual(t.map((x) => x.drawdown), [0, 10, 30]);
});

test("默认设置就是「大跌才买 TQQQ + 上限」", () => {
  const d = DCA.DEFAULT_CONFIG;
  assert.equal(d.dipThreshold, 20);
  assert.equal(d.tqqqCap, 20);
  assert.equal(d.flowShare, 100);
  assert.equal(d.sellOnRecover, false);
  assert.equal(d.basis, "52w");
  assert.equal(d.maWindow, 200);
});
