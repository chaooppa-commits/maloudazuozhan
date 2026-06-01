/**
 * Doukou Observer Simulator - App Controller
 * JavaScript port of observer_simulator.py game flow + UI
 * @version 3.0 (2026-05-19)
 */

const APP_VERSION = 'v3.0';

// ═══════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════

const INITIAL_PURSE = 50;
const MAX_ROUNDS = 100;
const PLAYERS = ['Boss', 'A', 'B', 'C'];
const STAKE_OPTIONS = [4, 8, 12, 16];

// Google Sheets 后端地址
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbyr642X7bS2OmE6S9yniexGygBUl1QoN2VXJuFNUwoHvUhF_MAecaEXP_H-XRgpx4hgaA/exec';

// ═══════════════════════════════════════════════════════
// Google Sheets 上报
// ═══════════════════════════════════════════════════════

function reportToSheets() {
  const username = game._username || '匿名';
  const pincode  = game._pincode  || '';
  const buyin    = game._buyin    || INITIAL_PURSE;

  const totalRounds = game.roundNo;
  const betRounds   = game.stats.bet;
  const skipRounds  = game.stats.skip;
  const wins        = game.stats.win;
  const totalStaked = game.stats.totalStaked;
  const netPnl      = game.obsPurse - buyin;
  // 新荷包 = 入场前云端总荷包 + 本场净盈亏（而非仅本场结束筹码）
  const cloudWallet = game._walletBefore || buyin;
  const newWallet   = cloudWallet + netPnl;
  game._walletAfter = newWallet; // 供 backToStart 先斩后奏使用

  const actionRate = totalRounds > 0 ? +(betRounds / totalRounds * 100).toFixed(1) : 0;
  const winRate    = betRounds   > 0 ? +(wins      / betRounds   * 100).toFixed(1) : 0;
  const roi        = totalStaked > 0 ? +(netPnl    / totalStaked * 100).toFixed(1) : 0;
  const avgStake   = betRounds   > 0 ? +(totalStaked / betRounds).toFixed(1)       : 0;

  // 影子对标
  const shad = (typeof shadow !== 'undefined') ? shadow : null;
  const shadowWinRate = shad && shad.bet > 0 ? +(shad.win / shad.bet * 100).toFixed(1) : 0;
  const shadowRoi     = shad && shad.totalStaked > 0
    ? +((shad.purse - buyin) / shad.totalStaked * 100).toFixed(1) : 0;

  // 場序号：localStorage 累计
  const histKey   = 'doukou_sessionno_' + username;
  const sessionNo = (parseInt(localStorage.getItem(histKey), 10) || 0) + 1;
  localStorage.setItem(histKey, sessionNo);

  const params = new URLSearchParams({
    action:      'endSession',
    user:        username,
    pincode:     pincode,
    sid:         String(game.seed),
    ts:          new Date().toISOString(),
    buyin:       buyin,
    finalPurse:  game.obsPurse,
    netPnl:      netPnl,
    newWallet:   newWallet,
    exit:        game.exitReason || 'normal',
    totalRounds: totalRounds,
    betRounds:   betRounds,
    skipRounds:  skipRounds,
    actionRate:  actionRate,
    winRate:     winRate,
    roi:         roi,
    totalStaked: totalStaked,
    avgStake:    avgStake,
    rationalCnt: game.stats.rationalCnt,
    aggressCnt:  game.stats.aggressCnt,
    conservCnt:  game.stats.conservCnt,
    dodgeCorrect: game.stats.dodgeCorrect,
    dodgeTotal:   game.stats.dodgeTotal,
    // 起死回生：仅本场赢时上报最低值，输场上报0
    comebackMin: (netPnl > 0 && game.stats.comebackMin !== null) ? game.stats.comebackMin : 0,
    shadowWinRate: shadowWinRate,
    shadowRoi:     shadowRoi,
    sessionNo:     sessionNo
  });

  // ═══ 【测试沙盒】拦截，不上报真实数据 ═══
  if (window.IS_TEST_MODE) {
    console.log('[沙盒模拟上报] 数据包：', {
      用户: username,
      云端原荷包: cloudWallet,
      本场带入: buyin,
      本场盈亏: netPnl,
      模拟新荷包: newWallet,
      理性局: game.stats.rationalCnt,
      冒进局: game.stats.aggressCnt,
      保守局: game.stats.conservCnt
    });
    return;
  }
  // ═══════════════════════════════════════

  fetch(SHEETS_URL + '?' + params.toString())
    .then(r => r.json())
    .then(data => {
      if (data.status === 'ok') {
        console.log('[Sheets] endSession ok, newWallet=', data.newWallet);
      } else {
        console.warn('[Sheets] endSession error:', data);
      }
    })
    .catch(err => console.warn('[Sheets] endSession fetch failed:', err));
}

