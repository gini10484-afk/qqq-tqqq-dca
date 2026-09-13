/*!
 * QQQ + TQQQ 组合定投的规则和回测
 * 同一份代码给网页和测试用（浏览器里是 window.DCA2，Node 里是 module.exports）
 *
 * 一句话规则：平时定投 QQQ；QQQ 跌破 200 日均线、而且离近一年最高点跌够多时，
 * 这一次的钱改买 TQQQ（3 倍做多纳指）；TQQQ 平时不卖，但占比超过上限就把超出的部分换回 QQQ。
 *
 * 重要：TQQQ 是每日 3 倍杠杆，长期单独持有会被磨损。1999 年一次性买入模拟的 TQQQ 拿到 2026 年
 * 只有 1.9 倍，同期 QQQ 是 16.5 倍，因为 2000—2002 年它跌掉了 99.95%。所以这里只把它当
 * “大跌时的加码工具”，而且一定要有占比上限。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCA2 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAY_MS = 86400000;

  // 网页第一次打开时的默认设置；改这里也会改定投日提醒
  var DEFAULT_CONFIG = {
    baseAmount: 100, // 每次的基础金额（美元）
    investWeekday: 1, // 每周几定投，1 = 周一
    frequency: "weekly", // "weekly" 每周一次 | "daily" 每个交易日
    basis: "52w", // 回撤跟谁比："52w" 近一年最高点 | "ath" 历史最高点
    maWindow: 200, // 均线天数
    dipThreshold: 20, // 跌破均线 + 回撤到这个百分比，才把钱买 TQQQ
    tqqqCap: 20, // TQQQ 占组合的上限（%），超过就换回 QQQ
    flowShare: 100, // 触发时，这一次的钱有百分之几买 TQQQ
    sellOnRecover: false, // true = 站回均线上方就把 TQQQ 全部换成 QQQ
    hotAbove: 15, // 比均线高这么多算“涨太多”
    hotMultiplier: 0.5, // 涨太多时的倍数
    tiers: [
      { drawdown: 0, multiplier: 1.5 },
      { drawdown: 20, multiplier: 2 },
      { drawdown: 30, multiplier: 3 },
    ], // 跌破均线后按回撤分档加码
  };

  var WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var MODE_NAMES = {
    plainQ: "普通定投（只买 QQQ）",
    comboQ: "综合策略（只买 QQQ）",
    fixed: "每次固定比例买 TQQQ",
    dip: "大跌才买 TQQQ",
  };
  var STATE_LABELS = { hot: "涨太多", up: "正常上涨", dip: "上涨中回调", down: "下跌趋势" };

  // ---------- 日期工具（只算日期，不涉及时区） ----------
  function dayNumber(dateStr) {
    var p = String(dateStr).split("-");
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY_MS);
  }
  function dateFromDayNumber(n) {
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
  }
  function weekdayOf(dayNum) {
    return ((dayNum + 4) % 7 + 7) % 7; // 1970-01-01 是周四
  }
  function mondayOf(dayNum) {
    var w = weekdayOf(dayNum);
    return dayNum - ((w + 6) % 7);
  }

  // ---------- 设置 ----------
  function normalizeTiers(tiers, fallback) {
    var list = (tiers || [])
      .map(function (t) {
        return { drawdown: Number(t.drawdown), multiplier: Number(t.multiplier) };
      })
      .filter(function (t) {
        return isFinite(t.drawdown) && t.drawdown >= 0 && t.drawdown < 100 && isFinite(t.multiplier) && t.multiplier >= 0 && t.multiplier <= 20;
      })
      .sort(function (a, b) { return a.drawdown - b.drawdown; });
    if (!list.length) return fallback.map(function (t) { return { drawdown: t.drawdown, multiplier: t.multiplier }; });
    if (list[0].drawdown > 0) list.unshift({ drawdown: 0, multiplier: list[0].multiplier });
    return list;
  }
  function num(v, lo, hi, dflt) {
    var x = Number(v);
    return isFinite(x) && x >= lo && x <= hi ? x : dflt;
  }
  function withDefaults(config) {
    var c = config || {};
    var d = DEFAULT_CONFIG;
    return {
      baseAmount: num(c.baseAmount, 0.01, 1e7, d.baseAmount),
      investWeekday: num(c.investWeekday, 1, 5, d.investWeekday),
      frequency: c.frequency === "daily" ? "daily" : "weekly",
      basis: c.basis === "ath" ? "ath" : "52w",
      maWindow: Math.round(num(c.maWindow, 20, 400, d.maWindow)),
      dipThreshold: num(c.dipThreshold, 0, 60, d.dipThreshold),
      tqqqCap: num(c.tqqqCap, 0, 100, d.tqqqCap),
      flowShare: num(c.flowShare, 0, 100, d.flowShare),
      sellOnRecover: !!c.sellOnRecover,
      hotAbove: num(c.hotAbove, 0, 100, d.hotAbove),
      hotMultiplier: num(c.hotMultiplier, 0, 5, d.hotMultiplier),
      tiers: normalizeTiers(c.tiers, d.tiers),
    };
  }

  // ---------- 数据 ----------
  // rows: [日期, QQQ 收盘, QQQ 复权价, TQQQ 复权价, 是不是真实 TQQQ 数据(1/0)]
  function prepare(data) {
    var rows = (data && data.rows) || [];
    var n = rows.length;
    var s = {
      n: n, dates: new Array(n), day: new Array(n),
      close: new Float64Array(n), adj: new Float64Array(n),
      t: new Float64Array(n), real: new Uint8Array(n),
    };
    for (var i = 0; i < n; i++) {
      var r = rows[i];
      s.dates[i] = r[0];
      s.day[i] = dayNumber(r[0]);
      s.close[i] = +r[1];
      s.adj[i] = +r[2];
      s.t[i] = +r[3];
      s.real[i] = r[4] ? 1 : 0;
    }
    s.firstRealIdx = -1;
    for (var k = 0; k < n; k++) if (s.real[k]) { s.firstRealIdx = k; break; }
    return s;
  }

  // 离最高点跌了多少（%）
  function drawdowns(series, basis) {
    var n = series.n, p = series.adj;
    var dd = new Float64Array(n), peak = new Float64Array(n);
    if (basis === "ath") {
      var hi = -Infinity;
      for (var i = 0; i < n; i++) {
        if (p[i] > hi) hi = p[i];
        peak[i] = hi;
        dd[i] = (1 - p[i] / hi) * 100;
      }
      return { dd: dd, peak: peak };
    }
    var win = 252, q = new Int32Array(n), head = 0, tail = 0;
    for (var j = 0; j < n; j++) {
      while (tail > head && q[head] < j - win + 1) head++;
      while (tail > head && p[q[tail - 1]] <= p[j]) tail--;
      q[tail++] = j;
      var h = p[q[head]];
      peak[j] = h;
      dd[j] = (1 - p[j] / h) * 100;
    }
    return { dd: dd, peak: peak };
  }

  // 均线，和“比均线高/低百分之几”
  function trendLines(series, win) {
    var n = series.n, p = series.adj;
    var ma = new Float64Array(n), dev = new Float64Array(n), ok = new Uint8Array(n);
    var sum = 0;
    for (var i = 0; i < n; i++) {
      sum += p[i];
      if (i >= win) sum -= p[i - win];
      if (i >= win - 1) {
        ma[i] = sum / win;
        dev[i] = (p[i] / ma[i] - 1) * 100;
        ok[i] = 1;
      }
    }
    return { ma: ma, dev: dev, ok: ok };
  }

  function multiplierFor(ddPct, tiers) {
    var m = tiers[0] ? tiers[0].multiplier : 1;
    for (var i = 0; i < tiers.length; i++) if (ddPct >= tiers[i].drawdown) m = tiers[i].multiplier;
    return m;
  }

  // 某一天（用这一天的收盘价）该怎么投
  function decide(cfg, dd, dev, ok, i) {
    if (i < 0 || !ok[i]) return { state: "up", multiplier: 1, buyTqqq: false };
    if (dev[i] < 0) {
      return {
        state: "down",
        multiplier: multiplierFor(dd[i], cfg.tiers),
        buyTqqq: dd[i] >= cfg.dipThreshold,
      };
    }
    if (dev[i] >= cfg.hotAbove) return { state: "hot", multiplier: cfg.hotMultiplier, buyTqqq: false };
    if (dd[i] >= 10) return { state: "dip", multiplier: 1, buyTqqq: false };
    return { state: "up", multiplier: 1, buyTqqq: false };
  }

  // 哪些天要投：每周定投取当周第一个不早于定投日的交易日；每日定投就是每个交易日
  function investDays(series, weekday, frequency) {
    var out = [], n = series.n, day = series.day, i = 0;
    if (frequency === "daily") {
      for (i = 0; i < n; i++) out.push(i);
      return out;
    }
    while (i < n) {
      var monday = mondayOf(day[i]);
      var j = i, pick = -1;
      while (j < n && mondayOf(day[j]) === monday) {
        if (pick < 0 && weekdayOf(day[j]) >= weekday) pick = j;
        j++;
      }
      if (pick < 0) {
        // 这周定投日当天及之后都休市：用这周最后一个交易日；数据里的最后一周先不算
        if (j < n) pick = j - 1;
        else break;
      }
      out.push(pick);
      i = j;
    }
    return out;
  }

  // 最新数据之后的下一个定投日（不知道美股假期，遇休市顺延）
  function nextInvestDate(lastDateStr, weekday, frequency) {
    var d = dayNumber(lastDateStr) + 1;
    if (frequency === "daily") {
      while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d++;
      return dateFromDayNumber(d);
    }
    while (weekdayOf(d) !== weekday) d++;
    return dateFromDayNumber(d);
  }

  // ---------- 当前信号 ----------
  function currentSignal(series, config, pre) {
    var cfg = withDefaults(config);
    var n = series.n;
    if (!n) return null;
    var dd = (pre && pre.dd) || drawdowns(series, cfg.basis).dd;
    var tl = (pre && pre.tl) || trendLines(series, cfg.maWindow);
    var i = n - 1; // 用最后一个交易日的收盘价决定下一次怎么投
    var r = decide(cfg, dd, tl.dev, tl.ok, i);
    return {
      basedOn: series.dates[i],
      nextDate: nextInvestDate(series.dates[i], cfg.investWeekday, cfg.frequency),
      weekdayName: WEEKDAY_CN[(weekdayOf(dayNumber(nextInvestDate(series.dates[i], cfg.investWeekday, cfg.frequency))) + 7) % 7],
      state: r.state,
      stateLabel: STATE_LABELS[r.state],
      multiplier: r.multiplier,
      amount: cfg.baseAmount * r.multiplier,
      asset: r.buyTqqq ? "TQQQ" : "QQQ",
      tqqqAmount: r.buyTqqq ? cfg.baseAmount * r.multiplier * cfg.flowShare / 100 : 0,
      drawdown: dd[i],
      dev: tl.ok[i] ? tl.dev[i] : null,
      ma: tl.ok[i] ? tl.ma[i] : null,
      price: series.adj[i],
      close: series.close[i],
      tqqqPrice: series.t[i],
      frequency: cfg.frequency,
      sellOnRecover: cfg.sellOnRecover && tl.ok[i] && tl.dev[i] >= 0,
    };
  }

  // ---------- XIRR ----------
  function xirr(flows, finalValue, finalDay) {
    if (!flows.length || !(finalValue > 0)) return 0;
    function npv(rate) {
      var t = -finalValue;
      for (var i = 0; i < flows.length; i++) t += flows[i][1] * Math.pow(1 + rate, (finalDay - flows[i][0]) / 365);
      return t;
    }
    var lo = -0.99, hi = 5;
    if (npv(lo) * npv(hi) > 0) return 0;
    for (var k = 0; k < 200; k++) {
      var mid = (lo + hi) / 2;
      if (npv(mid) > 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  // ---------- 回测 ----------
  // mode: "plainQ" 每次固定金额只买 QQQ | "comboQ" 按倍数只买 QQQ
  //     | "fixed" 每次固定把 fixedShare% 的钱买 TQQQ | "dip" 只在大跌时买 TQQQ
  var FEE = 0.0005; // 换仓的点差 + 手续费假设 0.05%

  function backtest(series, config, opts) {
    opts = opts || {};
    var cfg = withDefaults(config);
    var mode = MODE_NAMES[opts.mode] ? opts.mode : "dip";
    var fixedShare = num(opts.fixedShare, 0, 100, 20);
    var n = series.n;
    var dd = (opts.dd) || drawdowns(series, cfg.basis).dd;
    var tl = (opts.tl) || trendLines(series, cfg.maWindow);
    var startIdx = 0;
    if (opts.startDate) while (startIdx < n && series.dates[startIdx] < opts.startDate) startIdx++;
    var endIdx = n;
    if (opts.endDate) { endIdx = 0; while (endIdx < n && series.dates[endIdx] < opts.endDate) endIdx++; }
    if (startIdx < 1) startIdx = 1;
    if (endIdx <= startIdx) return null;

    var isInvestDay = new Uint8Array(n);
    var days = investDays(series, cfg.investWeekday, cfg.frequency);
    for (var a = 0; a < days.length; a++) if (days[a] >= startIdx && days[a] < endIdx) isInvestDay[days[a]] = 1;

    var shQ = 0, shT = 0, invested = 0, times = 0, tqqqBuys = 0, rebalances = 0, feePaid = 0;
    var flows = [];
    var curve = [], tshare = [], ratio = [];
    var peak = 0, mdd = 0, mddDate = null;
    var worstRatio = Infinity, worstDate = null;
    var under = 0, maxUnder = 0;

    for (var i = startIdx; i < endIdx; i++) {
      if (isInvestDay[i]) {
        var r = decide(cfg, dd, tl.dev, tl.ok, i - 1);
        var m = mode === "plainQ" ? 1 : r.multiplier;
        var amt = cfg.baseAmount * m;
        invested += amt; times++;
        flows.push([series.day[i], amt]);
        var toT = 0;
        if (mode === "fixed") toT = amt * fixedShare / 100;
        else if (mode === "dip" && r.buyTqqq) toT = amt * cfg.flowShare / 100;
        if (mode === "dip" && cfg.sellOnRecover && tl.ok[i - 1] && tl.dev[i - 1] >= 0 && shT > 0) {
          var v0 = shT * series.t[i];
          feePaid += v0 * FEE;
          shQ += v0 * (1 - FEE) / series.adj[i];
          shT = 0; rebalances++;
        }
        if (toT > 0) { shT += toT / series.t[i]; tqqqBuys++; }
        if (amt - toT > 0) shQ += (amt - toT) / series.adj[i];
        if (mode !== "plainQ" && mode !== "comboQ" && cfg.tqqqCap < 100) {
          var tv = shT * series.t[i], tot = shQ * series.adj[i] + tv;
          if (tot > 0 && tv / tot > cfg.tqqqCap / 100) {
            var ex = tv - tot * cfg.tqqqCap / 100;
            shT -= ex / series.t[i];
            feePaid += ex * FEE;
            shQ += ex * (1 - FEE) / series.adj[i];
            rebalances++;
          }
        }
      }
      var vq = shQ * series.adj[i], vt = shT * series.t[i], v = vq + vt;
      curve.push(v);
      tshare.push(v > 0 ? vt / v * 100 : 0);
      ratio.push(invested > 0 ? v / invested : 1);
      if (v > peak) peak = v;
      if (peak > 0) {
        var d0 = v / peak - 1;
        if (d0 < mdd) { mdd = d0; mddDate = series.dates[i]; }
      }
      if (invested > 0) {
        var rr = v / invested;
        if (rr < worstRatio) { worstRatio = rr; worstDate = series.dates[i]; }
        if (v < invested) { under++; if (under > maxUnder) maxUnder = under; } else under = 0;
      }
    }

    var last = endIdx - 1;
    var value = shQ * series.adj[last] + shT * series.t[last];
    return {
      mode: mode,
      modeName: MODE_NAMES[mode],
      startDate: series.dates[startIdx],
      endDate: series.dates[last],
      times: times,
      tqqqBuys: tqqqBuys,
      rebalances: rebalances,
      feePaid: feePaid,
      invested: invested,
      value: value,
      valueQ: shQ * series.adj[last],
      valueT: shT * series.t[last],
      tqqqShare: value > 0 ? shT * series.t[last] / value * 100 : 0,
      profit: value - invested,
      totalReturn: invested > 0 ? value / invested - 1 : 0,
      xirr: xirr(flows, value, series.day[last]),
      maxDrawdown: mdd * 100,
      maxDrawdownDate: mddDate,
      worstRatio: worstRatio === Infinity ? 1 : worstRatio,
      worstRatioDate: worstDate,
      underwaterYears: maxUnder / (cfg.frequency === "daily" ? 252 : 252),
      curve: curve,
      tshare: tshare,
      ratio: ratio, // 市值 ÷ 已投入的钱
      firstIdx: startIdx,
      lastIdx: last,
    };
  }

  // 几种做法一起比
  function compareModes(series, config, opts) {
    opts = opts || {};
    var cfg = withDefaults(config);
    var pre = { dd: drawdowns(series, cfg.basis).dd, tl: trendLines(series, cfg.maWindow) };
    var list = opts.modes || ["plainQ", "comboQ", "fixed", "dip"];
    return list.map(function (m) {
      return backtest(series, config, {
        mode: m, dd: pre.dd, tl: pre.tl,
        startDate: opts.startDate, endDate: opts.endDate, fixedShare: opts.fixedShare,
      });
    }).filter(Boolean);
  }

  // 滚动 N 年：每年 1 月开始，投 N 年
  function rollingWindows(series, config, opts) {
    opts = opts || {};
    var years = Math.round(num(opts.years, 3, 20, 10));
    var cfg = withDefaults(config);
    var pre = { dd: drawdowns(series, cfg.basis).dd, tl: trendLines(series, cfg.maWindow) };
    var first = +series.dates[0].slice(0, 4) + 1;
    var lastYear = +series.dates[series.n - 1].slice(0, 4);
    var modes = opts.modes || ["comboQ", "dip"];
    var out = [];
    for (var y = first; y + years <= lastYear + 1; y++) {
      var row = { year: y, results: {} };
      var okAll = true;
      for (var k = 0; k < modes.length; k++) {
        var r = backtest(series, config, {
          mode: modes[k], dd: pre.dd, tl: pre.tl,
          startDate: y + "-01-01", endDate: (y + years) + "-01-01", fixedShare: opts.fixedShare,
        });
        if (!r) { okAll = false; break; }
        row.results[modes[k]] = r;
      }
      if (okAll) out.push(row);
    }
    return out;
  }

  // 从不同年份开始投到今天
  function compareStarts(series, config, years, opts) {
    opts = opts || {};
    var cfg = withDefaults(config);
    var pre = { dd: drawdowns(series, cfg.basis).dd, tl: trendLines(series, cfg.maWindow) };
    var modes = opts.modes || ["comboQ", "dip"];
    var out = [];
    for (var i = 0; i < years.length; i++) {
      var row = { year: years[i], results: {} };
      var ok = true;
      for (var k = 0; k < modes.length; k++) {
        var r = backtest(series, config, { mode: modes[k], dd: pre.dd, tl: pre.tl, startDate: years[i] + "-01-01", fixedShare: opts.fixedShare });
        if (!r) { ok = false; break; }
        row.results[modes[k]] = r;
      }
      if (ok) out.push(row);
    }
    return out;
  }

  // 历史上买 TQQQ 的时间段（用来在图上画出来）
  function tqqqPeriods(series, config, pre) {
    var cfg = withDefaults(config);
    var dd = (pre && pre.dd) || drawdowns(series, cfg.basis).dd;
    var tl = (pre && pre.tl) || trendLines(series, cfg.maWindow);
    var out = [], cur = null;
    for (var i = 0; i < series.n; i++) {
      var on = tl.ok[i] && tl.dev[i] < 0 && dd[i] >= cfg.dipThreshold;
      if (on && !cur) cur = { from: series.dates[i], fromIdx: i };
      if (!on && cur) { cur.to = series.dates[i - 1]; cur.toIdx = i - 1; out.push(cur); cur = null; }
    }
    if (cur) { cur.to = series.dates[series.n - 1]; cur.toIdx = series.n - 1; out.push(cur); }
    return out;
  }

  // ---------- 我的持仓：现在 TQQQ 占多少、要不要再平衡 ----------
  function holdingsCheck(series, config, holding) {
    var cfg = withDefaults(config);
    var i = series.n - 1;
    var q = Math.max(0, Number(holding && holding.qqqShares) || 0);
    var t = Math.max(0, Number(holding && holding.tqqqShares) || 0);
    var pq = series.close[i], pt = series.t[i];
    var vq = q * pq, vt = t * pt, tot = vq + vt;
    var share = tot > 0 ? vt / tot * 100 : 0;
    var over = tot > 0 ? Math.max(0, vt - tot * cfg.tqqqCap / 100) : 0;
    return {
      date: series.dates[i], qqqPrice: pq, tqqqPrice: pt,
      qqqValue: vq, tqqqValue: vt, total: tot,
      tqqqShare: share, cap: cfg.tqqqCap,
      overAmount: over, overShares: pt > 0 ? over / pt : 0,
      needRebalance: over > 0.01 * tot && over > 1,
    };
  }

  // ---------- 资金计划：手里的闲钱，每次该投多少 ----------
  function periodMultipliers(series, config, pre) {
    var cfg = withDefaults(config);
    var dd = (pre && pre.dd) || drawdowns(series, cfg.basis).dd;
    var tl = (pre && pre.tl) || trendLines(series, cfg.maWindow);
    var days = investDays(series, cfg.investWeekday, cfg.frequency);
    var out = [];
    for (var i = 0; i < days.length; i++) {
      if (days[i] < 1) continue;
      out.push(decide(cfg, dd, tl.dev, tl.ok, days[i] - 1).multiplier);
    }
    return out;
  }

  // 保守：任何一段开始都不会把钱投光；平均：长期平均刚好投完
  function planBudget(mults, input, nowMultiplier) {
    var perWeek = num(input.perWeek, 1, 10, 1);
    var periods = Math.max(1, Math.round(num(input.weeks, 1, 520, 52) * perWeek));
    var rate = num(input.rate, 0.1, 100, 7);
    var share = num(input.share, 0, 100, 30) / 100;
    var cash = Math.max(0, Number(input.cash) || 0) * share;
    var monthly = Math.max(0, Number(input.monthly) || 0) * share;
    var inflowPer = monthly * 12 / 52 / perWeek; // 每月新增的钱摊到每次定投
    var poolUsd = cash / rate;
    var inflowUsd = inflowPer / rate;
    var worst = 1;
    if (mults && mults.length) {
      for (var s = 0; s + periods <= mults.length; s++) {
        var sum = 0;
        for (var k = 0; k < periods; k++) sum += mults[s + k];
        if (sum / periods > worst) worst = sum / periods;
      }
      if (mults.length < periods) {
        var t = 0;
        for (var j = 0; j < mults.length; j++) t += mults[j];
        worst = Math.max(worst, t / mults.length);
      }
    }
    var avg = 1;
    if (mults && mults.length) {
      var tot = 0;
      for (var m = 0; m < mults.length; m++) tot += mults[m];
      avg = tot / mults.length;
    }
    var baseSafe = (poolUsd / periods + inflowUsd) / worst;
    var baseAvg = (poolUsd / periods + inflowUsd) / avg;
    var mult = num(nowMultiplier, 0, 20, 1);
    return {
      periods: periods, perWeek: perWeek, rate: rate,
      poolUsd: poolUsd, inflowUsd: inflowUsd,
      worstAvgMultiplier: worst, avgMultiplier: avg,
      baseSafe: baseSafe, baseAvg: baseAvg,
      nowSafe: baseSafe * mult, nowAvg: baseAvg * mult,
      baseSafeLocal: baseSafe * rate, baseAvgLocal: baseAvg * rate,
      nowSafeLocal: baseSafe * mult * rate, nowAvgLocal: baseAvg * mult * rate,
    };
  }

  // ---------- 每年数据表 ----------
  function yearly(series, results) {
    var byYear = {}, order = [];
    var idx = results.firstIdx;
    for (var i = idx; i <= results.lastIdx; i++) {
      var y = series.dates[i].slice(0, 4);
      if (!byYear[y]) { byYear[y] = { year: y, endIdx: i, startIdx: i }; order.push(y); }
      byYear[y].endIdx = i;
    }
    return order.map(function (y) {
      var r = byYear[y], k = r.endIdx - idx;
      return {
        year: y,
        value: results.curve[k],
        tqqqShare: results.tshare[k],
        qqq: series.adj[r.endIdx] / series.adj[r.startIdx] - 1,
      };
    });
  }

  return {
    DAY_MS: DAY_MS,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    MODE_NAMES: MODE_NAMES,
    STATE_LABELS: STATE_LABELS,
    WEEKDAY_CN: WEEKDAY_CN,
    FEE: FEE,
    dayNumber: dayNumber,
    dateFromDayNumber: dateFromDayNumber,
    weekdayOf: weekdayOf,
    mondayOf: mondayOf,
    withDefaults: withDefaults,
    normalizeTiers: normalizeTiers,
    prepare: prepare,
    drawdowns: drawdowns,
    trendLines: trendLines,
    multiplierFor: multiplierFor,
    decide: decide,
    investDays: investDays,
    nextInvestDate: nextInvestDate,
    currentSignal: currentSignal,
    xirr: xirr,
    backtest: backtest,
    compareModes: compareModes,
    rollingWindows: rollingWindows,
    compareStarts: compareStarts,
    tqqqPeriods: tqqqPeriods,
    holdingsCheck: holdingsCheck,
    periodMultipliers: periodMultipliers,
    planBudget: planBudget,
    yearly: yearly,
  };
});
