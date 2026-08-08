// ============================================================================
// GAMMA X — EPM TERMINAL BACKEND
// Expected Premium Move engine: Black-Scholes Greeks (1st + 2nd order),
// dealer gamma regime, OI-wall flow, and a composite EPM score per strike.
// Standalone service — does NOT touch your existing finalultimate01 backend.
// ============================================================================

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const speakeasy = require("speakeasy");
const webpush = require("web-push");
require("dotenv").config();

// Crash-proofing: a stray broker/network error must never take the whole
// process down (that's what turns into a Render 502 for every user until
// the service auto-restarts). Log it, keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason && reason.message ? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.message ? err.message : err);
});

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const HTTP_TIMEOUT = 15000; // every outbound broker call gets a hard timeout so a hung request can't hang the whole server

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const API_KEY = process.env.API_KEY;
const CLIENT_CODE = process.env.CLIENT_CODE;
const PIN = process.env.PIN; // MPIN
const TOTP_SECRET = process.env.TOTP_SECRET;

const RISK_FREE_RATE = 0.065; // India 91-day T-bill approx, edit as needed
const EXPECTED_IV_DRIFT = 0.5; // vol points assumed possible IV change into close (tunable)
const OI_WALL_LOOKBACK = 5; // strikes each side used to judge "wall" concentration

let sessionTokens = { jwtToken: null, feedToken: null, refreshToken: null, loginTime: 0 };

// Symbol -> NSE token map for indices (extend as needed)
const INDEX_TOKENS = {
  NIFTY: { token: "99926000", exchange: "NSE", lotSize: 75 },
  BANKNIFTY: { token: "99926009", exchange: "NSE", lotSize: 30 },
  SENSEX: { token: "99919000", exchange: "BSE", lotSize: 20 },
};

// In-memory OI history so we can compute "fresh writing" vs "unwinding" (COI)
// keyed by `${symbol}_${strike}_${type}` -> { prevOI, dayOpenOI }
const oiHistory = {};

// ----------------------------------------------------------------------------
// ANGEL ONE SMARTAPI — AUTO TOTP LOGIN
// ----------------------------------------------------------------------------
async function angelLogin() {
  const totp = speakeasy.totp({ secret: TOTP_SECRET, encoding: "base32" });
  const res = await axios.post(
    "https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword",
    { clientcode: CLIENT_CODE, password: PIN, totp },
    {
      timeout: HTTP_TIMEOUT,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": API_KEY,
      },
    }
  );
  const d = res.data.data;
  sessionTokens = {
    jwtToken: d.jwtToken,
    feedToken: d.feedToken,
    refreshToken: d.refreshToken,
    loginTime: Date.now(),
  };
  console.log("[auth] Angel One login OK", new Date().toISOString());
  return sessionTokens;
}

async function ensureSession() {
  const stale = Date.now() - sessionTokens.loginTime > 1000 * 60 * 60 * 7; // ~7h
  if (!sessionTokens.jwtToken || stale) await angelLogin();
  return sessionTokens;
}

function angelHeaders(jwt) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": API_KEY,
    Authorization: `Bearer ${jwt}`,
  };
}

// Fetch LTP for a single token via Angel quote API
async function fetchLTP(exchange, tradingsymbol, symboltoken) {
  const { jwtToken } = await ensureSession();
  const res = await axios.post(
    "https://apiconnect.angelbroking.com/rest/secure/angelbroking/order/v1/getLtpData",
    { exchange, tradingsymbol, symboltoken },
    { headers: angelHeaders(jwtToken) }
  );
  return res.data.data;
}

// Fetch full option chain OI/LTP snapshot. Uses Angel's market-data / option-greek
// endpoint plus scrip-master lookups. Swap this for whatever token-resolution
// approach your existing finalultimate01 backend already uses if you'd rather
// share that logic — this is a self-contained version.
async function fetchOptionChainRaw(symbol, expiry) {
  const { jwtToken } = await ensureSession();
  const res = await axios.get(
    `https://apiconnect.angelbroking.com/rest/secure/angelbroking/marketData/v1/optionGreek`,
    {
      timeout: HTTP_TIMEOUT,
      headers: angelHeaders(jwtToken),
      params: { name: symbol, expirydate: expiry },
    }
  );
  return res.data.data || [];
}