// ═══════════════════════════════════════════════════════
// Game State
// ═══════════════════════════════════════════════════════

const game = {
  // Config
  kellyMode: false,
  seed: 0,
  rng: null,

  // Session state
  obsPurse: INITIAL_PURSE,
  bossPurse: INITIAL_PURSE,
  roundNo: 0,
  phase: 'start', // start | betting | revealing | result | ended

  // Current round
  hands: null,
  currentBet: null, // { target, amount }

  // Stats
  stats: {
    skip: 0, bet: 0, win: 0, lose: 0, totalStaked: 0,
    betTargetCount: { A: 0, B: 0, C: 0 },
    stakeCount: {} // { amount: count }
  },

  // Session log
  log: [],

  // PnL history for chart
  pnlHistory: [0],

  exitReason: ''
};

// ═══════════════════════════════════════════════════════
// Kelly Stake
// ═══════════════════════════════════════════════════════

function kellyStake(purse, bossPurse) {
  const fraction = 0.20;
  let best = Math.floor(purse * fraction);

  if (best < 2 && purse >= 2) best = 2;
  if (best > bossPurse) best = bossPurse;
  if (best > purse) best = purse;
  if (best < 1) best = 0;

  return best;
}

// ═══════════════════════════════════════════════════════
// Settlement
// ═══════════════════════════════════════════════════════

function settle(hands, betTarget, betAmount) {
  const boss = hands[0];
  const targetIdxMap = { A: 1, B: 2, C: 3 };

  const employeeResults = {};
  for (const [label, idx] of Object.entries(targetIdxMap)) {
    const cmp = compareHands(boss, hands[idx]);
    employeeResults[label] = {
      won: cmp.winner === 'employee',
      mult: cmp.payoutMultiplier,
      reason: cmp.reason
    };
  }

  let observerPnl = 0;
  let bossPnl = 0;

  if (betTarget !== 'SKIP' && betAmount > 0) {
    const er = employeeResults[betTarget];
    if (er.won) {
      const gain = betAmount * er.mult;
      // Cap gain at boss purse
      observerPnl = Math.min(gain, game.bossPurse);
      bossPnl = -observerPnl;
    } else {
      observerPnl = -betAmount;
      bossPnl = betAmount;
    }
  }

  return { employeeResults, observerPnl, bossPnl };
}

// ═══════════════════════════════════════════════════════
// Game Flow
// ═══════════════════════════════════════════════════════

