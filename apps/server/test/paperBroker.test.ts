import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Position } from "@signal-lab/shared";
import { liquidationPrice } from "../src/trading/math";
import { PaperBroker } from "../src/trading/paperBroker";

class FakeFeed extends EventEmitter {
  prices = new Map<string, number>([["BTCUSDT", 100]]);
  getPrice(s: string) {
    return this.prices.get(s) ?? null;
  }
  hasSymbol(s: string) {
    return this.prices.has(s);
  }
  set(s: string, p: number) {
    this.prices.set(s, p);
    this.emit("price", s, p);
  }
}

const settings = { initialBalance: 1000, takerFeeRate: 0.0005, makerFeeRate: 0.0002, maintenanceMarginRate: 0.005 };

async function setup() {
  const feed = new FakeFeed();
  const broker = new PaperBroker(feed, settings, mkdtempSync(join(tmpdir(), "paper-")));
  await broker.start();
  return { feed, broker };
}

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("likidasyon fiyatı", () => {
  close(liquidationPrice("LONG", 100, 10, 0.005), 90.5);
  close(liquidationPrice("SHORT", 100, 10, 0.005), 109.5);
});

test("long açma, kâr ve kapatma — ücretler dahil", async () => {
  const { feed, broker } = await setup();
  const pos = (await broker.openPosition({
    symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 100, leverage: 10,
  })) as Position;
  close(pos.quantity, 10);
  let s = (await broker.getState()).summary;
  close(s.walletBalance, 1000 - 0.5); // 1000 notional × %0.05
  close(s.availableBalance, 999.5 - 100);

  feed.set("BTCUSDT", 110);
  s = (await broker.getState()).summary;
  close(s.unrealizedPnl, 100);

  const trade = await broker.closePosition(pos.id);
  assert.ok(trade);
  // brüt 100, kapanış ücreti 1100×0.0005 = 0.55, açılış ücreti 0.5
  close(trade.realizedPnl, 100 - 0.55 - 0.5);
  s = (await broker.getState()).summary;
  close(s.walletBalance, 1000 + trade.realizedPnl);
  assert.equal(s.tradeCount, 1);
  close(s.winRatePct, 100);
  broker.stop();
});

test("yetersiz bakiye reddedilir", async () => {
  const { broker } = await setup();
  await assert.rejects(
    broker.openPosition({ symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 2000, leverage: 2 }),
    /Yetersiz bakiye/,
  );
  broker.stop();
});

test("stop loss tetiklenir", async () => {
  const { feed, broker } = await setup();
  await broker.openPosition({ symbol: "BTCUSDT", side: "SHORT", type: "MARKET", margin: 100, leverage: 5, stopLoss: 105 });
  feed.set("BTCUSDT", 106);
  const state = await broker.getState();
  assert.equal(state.positions.length, 0);
  const [trade] = await broker.getTrades();
  assert.equal(trade.reason, "STOP_LOSS");
  assert.ok(trade.realizedPnl < 0);
  broker.stop();
});

test("likidasyonda kayıp teminatla sınırlı", async () => {
  const { feed, broker } = await setup();
  await broker.openPosition({ symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 100, leverage: 20 });
  feed.set("BTCUSDT", 50);
  const [trade] = await broker.getTrades();
  assert.equal(trade.reason, "LIQUIDATION");
  close(trade.realizedPnl, -100 - 1); // teminat + açılış ücreti (2000×0.0005)
  broker.stop();
});

test("limit emir fiyat gelince dolar, kısmi kapatma", async () => {
  const { feed, broker } = await setup();
  const order = await broker.openPosition({
    symbol: "BTCUSDT", side: "LONG", type: "LIMIT", limitPrice: 95, margin: 100, leverage: 10,
  });
  assert.equal((await broker.getState()).orders.length, 1);
  close((await broker.getState()).summary.orderMargin, 100);
  feed.set("BTCUSDT", 94.9);
  const state = await broker.getState();
  assert.equal(state.orders.length, 0);
  assert.equal(state.positions.length, 1);
  close(state.positions[0].entryPrice, 95);
  assert.notEqual(state.positions[0].id, order.id);

  await broker.closePosition(state.positions[0].id, 50);
  const after = await broker.getState();
  close(after.positions[0].margin, 50);
  broker.stop();
});

test("geçersiz SL reddedilir", async () => {
  const { broker } = await setup();
  await assert.rejects(
    broker.openPosition({ symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 100, leverage: 10, stopLoss: 120 }),
    /Stop loss/,
  );
  broker.stop();
});