// ----------------------------------------------------------------------------
// AUTO EXPIRY DETECTION — via Angel One's public scrip master, so nobody has
// to type an expiry date by hand. Cached in memory for a few hours since the
// file is a few MB and doesn't change intraday.
// ----------------------------------------------------------------------------
const SCRIP_MASTER_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";
let scripMasterCache = { data: null, fetchedAt: 0 };
const SCRIP_MASTER_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function getScripMaster() {
  const fresh = Date.now() - scripMasterCache.fetchedAt < SCRIP_MASTER_TTL_MS;
  if (scripMasterCache.data && fresh) return scripMasterCache.data;
  const res = await axios.get(SCRIP_MASTER_URL, { timeout: 25000 });
  scripMasterCache = { data: res.data, fetchedAt: Date.now() };
  return scripMasterCache.data;
}

async function getExpiryList(symbol) {
  const master = await getScripMaster();
  const now = new Date();
  const seen = new Set();
  const upcoming = [];
  for (const item of master) {
    if (item.exch_seg !== "NFO") continue;
    if (item.instrumenttype !== "OPTIDX") continue;
    if (item.name !== symbol) continue;
    if (!item.expiry || seen.has(item.expiry)) continue;
    const d = parseExpiry(item.expiry);
    if (isNaN(d.getTime()) || d < now) continue;
    seen.add(item.expiry);
    upcoming.push({ expiry: item.expiry, date: d });
  }
  upcoming.sort((a, b) => a.date - b.date);
  return upcoming.map((u) => u.expiry);
}

async function resolveExpiry(symbol, requestedExpiry) {
  if (requestedExpiry) return requestedExpiry;
  const list = await getExpiryList(symbol);
  if (!list.length) throw new Error(`No upcoming expiries found for ${symbol} in broker scrip master`);
  return list[0];
}