function startGame(kellyMode, seedStr, buyin) {
  const initialPurse = buyin || INITIAL_PURSE;
  game.kellyMode = kellyMode;
  game.seed = seedStr ? (parseInt(seedStr) || hashCode(seedStr)) : Math.floor(Date.now() / 1000);
  game.rng = mulberry32(game.seed);
  game.obsPurse = initialPurse;
  game.bossPurse = initialPurse;
  game._initialPurse = initialPurse; // 记录本场带入金额
  game.roundNo = 0;
  game.phase = 'betting';
  game.hands = null;
  game.currentBet = null;
  game.stats = {
    skip: 0, bet: 0, win: 0, lose: 0, totalStaked: 0,
    betTargetCount: { A: 0, B: 0, C: 0 },
    stakeCount: {},
    flatEat: { obs: 0, A: 0, B: 0, C: 0 },
    rationalCnt: 0,
    aggressCnt:  0,
    conservCnt:  0,
    dodgeCorrect: 0,  // 精准闪避：跳过时最强员工输了
    dodgeTotal: 0,    // 精准闪避：总跳过局数
    comebackMin: null  // 起死回生：筹码跌破初始后的最低值（null=未跌破）
  };
  game.log = [];
  game.pnlHistory = [0];
  game.exitReason = '';
  game.obsMaxPurse = initialPurse;
  game.obsMinPurse = initialPurse;

  // Log session start
  pushLog({
    type: 'session_start',
    seed: game.seed,
    initialPurse: initialPurse,
    maxRounds: MAX_ROUNDS,
    kellyMode: game.kellyMode
  });

  nextRound();
}

function nextRound() {
  game.roundNo++;
  if (game.roundNo > MAX_ROUNDS || game.obsPurse <= 0 || game.bossPurse <= 0) {
    endGame('normal');
    return;
  }

  game.hands = dealRound(game.rng);
  game.phase = 'betting';
  game.currentBet = null;

  renderGameScreen();
}