test("otomatik başa baş: 1R kârda SL tam girişe taşınır", async () => {
  const { feed, broker } = await setup();
  await broker.openPosition({
    symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 100, leverage: 5, stopLoss: 95, takeProfit: 110, breakevenAtR: 1,
  });
  feed.set("BTCUSDT", 103);
  let [p] = (await broker.getState()).positions;
  assert.equal(p.stopLoss, 95);
  feed.set("BTCUSDT", 105.1);
  [p] = (await broker.getState()).positions;
  assert.equal(p.stopLoss, 100, "stop tam girişe taşınmalı (backtest ile aynı)");
  feed.set("BTCUSDT", 99.9);
  const [trade] = await broker.getTrades();
  assert.equal(trade.reason, "STOP_LOSS");
  assert.ok(trade.realizedPnl < 0, "başa baş çıkış ücretler nedeniyle hafif eksi");
  broker.stop();
});

test("akıllı giriş emri: süresi dolunca ya da fiyat hedefe kaçınca iptal", async () => {
  const { feed, broker } = await setup();
  await broker.openPosition({
    symbol: "BTCUSDT", side: "LONG", type: "LIMIT", limitPrice: 99, margin: 10, leverage: 5,
    stopLoss: 97, takeProfit: 104, cancelIfPriceReaches: 104, expiresAt: Date.now() + 3_600_000,
  });
  assert.equal((await broker.getState()).orders.length, 1);
  feed.set("BTCUSDT", 104.2); // dolmadan hedefe kaçtı
  assert.equal((await broker.getState()).orders.length, 0);
  assert.equal((await broker.getState()).positions.length, 0);

  await broker.openPosition({
    symbol: "BTCUSDT", side: "LONG", type: "LIMIT", limitPrice: 99, margin: 10, leverage: 5,
    stopLoss: 97, takeProfit: 106, expiresAt: Date.now() - 1,
  });
  feed.set("BTCUSDT", 104.5); // herhangi bir fiyat güncellemesi süresi dolanı temizler
  assert.equal((await broker.getState()).orders.length, 0);

  await broker.openPosition({
    symbol: "BTCUSDT", side: "LONG", type: "LIMIT", limitPrice: 103, margin: 10, leverage: 5,
    stopLoss: 101, takeProfit: 108, cancelIfPriceReaches: 108, expiresAt: Date.now() + 3_600_000, breakevenAtR: 1,
  });
  feed.set("BTCUSDT", 102.9); // doldu
  const st = await broker.getState();
  assert.equal(st.orders.length, 0);
  assert.equal(st.positions.length, 1);
  assert.equal(st.positions[0].entryPrice, 103);
  broker.stop();
});

test("zaman stopu: süre dolunca pozisyon piyasa fiyatından kapanır", async () => {
  const { feed, broker } = await setup();
  await broker.openPosition({ symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 10, leverage: 5, stopLoss: 95, takeProfit: 110, maxHoldMs: 1 });
  const [p] = (await broker.getState()).positions;
  assert.ok(p.closeAt && p.closeAt <= Date.now() + 1);
  await new Promise((r) => setTimeout(r, 5));
  feed.set("BTCUSDT", 101);
  assert.equal((await broker.getState()).positions.length, 0);
  const [t] = await broker.getTrades();
  assert.equal(t.reason, "TIME_STOP");
  broker.stop();
});

test("Binance minimum emir büyüklüğü kâğıt hesapta da uygulanır", async () => {
  const { broker } = await setup();
  // BTC benzeri kural: en az 0.001 adet → 100 fiyatta değil ama 84.000 fiyatında 84 USDT eder
  broker.setFilters(new Map([["BTCUSDT", { symbol: "BTCUSDT", tickSize: 0.1, stepSize: 0.001, minQty: 1, minNotional: 50, pricePrecision: 1, quantityPrecision: 3 }]]));
  await assert.rejects(
    broker.openPosition({ symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 10, leverage: 5 }),
    /minimum emir büyüklüğü 100\.00 USDT/,
  );
  await broker.openPosition({ symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 25, leverage: 5 });
  assert.equal((await broker.getState()).positions.length, 1);
  broker.stop();
});

test("kaldıraç sınırı: en fazla 5x", async () => {
  const feed = new FakeFeed();
  const broker = new PaperBroker(feed, { ...settings, maxLeverage: 5 }, mkdtempSync(join(tmpdir(), "paper-")));
  await broker.start();
  await assert.rejects(broker.openPosition({ symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 10, leverage: 10 }), /1-5 arasında/);
  await broker.openPosition({ symbol: "BTCUSDT", side: "LONG", type: "MARKET", margin: 10, leverage: 5 });
  broker.stop();
});