// ----------------------------------------------------------------------------
// BLACK-SCHOLES: 1st + 2nd ORDER GREEKS, IV INVERSION
// ----------------------------------------------------------------------------
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normCDF(x) { return 0.5 * (1 + erf(x / Math.sqrt(2))); }
function normPDF(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

function bsGreeks({ spot, strike, T, r, sigma, type }) {
  if (T <= 0 || sigma <= 0) {
    return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, vanna: 0, charm: 0, vomma: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const isCall = type === "CE";

  const Nd1 = normCDF(d1), Nd2 = normCDF(d2);
  const Nmd1 = normCDF(-d1), Nmd2 = normCDF(-d2);
  const nd1 = normPDF(d1);

  const price = isCall
    ? spot * Nd1 - strike * Math.exp(-r * T) * Nd2
    : strike * Math.exp(-r * T) * Nmd2 - spot * Nmd1;

  const delta = isCall ? Nd1 : Nd1 - 1;
  const gamma = nd1 / (spot * sigma * sqrtT);
  const vega = (spot * nd1 * sqrtT) / 100; // per 1 vol point
  const theta =
    (isCall
      ? -((spot * nd1 * sigma) / (2 * sqrtT)) - r * strike * Math.exp(-r * T) * Nd2
      : -((spot * nd1 * sigma) / (2 * sqrtT)) + r * strike * Math.exp(-r * T) * Nmd2) / 365;

  // second-order: vanna = dDelta/dVol = dVega/dSpot
  const vanna = (-nd1 * d2) / sigma;
  // charm = dDelta/dTime
  const charm =
    (isCall ? -1 : 1) *
    (nd1 * ((2 * (r) * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT))) / 365;
  // vomma = dVega/dVol
  const vomma = (vega * d1 * d2) / sigma;

  return { price, delta, gamma, theta, vega, vanna, charm, vomma };
}

// Newton-Raphson IV solve from observed premium
function impliedVol({ price, spot, strike, T, r, type }) {
  if (T <= 0 || price <= 0) return 0.01;
  let sigma = 0.3;
  for (let i = 0; i < 50; i++) {
    const g = bsGreeks({ spot, strike, T, r, sigma, type });
    const diff = g.price - price;
    const vega100 = g.vega * 100; // undo /100 scaling for Newton step
    if (Math.abs(vega100) < 1e-6) break;
    sigma -= diff / vega100;
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 5) sigma = 5;
    if (Math.abs(diff) < 1e-4) break;
  }
  return sigma;
}

// ----------------------------------------------------------------------------
// EPM — EXPECTED PREMIUM MOVE
// ----------------------------------------------------------------------------
function computeEPM({ greeks, sigma, spot, T, timeElapsedFraction, coi, oi, wallFactor, gammaRegimeFactor }) {
  const expectedSpotMove = spot * sigma * Math.sqrt(Math.max(T, 1 / (365 * 24))); // implied move formula
  const gammaTerm = 0.5 * greeks.gamma * expectedSpotMove * expectedSpotMove;
  const deltaTerm = Math.abs(greeks.delta) * expectedSpotMove;
  const thetaTerm = Math.abs(greeks.theta) * timeElapsedFraction * 365; // theta already /day
  const vegaTerm = greeks.vega * EXPECTED_IV_DRIFT;

  let raw = deltaTerm + gammaTerm - thetaTerm + vegaTerm;
  if (raw < 0) raw = Math.abs(raw) * 0.4; // decayed but can still whip on gamma

  const epm = raw * gammaRegimeFactor * wallFactor;
  return { epm: Math.max(epm, 0), expectedSpotMove, deltaTerm, gammaTerm, thetaTerm, vegaTerm };
}

// OI wall factor: fresh writing at a strike suppresses movement through it,
// unwinding (short covering) lets price move through it more easily.
function oiWallFactor(coi, oi, avgOiNeighborhood) {
  if (!oi || oi <= 0) return 1;
  const concentration = oi / Math.max(avgOiNeighborhood, 1);
  const writingPressure = coi > 0 ? Math.min(coi / Math.max(oi, 1), 1) : 0;
  const unwindingPressure = coi < 0 ? Math.min(Math.abs(coi) / Math.max(oi, 1), 1) : 0;

  let factor = 1;
  if (concentration > 1.5) {
    // this strike is a real wall
    factor -= writingPressure * 0.4; // fresh writing damps EPM (resistance/support holds)
    factor += unwindingPressure * 0.5; // unwinding amplifies EPM (wall breaking)
  }
  return Math.max(0.3, Math.min(factor, 1.8));
}

// Dealer gamma regime: negative net dealer gamma = dealers short gamma =
// hedging flow amplifies price moves (trend). Positive = dampens (mean revert).
function gammaRegimeFactor(netGEX) {
  if (netGEX < 0) return 1 + Math.min(Math.abs(netGEX) / 5e11, 0.5); // amplify up to 1.5x
  return 1 - Math.min(netGEX / 5e11, 0.35); // dampen down to 0.65x
}

// ----------------------------------------------------------------------------
// MAIN ENDPOINT: /epm-chain?symbol=NIFTY&expiry=11AUG2026
// ----------------------------------------------------------------------------
// GET /expiries?symbol=NIFTY — list of upcoming expiries, nearest first, so
// the frontend never has to ask a human to type one.
app.get("/expiries", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "NIFTY").toUpperCase();
    if (!INDEX_TOKENS[symbol]) return res.status(400).json({ error: `unknown symbol ${symbol}` });
    const list = await getExpiryList(symbol);
    res.json({ symbol, expiries: list, nearest: list[0] || null });
  } catch (err) {
    console.error("[expiries] error", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/epm-chain", async (req, res) => {
  try {
    const symbol = (req.query.symbol || "NIFTY").toUpperCase();
    const idxMeta = INDEX_TOKENS[symbol];
    if (!idxMeta) return res.status(400).json({ error: `unknown symbol ${symbol}` });

    // expiry is now optional — auto-resolved to the nearest upcoming one via
    // the broker's scrip master if the caller doesn't pass it explicitly.
    const expiry = await resolveExpiry(symbol, req.query.expiry);

    const chainRaw = await fetchOptionChainRaw(symbol, expiry);
    if (!chainRaw.length) return res.status(502).json({ error: "empty chain from broker" });

    const spot = parseFloat(chainRaw[0].underlyingValue || chainRaw[0].spot || 0);
    const now = new Date();
    const expiryDate = parseExpiry(expiry);
    const T = Math.max((expiryDate - now) / (1000 * 60 * 60 * 24 * 365), 1e-6);
    const marketOpen = new Date(now); marketOpen.setHours(9, 15, 0, 0);
    const marketClose = new Date(now); marketClose.setHours(15, 30, 0, 0);
    const timeElapsedFraction = Math.min(
      Math.max((now - marketOpen) / (marketClose - marketOpen), 0),
      1
    );

    // Build per-strike rows for CE and PE, compute Greeks + IV
    const rows = chainRaw.map((row) => {
      const strike = parseFloat(row.strikePrice);
      const type = row.optionType === "PE" ? "PE" : "CE";
      const ltp = parseFloat(row.ltp || row.close || 0);
      const oi = parseFloat(row.opnInterest || row.oi || 0);
      const key = `${symbol}_${strike}_${type}`;
      const prevOI = oiHistory[key] ? oiHistory[key].dayOpenOI : oi;
      if (!oiHistory[key]) oiHistory[key] = { dayOpenOI: oi };
      const coi = oi - prevOI;

      const sigma = impliedVol({ price: ltp, spot, strike, T, r: RISK_FREE_RATE, type });
      const greeks = bsGreeks({ spot, strike, T, r: RISK_FREE_RATE, sigma, type });

      return { strike, type, ltp, oi, coi, sigma, greeks };
    });

    // net dealer GEX (SqueezeMetrics convention: dealers assumed net short calls, short puts)
    const netGEX = rows.reduce((sum, r) => {
      const sign = r.type === "CE" ? -1 : 1; // dealer short calls -> negative gamma contribution; short puts -> positive
      return sum + sign * r.oi * r.greeks.gamma * spot * spot * 0.01;
    }, 0);
    const gRegime = gammaRegimeFactor(netGEX);

    const strikesSorted = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
    const avgOiByStrike = {};
    strikesSorted.forEach((s, i) => {
      const nb = strikesSorted.slice(Math.max(0, i - OI_WALL_LOOKBACK), i + OI_WALL_LOOKBACK + 1);
      const strikeRows = rows.filter((r) => nb.includes(r.strike));
      avgOiByStrike[s] = strikeRows.reduce((a, r) => a + r.oi, 0) / Math.max(strikeRows.length, 1);
    });

    const enriched = rows.map((r) => {
      const wFactor = oiWallFactor(r.coi, r.oi, avgOiByStrike[r.strike]);
      const { epm, expectedSpotMove, deltaTerm, gammaTerm, thetaTerm, vegaTerm } = computeEPM({
        greeks: r.greeks,
        sigma: r.sigma,
        spot,
        T,
        timeElapsedFraction,
        coi: r.coi,
        oi: r.oi,
        wallFactor: wFactor,
        gammaRegimeFactor: gRegime,
      });
      return {
        strike: r.strike,
        type: r.type,
        ltp: round(r.ltp, 2),
        oi: r.oi,
        coi: r.coi,
        iv: round(r.sigma * 100, 2),
        delta: round(r.greeks.delta, 4),
        gamma: round(r.greeks.gamma, 6),
        theta: round(r.greeks.theta, 2),
        vega: round(r.greeks.vega, 3),
        vanna: round(r.greeks.vanna, 5),
        charm: round(r.greeks.charm, 5),
        vomma: round(r.greeks.vomma, 3),
        epm: round(epm, 2),
        wallFactor: round(wFactor, 3),
        breakdown: {
          expectedSpotMove: round(expectedSpotMove, 2),
          deltaTerm: round(deltaTerm, 2),
          gammaTerm: round(gammaTerm, 2),
          thetaTerm: round(thetaTerm, 2),
          vegaTerm: round(vegaTerm, 2),
        },
      };
    });

    // Call/Put OI walls (top concentration + top fresh writing)
    const calls = enriched.filter((r) => r.type === "CE");
    const puts = enriched.filter((r) => r.type === "PE");
    const callWall = [...calls].sort((a, b) => b.oi - a.oi)[0];
    const putWall = [...puts].sort((a, b) => b.oi - a.oi)[0];

    res.json({
      symbol,
      expiry,
      spot,
      netGEX: round(netGEX, 0),
      dealerRegime: netGEX < 0 ? "SHORT_GAMMA_AMPLIFYING" : "LONG_GAMMA_DAMPENING",
      gammaRegimeFactor: round(gRegime, 3),
      callWallStrike: callWall ? callWall.strike : null,
      putWallStrike: putWall ? putWall.strike : null,
      timestamp: now.toISOString(),
      chain: enriched.sort((a, b) => a.strike - b.strike),
    });
  } catch (err) {
    console.error("[epm-chain] error", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "ok", service: "gamma-x-epm-backend", health: "/health", chain: "/epm-chain?symbol=NIFTY", expiries: "/expiries?symbol=NIFTY" }));
app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// VAPID push (matches pattern of your other terminals)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:you@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}
app.get("/vapid-public-key", (req, res) => res.json({ key: process.env.VAPID_PUBLIC_KEY || "" }));

let subscriptions = [];
app.post("/subscribe", (req, res) => {
  subscriptions.push(req.body);
  res.status(201).json({});
});

// ----------------------------------------------------------------------------
// UTILS
// ----------------------------------------------------------------------------
function round(n, d) { const p = Math.pow(10, d); return Math.round((n + Number.EPSILON) * p) / p; }
function parseExpiry(str) {
  // expects DDMMMYYYY e.g. 11AUG2026
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const dd = parseInt(str.slice(0, 2), 10);
  const mmm = str.slice(2, 5).toUpperCase();
  const yyyy = parseInt(str.slice(5), 10);
  const d = new Date(yyyy, months[mmm], dd, 15, 30, 0);
  return d;
}

app.listen(PORT, () => console.log(`EPM Terminal backend listening on :${PORT}`));