function placeBet(target, amount) {
  if (game.phase !== 'betting') return;

  // 🛡️ 防御：hands 未初始化时安全回退
  if (!game.hands || game.hands.length < 4) {
    console.error('[placeBet] game.hands not ready, aborting bet');
    return;
  }

  if (target === 'SKIP') {
    game.currentBet = { target: 'SKIP', amount: 0 };
    game.stats.skip++;
  } else if (target === 'RUN') {
    game.roundNo--;
    game.exitReason = 'voluntary_run';
    pushLog({
      type: 'voluntary_run',
      beforeRound: game.roundNo + 1,
      observerPurse: game.obsPurse,
      bossPurse: game.bossPurse
    });
    endGame('voluntary_run');
    return;
  } else {
    // Validate amount
    if (amount > game.obsPurse) amount = game.obsPurse;
    if (amount > game.bossPurse) amount = game.bossPurse;
    if (amount < 1) return;

    game.currentBet = { target, amount };
    game.stats.bet++;
    game.stats.totalStaked += amount;
    game.stats.betTargetCount[target]++;
    game.stats.stakeCount[amount] = (game.stats.stakeCount[amount] || 0) + 1;
  }

  // Reveal
  game.phase = 'revealing';
  renderGameScreen();
  
  // Short delay then show result
  setTimeout(() => {
    const settlement = settle(game.hands, game.currentBet.target, game.currentBet.amount);
    const { observerPnl, bossPnl } = settlement;
  
    game.obsPurse += observerPnl;
    game.bossPurse += bossPnl;
  
    // 追踪观察者最高/最低筹码
    if (game.obsPurse > game.obsMaxPurse) game.obsMaxPurse = game.obsPurse;
    if (game.obsPurse < game.obsMinPurse) game.obsMinPurse = game.obsPurse;
  
    // 追踪起死回生：筹码跌破初始值后记录最低点
    if (game.obsPurse < game._initialPurse) {
      if (game.stats.comebackMin === null || game.obsPurse < game.stats.comebackMin) {
        game.stats.comebackMin = game.obsPurse;
      }
    }
  
    if (game.currentBet.target !== 'SKIP') {
      if (observerPnl > 0) game.stats.win++;
      else game.stats.lose++;
    }
  
    // 统计平吃：庄家平吃各玩家（分数相同或双方无斗口）
    for (const lbl of ['A', 'B', 'C']) {
      const er = settlement.employeeResults[lbl];
      if (!er.won && er.reason &&
          (er.reason.includes('点数相同') || er.reason === '双方无斗口')) {
        game.stats.flatEat[lbl]++;
        // 如果观察者押注了这个玩家，也计入 obs
        if (game.currentBet.target === lbl) {
          game.stats.flatEat.obs++;
        }
      }
    }
  
    // 精准闪避统计：SKIP时，最强员工是否输了（输了=闪避成功）
    if (game.currentBet.target === 'SKIP') {
      game.stats.dodgeTotal++;
      // 找出本局战力最强的员工
      const allVisible = [];
      for (let i = 0; i < 4; i++) allVisible.push(game.hands[i][0], game.hands[i][1]);
      let strongestEmp = null;
      let strongestPower = -999;
      for (const lbl of ['A', 'B', 'C']) {
        const idx = { A: 1, B: 2, C: 3 }[lbl];
        const v = [game.hands[idx][0], game.hands[idx][1]];
        const info = lookupTier(v[0], v[1]);
        const power = info ? info.mp : 30;
        if (power > strongestPower) {
          strongestPower = power;
          strongestEmp = lbl;
        }
      }
      if (strongestEmp && !settlement.employeeResults[strongestEmp].won) {
        game.stats.dodgeCorrect++;
      }
    }

    // Track PnL
    const cumPnl = game.pnlHistory[game.pnlHistory.length - 1] + observerPnl;
    game.pnlHistory.push(cumPnl);
  
    // Evaluate action
    const actionEval = evaluateAction(game.hands, game.currentBet.target, game.currentBet.amount);
    
      // 累计理性/冒进/保守计数
      if (actionEval.tag === '理性') game.stats.rationalCnt++;
      else if (actionEval.tag === '冒进') game.stats.aggressCnt++;
      else if (actionEval.tag === '保守') game.stats.conservCnt++;
  
    // Log round
    pushLog({
      type: 'round',
      round: game.roundNo,
      visible: PLAYERS.reduce((acc, p, i) => {
        acc[p] = [game.hands[i][0], game.hands[i][1]];
        return acc;
      }, {}),
      finalHands: PLAYERS.reduce((acc, p, i) => {
        acc[p] = game.hands[i];
        return acc;
      }, {}),
      finalStructures: PLAYERS.reduce((acc, p, i) => {
        acc[p] = explainHand(game.hands[i]);
        return acc;
      }, {}),
      employeeResults: settlement.employeeResults,
      betTarget: game.currentBet.target,
      betAmount: game.currentBet.amount,
      observerPnl,
      bossPnl,
      observerPurseAfter: game.obsPurse,
      bossPurseAfter: game.bossPurse,
      actionEval,
      // Extra fields for analysis
      empWinCount: ['A','B','C'].filter(l => settlement.employeeResults[l].won).length,
      empWith10pts: ['A','B','C'].filter(l => {
        const er = settlement.employeeResults[l];
        return er.won && er.mult >= 2;
      }).length
    });
  
    game.phase = 'result';
    renderGameScreen(settlement, actionEval);
  
    // Check termination
    if (game.obsPurse <= 0) {
      setTimeout(() => endGame('observer_broke'), 1500);
    } else if (game.bossPurse <= 0) {
      setTimeout(() => endGame('boss_broke'), 1500);
    }
  }, 300);
}

