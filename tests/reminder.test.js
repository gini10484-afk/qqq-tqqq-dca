// 运行：node --test tests/reminder.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DCA = require("../docs/strategy.js");
const { buildReminder } = require("../scripts/weekly_reminder.js");

// 造一段数据：前 60 天横盘 100，之后慢慢跌，最后一天跌到指定位置
function makeData(lastPrice, days = 140) {
  const rows = [];
  let d = DCA.dayNumber("2026-03-02");
  const px = [];
  for (let i = 0; i < days; i++) {
    if (i < 60) px.push(100);
    else px.push(100 * Math.pow(lastPrice / 100, (i - 59) / (days - 60)));
  }
  let t = 100;
  for (let i = 0; i < days; i++) {
    while (DCA.weekdayOf(d) < 1 || DCA.weekdayOf(d) > 5) d++;
    if (i > 0) t *= 1 + 3 * (px[i] / px[i - 1] - 1);
    rows.push([DCA.dateFromDayNumber(d), px[i], px[i], t, 1]);
    d++;
  }
  return { rows, source: "test" };
}

const CFG = { baseAmount: 100, investWeekday: 1, basis: "ath", maWindow: 20, dipThreshold: 20, tqqqCap: 20, flowShare: 100 };

test("周末不发提醒", () => {
  const r = buildReminder(makeData(100), { today: "2026-09-12", config: CFG }); // 周六
  assert.equal(r.skip, true);
});

test("每周定投：只在定投日发", () => {
  assert.equal(buildReminder(makeData(100), { today: "2026-09-15", config: CFG }).skip, true); // 周二
  assert.equal(buildReminder(makeData(100), { today: "2026-09-14", config: CFG }).skip, false); // 周一
});

test("每日定投：每个工作日都发", () => {
  const daily = { ...CFG, frequency: "daily" };
  assert.equal(buildReminder(makeData(100), { today: "2026-09-15", config: daily }).skip, false);
  assert.equal(buildReminder(makeData(100), { today: "2026-09-12", config: daily }).skip, true); // 周六还是不发
});

test("没跌的时候：买 QQQ、1 倍", () => {
  const r = buildReminder(makeData(100), { today: "2026-09-14", config: CFG });
  assert.equal(r.skip, false);
  assert.equal(r.asset, "QQQ");
  assert.equal(r.multiplier, 1);
  assert.match(r.title, /投 \$100\.00 买 QQQ（×1）/);
  assert.match(r.body, /不是大跌/);
});

test("跌破均线但不到门槛：加码但仍买 QQQ", () => {
  const r = buildReminder(makeData(85), { today: "2026-09-14", config: CFG }); // 回撤 15%
  assert.equal(r.asset, "QQQ");
  assert.ok(r.multiplier > 1, "应该加码");
  assert.match(r.body, /还没跌到 20%/);
});

test("跌够深：买 TQQQ，并提醒看占比", () => {
  const r = buildReminder(makeData(70), { today: "2026-09-14", config: CFG }); // 回撤 30%
  assert.equal(r.asset, "TQQQ");
  assert.match(r.title, /买 TQQQ/);
  assert.match(r.body, /按规则这次买 TQQQ/);
  assert.match(r.body, /超过 20% 就把超出的部分换回 QQQ/);
});

test("flowShare 小于 100 时会写清楚各买多少", () => {
  const r = buildReminder(makeData(70), { today: "2026-09-14", config: { ...CFG, flowShare: 50 } });
  assert.equal(r.asset, "TQQQ");
  assert.match(r.body, /买 TQQQ，剩下 .* 买 QQQ/);
});

test("没有数据就不发", () => {
  assert.equal(buildReminder({ rows: [] }, { today: "2026-09-14", config: CFG }).skip, true);
});

test("正文里带上网站链接", () => {
  const r = buildReminder(makeData(100), { today: "2026-09-14", owner: "me", repo: "r", config: CFG });
  assert.match(r.body, /https:\/\/me\.github\.io\/r\//);
});

test("提醒里写明这不是投资建议", () => {
  const r = buildReminder(makeData(100), { today: "2026-09-14", config: CFG });
  assert.match(r.body, /不是投资建议/);
});

// 一段横盘的行情，第三个参数决定要不要带 SPY 列
function flat(withSpy) {
  const rows = [];
  let d = DCA.dayNumber("2026-03-02");
  for (let i = 0; i < 300; i++) {
    while (DCA.weekdayOf(d) < 1 || DCA.weekdayOf(d) > 5) d++;
    const row = [DCA.dateFromDayNumber(d), 100, 100, 100, 1];
    if (withSpy) row.push(100);
    rows.push(row);
    d++;
  }
  return { rows };
}

test("有 SPY 数据时，提醒里会带上稳妥模式的分法", () => {
  const data = flat(true);
  const out = buildReminder(data, { today: data.rows[data.rows.length - 1][0], force: true });
  assert.equal(out.skip, false);
  assert.match(out.body, /稳妥模式/);
  assert.match(out.body, /SPY \$60\.00/);
  assert.match(out.body, /TQQQ \$10\.00/);
});

test("没有 SPY 数据时，提醒里不提稳妥模式", () => {
  const data = flat(false);
  const out = buildReminder(data, { today: data.rows[data.rows.length - 1][0], force: true });
  assert.equal(out.skip, false);
  assert.ok(!/稳妥模式/.test(out.body));
});

test("提醒里会写清楚两个买入条件离得多远", () => {
  const data = flat(true);
  const out = buildReminder(data, { today: data.rows[data.rows.length - 1][0], force: true });
  assert.match(out.body, /买 TQQQ 的两个条件/);
  assert.match(out.body, /跌破 200 日均线/);
  assert.match(out.body, /还差/);
});

test("卖出规则触发时，标题和正文都会提示", () => {
  const data = flat(true);
  const today = data.rows[data.rows.length - 1][0];
  // 横盘在均线上方：ma 规则要求清空
  const ma = buildReminder(data, { today, force: true, config: { sellMode: "ma" } });
  assert.match(ma.title, /该减 TQQQ/);
  assert.match(ma.body, /该减 TQQQ 了/);
  // 默认只守上限，不择时卖，就不该出现警告
  const cap = buildReminder(data, { today, force: true });
  assert.ok(!/该减 TQQQ/.test(cap.title));
  assert.match(cap.body, /暂时不用卖/);
});