function endGame(reason) {
  game.phase = 'ended';
  if (!game.exitReason) game.exitReason = reason;

  pushLog({
    type: 'session_end',
    roundsPlayed: game.roundNo,
    observerFinal: game.obsPurse,
    bossFinal: game.bossPurse,
    exitReason: game.exitReason,
    stats: game.stats,
    shadow: typeof shadow !== 'undefined' ? {
      finalPurse: shadow.purse,
      netPnl: shadow.purse - (typeof INITIAL_PURSE !== 'undefined' ? INITIAL_PURSE : 50),
      rounds: shadow.bet + shadow.skip,
      bet: shadow.bet,
      skip: shadow.skip,
      win: shadow.win,
      lose: shadow.lose,
      totalStaked: shadow.totalStaked,
      winRate: shadow.bet > 0 ? +(shadow.win / shadow.bet * 100).toFixed(1) : 0,
      roi: shadow.totalStaked > 0
        ? +((shadow.purse - (typeof INITIAL_PURSE !== 'undefined' ? INITIAL_PURSE : 50)) / shadow.totalStaked * 100).toFixed(1)
        : 0,
      exited: shadow.exited
    } : null
  });

  saveLogToStorage();
  reportToSheets();
  renderEndScreen();
}

// ═══════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════

function pushLog(entry) {
  entry.timestamp = new Date().toISOString();
  game.log.push(entry);
}

function saveLogToStorage() {
  const key = `doukou_log_${game.seed}`;
  const jsonl = game.log.map(e => JSON.stringify(e)).join('\n');
  try {
    localStorage.setItem(key, jsonl);
  } catch (e) {
    // Storage full - ignore
  }
}

function downloadLog() {
  const jsonl = game.log.map(e => JSON.stringify(e)).join('\n');
  const blob = new Blob([jsonl], { type: 'application/jsonl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `observer_session_seed${game.seed}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function getVisible(hand) {
  return [hand[0], hand[1]];
}

/**
 * 5星战力分级（基于4人局50000局模拟 p_eq 数据）
 * tier: 5=5星, 4=4星, 3=3星, 2=2星, 1=1星
 * p_eq: 等效胜率（％），取自 50000局模拟数据
 * 口评0:
 *   5星: 1234(18 27 36 45 p_eq≈5353) | 12(12 23 p_eq≈50)
 *   4星: 127(13 24 78 p_eq≈49) | 235(25 38 58 p_eq≈48) | 631(68 34 14 p_eq≈48)
 *   3星: 234(26 35 48) | 876(89 79 67) | 554(57 56 47) | 1156(15 11 59 69) — p_eq 45–47
 *   2星: 4311(49 39 16 17) | 222(22 28 29) — p_eq 43–45
 *   1星: 3348(33 37 46 88) | 479(44 77 99) | 156(19 66 55) — p_eq <42
 */
const CORRECTED_TABLE = {
  // 5星（p_eq >= 50）
  '1,8': { tier: 5, p_eq: 54.32, mn: '1234', mp: 54 },
  '3,6': { tier: 5, p_eq: 53.45, mn: '1234', mp: 53 },
  '4,5': { tier: 5, p_eq: 53.34, mn: '1234', mp: 53 },
  '2,7': { tier: 5, p_eq: 53.26, mn: '1234', mp: 53 },
  '1,2': { tier: 5, p_eq: 50.98, mn: '12',   mp: 51 },
  '2,3': { tier: 5, p_eq: 49.68, mn: '12',   mp: 50 },
  // 4星（p_eq 47–49.6）
  '1,3': { tier: 4, p_eq: 49.06, mn: '127', mp: 49 },
  '2,4': { tier: 4, p_eq: 48.81, mn: '127', mp: 49 },
  '7,8': { tier: 4, p_eq: 48.66, mn: '127', mp: 49 },
  '3,8': { tier: 4, p_eq: 48.22, mn: '235', mp: 48 },
  '2,5': { tier: 4, p_eq: 47.99, mn: '235', mp: 48 },
  '5,8': { tier: 4, p_eq: 47.89, mn: '235', mp: 48 },
  '6,8': { tier: 4, p_eq: 47.86, mn: '631', mp: 48 },
  '3,4': { tier: 4, p_eq: 47.80, mn: '631', mp: 48 },
  '1,4': { tier: 4., p_eq: 47.08, mn: '631', mp: 47 },

  // 3星（p_eq 45–47.1）
  '4,8': { tier: 3., p_eq: 47.31, mn: '234', mp: 47 },
  '3,5': { tier: 3, p_eq: 47.07, mn: '234', mp: 47 },
  '2,6': { tier: 3, p_eq: 46.89, mn: '234', mp: 47 },
  '8,9': { tier: 3, p_eq: 46.86, mn: '876', mp: 46 },
  '7,9': { tier: 3, p_eq: 45.73, mn: '876', mp: 46 },
  '6,7': { tier: 3, p_eq: 46.44, mn: '876', mp: 46 },
  '5,7': { tier: 3, p_eq: 45.78, mn: '554', mp: 46 },
  '5,6': { tier: 3, p_eq: 45.61, mn: '554', mp: 46 },
  '4,7': { tier: 3, p_eq: 45.45, mn: '554', mp: 46 },
  '1,1': { tier: 3, p_eq: 45.37, mn: '1156', mp: 45 },
  '1,5': { tier: 3, p_eq: 45.37, mn: '1156', mp: 45 },
  '5,9': { tier: 3, p_eq: 45.07, mn: '1156', mp: 45 },
  '6,9': { tier: 3., p_eq: 44.83, mn: '1156', mp: 44 },
  // 2星（p_eq 43–45）
  '4,9': { tier: 2, p_eq: 44.52, mn: '4311', mp: 44 },
  '3,9': { tier: 2, p_eq: 44.00, mn: '4311', mp: 44 },
  '1,6': { tier: 2, p_eq: 43.85, mn: '4311', mp: 44 },
  '1,7': { tier: 2, p_eq: 43.84, mn: '4311', mp: 44 },
  '2,2': { tier: 2, p_eq: 43.77, mn: '222', mp: 43 },
  '2,9': { tier: 2, p_eq: 43.31, mn: '222', mp: 43 },
  '2,8': { tier: 2., p_eq: 42.72, mn: '222', mp: 41 },  
  // 1星（p_eq < 43）
  '3,3': { tier: 1, p_eq: 41.44, mn: '3348', mp: 41 },
  '3,7': { tier: 1, p_eq: 41.37, mn: '3348', mp: 41 },
  '4,6': { tier: 1, p_eq: 41.35, mn: '3348', mp: 41 },
  '8,8': { tier: 1, p_eq: 39.78, mn: '3348', mp: 40 },
  '4,4': { tier: 1, p_eq: 38.54, mn: '479', mp: 38 },
  '7,7': { tier: 1, p_eq: 38.24, mn: '479', mp: 38 },
  '9,9': { tier: 1, p_eq: 37.50, mn: '479', mp: 38 },
  '1,9': { tier: 1, p_eq: 36.99, mn: '156', mp: 36 },
  '6,6': { tier: 1, p_eq: 36.20, mn: '156', mp: 36 },
  '5,5': { tier: 1, p_eq: 30.76, mn: '156', mp: 30 },
};

/**
 * Look up corrected tier info for a visible pair.
 * Returns { tier, winRate, correctedRate, avgMult, ev } or null.
 */
function lookupTier(a, b) {
  const key = [Math.min(a,b), Math.max(a,b)].join(',');
  return CORRECTED_TABLE[key] || null;
}

// ═══════════════════════════════════════════════════════
// Action Evaluation (出手规范分析)
// ═══════════════════════════════════════════════════════

// 星级标签文本
const TIER_LABEL = { 5: '5星', 4: '4星', 3: '3星', 2: '2星', 1: '1星' };

// 推荐注码：2档差┩4, 3档差┩8, 4档差┩12, 4档差特殊┩16
const STAKE_FOR_GAP = { 2: 4, 3: 8, 4: 12 };

function tierLabel(t) { return TIER_LABEL[t] || `${t}星`; }

function getPlayerPower(hand) {
  const v = [hand[0], hand[1]];
  return lookupTier(v[0], v[1]);
}

function evaluateAction(hands, betTarget, betAmount) {
  const bossInfo = getPlayerPower(hands[0]);
  const empInfos = {
    A: getPlayerPower(hands[1]),
    B: getPlayerPower(hands[2]),
    C: getPlayerPower(hands[3])
  };

  const bossTier = bossInfo ? bossInfo.tier : 3;
  const bossRate = bossInfo ? bossInfo.p_eq : 45;

  // 计算每个员工vs老板的战力差
  const gaps = {};
  for (const lbl of ['A', 'B', 'C']) {
    const info = empInfos[lbl];
    if (info) {
      gaps[lbl] = {
        rateDiff: info.p_eq - bossRate,
        tierDiff: info.tier - bossTier,
        tier: info.tier,
        rate: info.p_eq
      };
    } else {
      gaps[lbl] = { rateDiff: 0, tierDiff: 0, tier: 3, rate: 45 };
    }
  }

  // 找最佳员工（最高等效胜率）
  let bestLbl = null;
  let bestGap = -999;
  for (const lbl of ['A', 'B', 'C']) {
    const g = gaps[lbl].rateDiff;
    if (g > bestGap) { bestGap = g; bestLbl = lbl; }
  }

  // 如果下注，用选中员工；如果 SKIP，用最佳员工作参考
  const evalLbl = (betTarget === 'SKIP') ? (bestLbl || 'A') : betTarget;
  const sel = gaps[evalLbl];

  // 构建显示字符串: "X星-Y星=Z档；M%-N%=±D%；投N或pass"
  function buildDetail(empTier, empRate, bossTierV, bossRateV, gapDiff, rateDiff, stakeStr) {
    const gap = gapDiff >= 0 ? gapDiff : 0;
    const rateD = (rateDiff >= 0 ? '+' : '') + rateDiff.toFixed(0) + '%';
    // 格式: "5-2=3星；50%-40%=+10%；挂5或pass"
    return `${empTier}-${bossTierV}=${gap}星；${empRate.toFixed(0)}%-${bossRateV.toFixed(0)}%=${rateD}；${stakeStr}`;
  }

  // ——— SKIP ———
  if (betTarget === 'SKIP') {
    // 以最佳员工作为参考评估
    const stakeStr = 'pass';
    const d = buildDetail(sel.tier, sel.rate, bossTier, bossRate, sel.tierDiff, sel.rateDiff, stakeStr);
    // 等级差 < 2：pass 理性；等级差 >= 2：pass 保守（放弃了好机会）
    const tag = sel.tierDiff >= 2 ? '保守' : '理性';
    return { tag, detail: d };
  }

  // ——— 下注 ———
  // 推荐注码：gap=2→4, gap=3→8, gap=4→12, gap>=5→16, gap<=1→4
  const recStake = STAKE_FOR_GAP[sel.tierDiff] || (sel.tierDiff >= 4 ? 12 : 4);
  const stakeStr = `投${betAmount}`;
  const d = buildDetail(sel.tier, sel.rate, bossTier, bossRate, sel.tierDiff, sel.rateDiff, stakeStr);

  // 冒进：战力不占优（tier差<=0）还投注
  if (sel.tierDiff <= 0) {
    return { tag: '冒进', detail: d };
  }

  // 注码与战力差的匹配判断
  if (betAmount > recStake) {
    // 小差投大注 → 冒进
    return { tag: '冒进', detail: d };
  }
  if (betAmount < recStake) {
    // 大差投小注 → 保守
    return { tag: '保守', detail: d };
  }

  // 投注匹配战力差 → 理性
  return { tag: '理性', detail: d };
}

function getActionStats() {
  const roundLogs = game.log.filter(e => e.type === 'round');
  const stats = {
    理性: { count: 0, win: 0, betCount: 0, betWin: 0, passCount: 0, passWin: 0 },
    冒进: { count: 0, win: 0, betCount: 0, betWin: 0, passCount: 0, passWin: 0 },
    保守: { count: 0, win: 0, betCount: 0, betWin: 0, passCount: 0, passWin: 0 }
  };

  for (const r of roundLogs) {
    if (!r.actionEval) { console.warn('[actionStats] no actionEval', r); continue; }
    const tag = r.actionEval.tag;
    if (!stats[tag]) { console.warn('[actionStats] unknown tag', tag); continue; }
    stats[tag].count++;
    const isSkip = r.betTarget === 'SKIP';
    console.log(`[actionStats] round=${r.round} tag=${tag} betTarget=${JSON.stringify(r.betTarget)} isSkip=${isSkip} empWinCount=${r.empWinCount} observerPnl=${r.observerPnl}`);
    if (isSkip) {
      stats[tag].passCount++;
      const empWins = r.empWinCount || 0;
      if (empWins <= 1) {
        stats[tag].passWin++;
        stats[tag].win++;
      }
    } else {
      stats[tag].betCount++;
      if (r.observerPnl > 0) {
        stats[tag].betWin++;
        stats[tag].win++;
      }
    }
  }

  return stats;
}

// ═══════════════════════════════════════════════════════
// Session Analysis
// ═══════════════════════════════════════════════════════

function analyzeSession() {
  const roundLogs = game.log.filter(e => e.type === 'round');
  if (roundLogs.length === 0) return null;

  const betRounds = roundLogs.filter(e => e.betTarget !== 'SKIP');
  const skipRounds = roundLogs.filter(e => e.betTarget === 'SKIP');

  // --- Bet win rates ---
  const betWins = betRounds.filter(e => e.observerPnl > 0).length;
  const betWinRate = betRounds.length > 0 ? (betWins / betRounds.length * 100) : 0;

  // --- Win rate by stake amount ---
  const byStake = {};
  for (const r of betRounds) {
    const s = r.betAmount;
    if (!byStake[s]) byStake[s] = { total: 0, wins: 0 };
    byStake[s].total++;
    if (r.observerPnl > 0) byStake[s].wins++;
  }

  // --- Pass rate ---
  const passRate = roundLogs.length > 0 ? (skipRounds.length / roundLogs.length * 100) : 0;

  // --- When PASS: Boss dominance analysis ---
  let passBossAllWin = 0;    // 0 employees won
  let pass1EmpWin = 0;       // 1 employee won
  let pass2EmpWin = 0;       // 2 employees won
  let pass3EmpWin = 0;       // 3 employees won (boss lost all)
  let passEmp10pts = 0;      // employees with >=2x payout (10pts or special)

  for (const r of skipRounds) {
    const ewc = r.empWinCount;
    if (ewc === 0) passBossAllWin++;
    else if (ewc === 1) pass1EmpWin++;
    else if (ewc === 2) pass2EmpWin++;
    else if (ewc === 3) pass3EmpWin++;

    passEmp10pts += (r.empWith10pts || 0);
  }

  // --- Employee overall win rate (ALL rounds, not just when I bet them) ---
  const empOverall = { A: { total: 0, wins: 0 }, B: { total: 0, wins: 0 }, C: { total: 0, wins: 0 } };
  for (const r of roundLogs) {
    for (const lbl of ['A', 'B', 'C']) {
      const er = r.employeeResults[lbl];
      if (er) {
        empOverall[lbl].total++;
        if (er.won) empOverall[lbl].wins++;
      }
    }
  }

  return {
    totalRounds: roundLogs.length,
    betRounds: betRounds.length,
    betWins,
    skipRounds: skipRounds.length,
    betWinRate,
    byStake,
    passRate,
    passBossAllWin,
    pass1EmpWin,
    pass2EmpWin,
    pass3EmpWin,
    passEmp10pts,
    empOverall,
    netPnl: game.obsPurse - INITIAL_PURSE,
    dodgeCorrect: game.stats.dodgeCorrect,
    dodgeTotal: game.stats.dodgeTotal
  };
}